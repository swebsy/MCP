import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { ArtifactReceiver, resolveArtifactPath } from "./artifacts.ts";

describe("resolveArtifactPath", () => {
  const base = "/work/.swebsy-agent";

  it("accepts nested relative paths under the kind dir", () => {
    const p = resolveArtifactPath(base, "screenshots", "s1/2026/mobile.png");
    expect(p).toBe(path.join(base, "screenshots", "s1/2026/mobile.png"));
  });

  it.each([
    ["absolute", "/etc/passwd"],
    ["traversal", "../../etc/passwd"],
    ["nested traversal", "a/../../b"],
    ["empty", "   "],
    ["backslash", "a\\b.png"],
    ["drive", "C:/x.png"],
  ])("rejects %s", (_label, filename) => {
    expect(() => resolveArtifactPath(base, "exports", filename)).toThrow();
  });

  it("rejects an unknown kind", () => {
    expect(() => resolveArtifactPath(base, "secrets", "a.png")).toThrow();
  });
});

describe("ArtifactReceiver", () => {
  let base: string;
  let rcv: ArtifactReceiver;

  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), "swebsy-artifacts-"));
    rcv = new ArtifactReceiver({ base, maxBytes: 1024 });
  });

  afterEach(() => rmSync(base, { recursive: true, force: true }));

  function feed(
    id: string,
    filename: string,
    data: Buffer,
    opts: { sha256?: string; chunkSize?: number; kind?: string } = {}
  ): void {
    const chunkSize = opts.chunkSize ?? 8;
    rcv.handleFrame({
      type: "artifact_begin",
      id,
      kind: opts.kind ?? "screenshots",
      filename,
      totalBytes: data.length,
      sha256: opts.sha256,
    });
    let seq = 0;
    for (let i = 0; i < data.length; i += chunkSize) {
      rcv.handleFrame({
        type: "artifact_chunk",
        id,
        seq: seq++,
        base64: data.subarray(i, i + chunkSize).toString("base64"),
      });
    }
    rcv.handleFrame({ type: "artifact_commit", id });
  }

  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

  it("reassembles chunks and writes the file atomically", async () => {
    const data = Buffer.from("hello styled screenshot bytes 12345", "utf8");
    feed("a1", "s1/2026/mobile.png", data);
    const dest = await rcv.result("a1");
    expect(dest).toBe(path.join(base, "screenshots", "s1/2026/mobile.png"));
    expect(readFileSync(dest)).toEqual(data);
  });

  it("verifies a matching checksum", async () => {
    const data = Buffer.from("checksum me", "utf8");
    feed("a2", "x.png", data, { sha256: sha(data) });
    await expect(rcv.result("a2")).resolves.toContain("x.png");
  });

  it("aborts on a checksum mismatch", async () => {
    const data = Buffer.from("tampered", "utf8");
    feed("a3", "x.png", data, { sha256: "deadbeef" });
    await expect(rcv.result("a3")).rejects.toMatchObject({
      code: "artifact_failed",
    });
  });

  it("rejects a begin over the size cap", async () => {
    rcv.handleFrame({
      type: "artifact_begin",
      id: "big",
      kind: "exports",
      filename: "big.bin",
      totalBytes: 2048, // > maxBytes 1024
    });
    await expect(rcv.result("big")).rejects.toMatchObject({
      code: "artifact_failed",
    });
  });

  it("fails on a size mismatch at commit", async () => {
    rcv.handleFrame({
      type: "artifact_begin",
      id: "m",
      kind: "exports",
      filename: "m.bin",
      totalBytes: 10,
    });
    rcv.handleFrame({
      type: "artifact_chunk",
      id: "m",
      seq: 0,
      base64: Buffer.from("ab").toString("base64"),
    });
    rcv.handleFrame({ type: "artifact_commit", id: "m" });
    await expect(rcv.result("m")).rejects.toMatchObject({
      code: "artifact_failed",
    });
  });

  it("fails on an out-of-order chunk", async () => {
    const data = Buffer.from("0123456789abcdef", "utf8");
    rcv.handleFrame({
      type: "artifact_begin",
      id: "o",
      kind: "exports",
      filename: "o.bin",
      totalBytes: data.length,
    });
    rcv.handleFrame({
      type: "artifact_chunk",
      id: "o",
      seq: 0,
      base64: "AA==",
    });
    rcv.handleFrame({
      type: "artifact_chunk",
      id: "o",
      seq: 5,
      base64: "AA==",
    });
    await expect(rcv.result("o")).rejects.toMatchObject({
      code: "artifact_failed",
    });
  });

  it("GCs an in-flight stream on dispose", async () => {
    rcv.handleFrame({
      type: "artifact_begin",
      id: "p",
      kind: "exports",
      filename: "p.bin",
      totalBytes: 100,
    });
    const pending = rcv.result("p");
    rcv.dispose();
    await expect(pending).rejects.toMatchObject({ code: "not_connected" });
  });

  it("rejects result() for an unknown id", async () => {
    await expect(rcv.result("nope")).rejects.toMatchObject({
      code: "artifact_failed",
    });
  });
});
