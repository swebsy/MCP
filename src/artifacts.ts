/**
 * artifacts.ts — receive screenshots/exports from the tab as chunked byte
 * streams and write them to disk atomically.
 *
 * Bytes never travel whole (fonts/images blow past single-message limits):
 *   artifact_begin { id, kind, filename, totalBytes, sha256? }
 *   artifact_chunk { id, seq, base64 }      (in order)
 *   artifact_commit { id }   → verify size (+ sha256), write temp + rename, done
 *   artifact_abort  { id }   → discard
 *
 * Safety: kind is allowlisted; filenames are sanitized to safe relative paths
 * under the artifact dir (no absolute, `..`, empty, backslash, or drive); a
 * per-artifact byte cap aborts oversized streams. Files land under
 * <root>/{screenshots,exports}/… where <root> is the pnpm workspace's
 * `.swebsy-agent/` (or SWEBSY_AGENT_DIR). Callers await `result(id)` for the
 * absolute path; a session drop GC's everything still in flight.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { BridgeError } from "./errors.ts";

const DEFAULT_MAX_ARTIFACT_BYTES = 50 * 1024 * 1024; // 50 MB per artifact
const ARTIFACT_KINDS = new Set(["screenshots", "exports"]);

/** Resolve <root> for `.swebsy-agent/`: SWEBSY_AGENT_DIR, else workspace root. */
export function artifactBaseDir(): string {
  const override = process.env.SWEBSY_AGENT_DIR;
  if (override) return path.resolve(override);
  let dir = process.cwd();
  for (;;) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
      return path.join(dir, ".swebsy-agent");
    }
    const parent = path.dirname(dir);
    if (parent === dir) return path.join(process.cwd(), ".swebsy-agent");
    dir = parent;
  }
}

/**
 * Sanitize `kind`/`filename` into an absolute destination strictly under
 * `<base>/<kind>`. Rejects absolute paths, `..` segments, empty names, Windows
 * separators, and drive letters. Nested relative paths are allowed.
 */
export function resolveArtifactPath(
  base: string,
  kind: string,
  filename: string
): string {
  if (!ARTIFACT_KINDS.has(kind)) {
    throw new BridgeError("artifact_failed", `Unknown artifact kind: ${kind}`);
  }
  if (typeof filename !== "string" || filename.trim() === "") {
    throw new BridgeError("artifact_failed", "Empty artifact filename.");
  }
  if (filename.includes("\\") || /^[a-zA-Z]:/.test(filename)) {
    throw new BridgeError(
      "artifact_failed",
      `Windows-style path not allowed: ${filename}`
    );
  }
  if (path.isAbsolute(filename)) {
    throw new BridgeError(
      "artifact_failed",
      `Absolute path not allowed: ${filename}`
    );
  }
  if (filename.split("/").some((seg) => seg === "..")) {
    throw new BridgeError(
      "artifact_failed",
      `Path traversal not allowed: ${filename}`
    );
  }
  const kindDir = path.join(base, kind);
  const dest = path.resolve(kindDir, filename);
  const rel = path.relative(kindDir, dest);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new BridgeError(
      "artifact_failed",
      `Path escapes artifact dir: ${filename}`
    );
  }
  return dest;
}

interface Active {
  dest: string;
  totalBytes: number;
  sha256?: string;
  chunks: Buffer[];
  received: number;
  nextSeq: number;
  resolve: (absPath: string) => void;
  reject: (err: BridgeError) => void;
}

export interface ArtifactReceiverOptions {
  base?: string;
  maxBytes?: number;
}

export class ArtifactReceiver {
  private readonly base: string;
  private readonly maxBytes: number;
  private readonly active = new Map<string, Active>();
  private readonly promises = new Map<string, Promise<string>>();

  constructor(opts: ArtifactReceiverOptions = {}) {
    this.base = opts.base ?? artifactBaseDir();
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
  }

  /** The awaitable committed path for an artifact id. */
  result(id: string): Promise<string> {
    const p = this.promises.get(id);
    if (!p) {
      return Promise.reject(
        new BridgeError("artifact_failed", `Unknown artifact id: ${id}`)
      );
    }
    return p;
  }

  /** Feed one wire frame. Non-artifact frames are ignored. */
  handleFrame(frame: unknown): void {
    if (typeof frame !== "object" || frame === null) return;
    const f = frame as Record<string, unknown>;
    switch (f.type) {
      case "artifact_begin":
        this.begin(f);
        break;
      case "artifact_chunk":
        this.chunk(f);
        break;
      case "artifact_commit":
        void this.commit(String(f.id));
        break;
      case "artifact_abort":
        this.abort(String(f.id), String(f.reason ?? "aborted"));
        break;
    }
  }

  /** Drop everything in flight (session ended). Nothing was written yet. */
  dispose(): void {
    for (const [, a] of this.active) {
      a.reject(new BridgeError("not_connected", "Session ended mid-artifact."));
    }
    this.active.clear();
  }

  private begin(f: Record<string, unknown>): void {
    const id = String(f.id);
    let dest: string;
    try {
      dest = resolveArtifactPath(this.base, String(f.kind), String(f.filename));
    } catch (err) {
      this.settle(id, undefined, err as BridgeError);
      return;
    }
    const totalBytes = Number(f.totalBytes);
    if (!Number.isInteger(totalBytes) || totalBytes < 0) {
      this.settle(
        id,
        undefined,
        new BridgeError("artifact_failed", "Invalid totalBytes.")
      );
      return;
    }
    if (totalBytes > this.maxBytes) {
      this.settle(
        id,
        undefined,
        new BridgeError(
          "artifact_failed",
          `Artifact too large: ${totalBytes} > ${this.maxBytes} bytes.`
        )
      );
      return;
    }
    let resolve!: (p: string) => void;
    let reject!: (e: BridgeError) => void;
    const promise = new Promise<string>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    promise.catch(() => {}); // keep result(id) the sole visible rejection
    this.promises.set(id, promise);
    this.active.set(id, {
      dest,
      totalBytes,
      sha256: typeof f.sha256 === "string" ? f.sha256 : undefined,
      chunks: [],
      received: 0,
      nextSeq: 0,
      resolve,
      reject,
    });
  }

  private chunk(f: Record<string, unknown>): void {
    const id = String(f.id);
    const a = this.active.get(id);
    if (!a) return; // stale / already settled
    if (Number(f.seq) !== a.nextSeq) {
      this.fail(
        id,
        a,
        `Out-of-order chunk: expected ${a.nextSeq}, got ${f.seq}.`
      );
      return;
    }
    a.nextSeq += 1;
    const buf = Buffer.from(String(f.base64), "base64");
    a.received += buf.length;
    if (a.received > a.totalBytes) {
      this.fail(id, a, "Received more bytes than declared.");
      return;
    }
    if (a.received > this.maxBytes) {
      this.fail(id, a, "Artifact exceeded size cap.");
      return;
    }
    a.chunks.push(buf);
  }

  private async commit(id: string): Promise<void> {
    const a = this.active.get(id);
    if (!a) return;
    if (a.received !== a.totalBytes) {
      this.fail(id, a, `Size mismatch: ${a.received} != ${a.totalBytes}.`);
      return;
    }
    const data = Buffer.concat(a.chunks);
    if (a.sha256) {
      const digest = createHash("sha256").update(data).digest("hex");
      if (digest !== a.sha256) {
        this.fail(id, a, "Checksum mismatch.");
        return;
      }
    }
    const tmp = `${a.dest}.${id}.part`;
    try {
      await mkdir(path.dirname(a.dest), { recursive: true });
      await writeFile(tmp, data);
      await rename(tmp, a.dest); // atomic within the dir
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      this.fail(id, a, `Write failed: ${(err as Error).message}`);
      return;
    }
    this.active.delete(id);
    a.resolve(a.dest);
  }

  private abort(id: string, reason: string): void {
    const a = this.active.get(id);
    if (!a) return;
    this.fail(id, a, `Aborted: ${reason}`);
  }

  private fail(id: string, a: Active, message: string): void {
    this.active.delete(id);
    a.reject(new BridgeError("artifact_failed", message));
  }

  // Settle an id that never became active (begin rejected before setup).
  private settle(id: string, okPath?: string, err?: BridgeError): void {
    const promise =
      err !== undefined
        ? Promise.reject<string>(err)
        : Promise.resolve(okPath as string);
    promise.catch(() => {});
    this.promises.set(id, promise);
  }
}
