#!/usr/bin/env node
/**
 * server.ts — the MCP stdio entrypoint.
 *
 * Lists the drift-proof tool surface (toolRegistry) and dispatches each call:
 *   • start_pairing / status  → handled locally against the relay
 *   • everything else         → relayed to the paired Studio tab, serialized,
 *                               with a per-command timeout (long for capture/export)
 *
 * Binds the relay on startup; an in-use port fails fast (process exits nonzero),
 * no silent fallback.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { pathToFileURL } from "node:url";
import { readFileSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import { spawn } from "node:child_process";
import { runBroker } from "./broker.ts";
import { runSetup } from "./setup.ts";
import { BrokerClient } from "./brokerClient.ts";
import { BridgeError } from "./errors.ts";
import { buildMcpTools, toWireName } from "./toolRegistry.ts";
import { ArtifactReceiver } from "./artifacts.ts";
import type { RelayApi } from "./protocol.ts";

const packageManifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
) as { version: string };

/** Only the artifact surface dispatch needs (id → written absolute path). */
type ArtifactResolver = Pick<ArtifactReceiver, "result">;

const DEFAULT_TIMEOUT_MS = 30_000;
const LONG_TIMEOUT_MS = 120_000; // create/capture/export can fetch or process assets
const LONG_TIMEOUT_TOOLS = new Set([
  "create_site",
  "capture",
  "export",
  "upload_asset",
]);
const ARTIFACT_TOOLS = new Set(["capture", "export"]);
// export_template installs the template + captures per-block light/dark
// thumbnails through a headless browser — the slowest tool by far.
export const EXPORT_TEMPLATE_TIMEOUT_MS = 300_000;
const STATUS_TIMEOUT_MS = 10_000;
// One budget per normal tool call, under Codex's 60s default: up to 20s to get
// a tab back, queue wait ending 25s after the call started, then 30s to run.
export const RECOVERY_BUDGET_MS = 20_000;
const QUEUE_DEADLINE_MS = 25_000;
const RECOVERY_POLL_MS = 500;
const DEFAULT_APP_URL = "https://studio.swebsy.com";

// Computed at module load — SWEBSY_AUTHORING is fixed for the process
// lifetime, so the env-dependent surface is stable here.
const KNOWN_TOOL_NAMES = new Set(buildMcpTools().map((t) => t.name));

function timeoutFor(wire: string): number {
  if (wire === "export_template") return EXPORT_TEMPLATE_TIMEOUT_MS;
  return LONG_TIMEOUT_TOOLS.has(wire) ? LONG_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
}

function buildPairUrl(code: string, port: number, auto = false): string {
  const rawBase = process.env.SWEBSY_APP_URL ?? DEFAULT_APP_URL;
  let url: URL;
  try {
    url = new URL(rawBase);
  } catch {
    throw new BridgeError(
      "validation_failed",
      "SWEBSY_APP_URL must be an absolute http(s) URL."
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BridgeError(
      "validation_failed",
      "SWEBSY_APP_URL must use http or https."
    );
  }
  // An auto link lets an already-paired tab claim the session before the new
  // tab spends the code (McpProvider).
  if (auto) url.searchParams.set("swebsy_auto", "1");
  url.searchParams.set("swebsy_pair", code);
  url.searchParams.set("swebsy_port", String(port));
  return url.toString();
}

/** Open a URL in the OS default browser. Best-effort — returns false if it can't. */
function openInBrowser(url: string): boolean {
  if (process.env.SWEBSY_NO_OPEN) return false;
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const cmdArgs =
    process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, cmdArgs, { detached: true, stdio: "ignore" }).unref();
    return true;
  } catch {
    return false;
  }
}

/** swebsy_status: relay's own view + (if connected) the tab's view + tool list. */
async function statusResult(relay: RelayApi, args: unknown): Promise<unknown> {
  const verbose = (args as { verbose?: unknown } | null)?.verbose === true;
  const s = await relay.status();
  const base = { ...s, tools: [...KNOWN_TOOL_NAMES] };
  if (!s.connected) return { ...base, tab: null };
  if (s.busy) return { ...base, tab: null };
  try {
    return {
      ...base,
      // Send the key only when set: an older tab build rejects `status` with
      // any arguments at all, and this bridge ships ahead of the app.
      tab: await relay.sendCommand(
        "status",
        verbose ? { verbose: true } : {},
        STATUS_TIMEOUT_MS
      ),
    };
  } catch (err) {
    return {
      ...base,
      tab: null,
      tabError: err instanceof BridgeError ? err.toJSON() : String(err),
    };
  }
}

/**
 * Capture/export return `{ artifacts: [{ id, kind, filename }], … }`; the bytes
 * arrive out-of-band on `onFrame` and land on disk asynchronously. Swap each
 * ref's `id` for the awaited absolute `path` so the agent gets real files, not
 * transient ids. A failed write rejects here → the tool call surfaces the error.
 */
async function resolveArtifacts(
  result: unknown,
  artifacts: ArtifactResolver
): Promise<unknown> {
  const refs = (result as { artifacts?: unknown })?.artifacts;
  if (!Array.isArray(refs)) return result;
  const resolved = await Promise.all(
    refs.map(async (ref) => ({
      ...(ref as object),
      path: await artifacts.result(String((ref as { id: unknown }).id)),
    }))
  );
  return { ...(result as object), artifacts: resolved };
}

const FONT_EXTS = new Set([".woff", ".woff2", ".ttf", ".otf", ".eot"]);

/** Longest shared directory of a set of absolute paths ("" if none). */
function commonDir(paths: string[]): string {
  const split = paths.map((p) => p.split("/"));
  const [first] = split;
  let i = 0;
  while (i < first.length - 1 && split.every((s) => s[i] === first[i])) i += 1;
  return first.slice(0, i).join("/");
}

/**
 * `export` writes one artifact per file — fonts and assets dominate (~37
 * entries per call) while the agent only ever needs the page paths. Collapse to
 * outDir + pages + per-kind counts; `verbose: true` keeps the full list.
 */
export function summarizeExport(result: unknown, verbose: boolean): unknown {
  const r = (result ?? {}) as { artifacts?: unknown };
  const refs = Array.isArray(r.artifacts) ? r.artifacts : [];
  const paths = refs
    .map((a) => String((a as { path?: unknown }).path ?? ""))
    .filter(Boolean);
  if (verbose || paths.length === 0) return result;

  const outDir = commonDir(paths);
  const rel = (p: string) =>
    outDir && p.startsWith(`${outDir}/`) ? p.slice(outDir.length + 1) : p;
  const counts: Record<string, number> = {};
  const pages: string[] = [];
  let projectJson: string | undefined;
  for (const p of paths) {
    const ext = extname(p).toLowerCase();
    const kind =
      ext === ".html"
        ? "pages"
        : FONT_EXTS.has(ext)
          ? "fonts"
          : ext === ".css" || ext === ".js" || ext === ".json"
            ? ext.slice(1)
            : "assets";
    counts[kind] = (counts[kind] ?? 0) + 1;
    if (ext === ".html") pages.push(rel(p));
    if (p.endsWith("project.json")) projectJson = rel(p);
  }
  const { artifacts: _dropped, ...rest } = r as Record<string, unknown>;
  return {
    ...rest,
    outDir,
    pages,
    counts,
    ...(projectJson ? { projectJson } : {}),
    note: "Paths are relative to outDir. Pass verbose:true for every written file.",
  };
}

/**
 * upload_asset is the one command whose payload lives on the AGENT's disk, not
 * in the tab: the browser can't read a local path, so the file is read and
 * base64'd here and the bytes ride in the command args. Extension-driven MIME
 * (no sniffing) keeps the allowed set closed — the tab hands whatever we send
 * straight to the asset store.
 */
const UPLOAD_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  // SVG is a script host, but the tab sanitizes it on the way into storage
  // (frontend sanitizeSvg.ts), the same as a human drag-and-drop upload.
  ".svg": "image/svg+xml",
};
// ponytail: base64 rides in one WS frame, so cap it. Chunk like artifacts do if
// someone genuinely needs bigger images.
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export async function buildUploadPayload(args: unknown): Promise<unknown> {
  const { path: filePath, filename } = (args ?? {}) as {
    path?: unknown;
    filename?: unknown;
  };
  if (typeof filePath !== "string" || !filePath.trim()) {
    throw new BridgeError(
      "validation_failed",
      "upload_asset requires `path` — an absolute path to an image file."
    );
  }
  if (!isAbsolute(filePath)) {
    throw new BridgeError(
      "validation_failed",
      `upload_asset needs an absolute path; got "${filePath}".`
    );
  }
  const ext = extname(filePath).toLowerCase();
  const mimeType = UPLOAD_MIME_BY_EXT[ext];
  if (!mimeType) {
    throw new BridgeError(
      "validation_failed",
      `Unsupported image type "${ext || "(none)"}". Allowed: ${Object.keys(
        UPLOAD_MIME_BY_EXT
      ).join(", ")}.`
    );
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(filePath);
  } catch (err) {
    throw new BridgeError(
      "validation_failed",
      `Cannot read ${filePath}: ${(err as Error).message}`
    );
  }
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new BridgeError(
      "validation_failed",
      `${filePath} is ${(bytes.byteLength / 1_048_576).toFixed(1)} MB; the limit is ${
        MAX_UPLOAD_BYTES / 1_048_576
      } MB. Re-encode or resize it first.`
    );
  }
  // A display name with no extension ("Pulsar workspace") makes the site
  // exporter emit `<assetId>.pulsar workspace` — a broken, space-bearing
  // filename. Keep the caller's label but always land the real extension on it.
  const label =
    typeof filename === "string" && filename.trim() ? filename.trim() : "";
  const displayName = !label
    ? basename(filePath)
    : label.toLowerCase().endsWith(ext)
      ? label
      : `${label}${ext}`;

  return {
    filename: displayName,
    mimeType,
    data: bytes.toString("base64"),
  };
}

function cancelled(): BridgeError {
  return new BridgeError("cancelled", "The agent cancelled this call.");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelled());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * No tab attached → bring one back instead of failing the call. Opens Studio
 * once (the broker reuses a live code across parallel calls), then waits for a
 * tab to attach. Never dispatches late: past the budget the call fails with the
 * one next step for the user.
 */
async function ensureTab(
  relay: RelayApi,
  signal: AbortSignal | undefined,
  budgetMs: number
): Promise<void> {
  if (signal?.aborted) throw cancelled();
  if ((await relay.status()).connected) return;
  const features = (await relay.features?.()) ?? new Set<string>();
  if (!features.has("pair_reuse")) {
    // An old broker would mint (and so revoke) a fresh code on every call.
    throw new BridgeError(
      "not_connected",
      "Studio isn't connected. Call swebsy_start_pairing and ask the user to open the link."
    );
  }
  if (signal?.aborted) throw cancelled();
  const { code, port, fresh } = await relay.startPairing({ reuse: true });
  const pairUrl = buildPairUrl(code, port, true);
  if (fresh) openInBrowser(pairUrl);
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    await sleep(RECOVERY_POLL_MS, signal);
    if ((await relay.status()).connected) return;
  }
  throw new BridgeError(
    "not_connected",
    `Studio isn't connected. The user may need to click the Swebsy tab (it may be asleep) or open ${pairUrl}. Retry this call after they do.`
  );
}

export interface DispatchOptions {
  signal?: AbortSignal;
  /** Test override for RECOVERY_BUDGET_MS. */
  recoveryBudgetMs?: number;
}

/** Route one MCP tool call. Throws BridgeError on failure. */
export async function dispatchTool(
  relay: RelayApi,
  name: string,
  args: unknown,
  artifacts?: ArtifactResolver,
  opts: DispatchOptions = {}
): Promise<unknown> {
  const startedAt = Date.now();
  const { signal } = opts;
  if (!KNOWN_TOOL_NAMES.has(name)) {
    throw new BridgeError("validation_failed", `Unknown tool: ${name}`);
  }
  const wire = toWireName(name);
  if (wire === "start_pairing") {
    const { code, port } = await relay.startPairing();
    const pairUrl = buildPairUrl(code, port);
    const opened = openInBrowser(pairUrl);
    return {
      code,
      port,
      pairUrl,
      opened,
      instructions: opened
        ? `Opened Studio in the user's browser to connect automatically. If nothing appeared, share this link: ${pairUrl}`
        : `Give the user this link to click — it connects Studio automatically: ${pairUrl}`,
    };
  }
  if (wire === "status") return statusResult(relay, args);
  const payload =
    wire === "upload_asset" ? await buildUploadPayload(args) : (args ?? {});
  await ensureTab(relay, signal, opts.recoveryBudgetMs ?? RECOVERY_BUDGET_MS);
  const result = await relay.sendCommand(wire, payload, timeoutFor(wire), {
    signal,
    queueDeadline: startedAt + QUEUE_DEADLINE_MS,
  });
  if (artifacts && ARTIFACT_TOOLS.has(wire)) {
    const resolved = await resolveArtifacts(result, artifacts);
    return wire === "export"
      ? summarizeExport(
          resolved,
          (args as { verbose?: unknown } | null)?.verbose === true
        )
      : resolved;
  }
  return result;
}

/**
 * The entry point a client lists as a slash command. How it's shown depends on
 * the client (Claude Code: `/swebsy:swebsy (MCP)`).
 */
export const SWEBSY_PROMPT = {
  name: "swebsy",
  description: "Connect to Swebsy Studio and open a site to build.",
  text: [
    "Build with Swebsy Studio.",
    "1. Call swebsy_status. If it is not connected, call swebsy_start_pairing and wait for the user to open the link.",
    "2. Call swebsy_get_builder_guide and follow it.",
    "3. Call swebsy_list_sites and ask the user which site to open, or offer to create one (swebsy_list_templates, swebsy_create_site).",
    "4. Call swebsy_open_site or swebsy_create_site, then poll swebsy_status until its tab.siteId matches and tab.editorReady is true.",
    "5. Build what the user asked for.",
  ].join("\n"),
};

function registerHandlers(
  server: Server,
  relay: RelayApi,
  artifacts: ArtifactResolver
): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: buildMcpTools(),
  }));

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
      {
        name: SWEBSY_PROMPT.name,
        description: SWEBSY_PROMPT.description,
      },
    ],
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    if (req.params.name !== SWEBSY_PROMPT.name) {
      throw new Error(`Unknown prompt: ${req.params.name}`);
    }
    return {
      description: SWEBSY_PROMPT.description,
      messages: [
        {
          role: "user" as const,
          content: { type: "text" as const, text: SWEBSY_PROMPT.text },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const { name, arguments: args } = req.params;
    try {
      const result = await dispatchTool(relay, name, args ?? {}, artifacts, {
        signal: extra.signal,
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) {
      const payload =
        err instanceof BridgeError
          ? err.toJSON()
          : { code: "validation_failed", message: String(err) };
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify(payload) }],
      };
    }
  });
}

async function main(): Promise<void> {
  // `--broker`: run the shared daemon that owns the port (spawned by the first
  // agent). Every agent process below is just a client of it.
  if (process.argv.includes("--broker")) {
    await runBroker();
    return;
  }
  // `setup`: register this server with every installed coding agent.
  if (process.argv[2] === "setup") {
    process.exitCode = await runSetup();
    return;
  }

  // Artifact bytes for THIS agent's capture/export are forwarded from the tab
  // (via the broker) and written under this process's workspace.
  const artifacts = new ArtifactReceiver();
  const relay = new BrokerClient(artifacts);

  const server = new Server(
    { name: "swebsy-mcp", version: packageManifest.version },
    { capabilities: { tools: {}, prompts: {} } }
  );
  registerHandlers(server, relay, artifacts);

  // Once the agent has introduced itself we know its name for the roster.
  server.oninitialized = () => {
    const info = server.getClientVersion();
    relay.setInfo(info?.name, info?.version);
    void relay.start().catch((err) => console.error("[swebsy-mcp]", err));
  };

  // The parent coding agent exited: stdin EOFs. Nothing else here would notice
  // — the SDK's stdio transport listens for 'data' and 'error' only, and its
  // close() merely pauses stdin. Meanwhile the broker socket keeps the event
  // loop alive, so the process would outlive its parent indefinitely, holding a
  // slot on the broker's roster and blocking the broker's own idle exit (which
  // waits for an empty roster). Orphans accumulated for weeks before this.
  process.stdin.on("end", () => process.exit(0));

  await server.connect(new StdioServerTransport());
}

if (
  process.argv[1] &&
  // realpath both sides: npx invokes the bin via a node_modules/.bin symlink,
  // while import.meta.url is the resolved real path — a raw compare never matches.
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
