/**
 * setup.ts — `npx -y @swebsy/mcp setup`: register the Swebsy MCP server with
 * every coding agent installed on this machine, in one command.
 *
 * Rules: an existing `swebsy` entry is never touched (it may be customised); a
 * config file that doesn't parse is never rewritten; one client failing never
 * stops the others, but makes the exit code non-zero. Running it twice changes
 * nothing. Every subprocess goes through the injected `run`, so tests stub it.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const SERVER_NAME = "swebsy";
const COMMAND = "npx";
const ARGS = ["-y", "@swebsy/mcp"];

export type Run = (
  cmd: string,
  args: string[]
) => Promise<{ code: number; output: string }>;

export interface SetupEnv {
  run: Run;
  home: string;
  platform: NodeJS.Platform;
  /** %APPDATA% on Windows (VS Code's user config lives under it). */
  appData?: string;
}

type Outcome = "added" | "exists" | "skipped" | "failed";
export interface ClientResult {
  client: string;
  outcome: Outcome;
  detail: string;
}

const defaultRun: Run = (cmd, args) =>
  new Promise((resolve) => {
    let output = "";
    // .cmd shims (claude, codex, code) only resolve through a shell on Windows.
    const child = spawn(cmd, args, { shell: process.platform === "win32" });
    child.stdout?.on("data", (d) => (output += d));
    child.stderr?.on("data", (d) => (output += d));
    child.on("error", (err) => resolve({ code: 127, output: err.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
  });

/** Claude Code / Codex: their own CLI owns the config. */
async function viaCli(
  env: SetupEnv,
  client: string,
  cli: string,
  addArgs: string[]
): Promise<ClientResult> {
  if ((await env.run(cli, ["--version"])).code !== 0) {
    return { client, outcome: "skipped", detail: `${cli} not found` };
  }
  if ((await env.run(cli, ["mcp", "get", SERVER_NAME])).code === 0) {
    return { client, outcome: "exists", detail: "already set up, left as is" };
  }
  const add = await env.run(cli, addArgs);
  return add.code === 0
    ? { client, outcome: "added", detail: "added" }
    : { client, outcome: "failed", detail: add.output.trim() || "add failed" };
}

/** Cursor / Windsurf / VS Code: merge one entry into a JSON config file. */
async function viaJson(
  client: string,
  file: string,
  key: "mcpServers" | "servers",
  installed: boolean,
  entry: Record<string, unknown>
): Promise<ClientResult> {
  if (!installed) return { client, outcome: "skipped", detail: "not found" };
  let config: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(await readFile(file, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("not a JSON object");
      }
      config = parsed;
    } catch (err) {
      return {
        client,
        outcome: "failed",
        detail: `${file} is not valid JSON (${(err as Error).message}); left unchanged`,
      };
    }
  }
  const servers = (config[key] ?? {}) as Record<string, unknown>;
  if (typeof servers !== "object" || Array.isArray(servers)) {
    return {
      client,
      outcome: "failed",
      detail: `${file}: "${key}" is not an object; left unchanged`,
    };
  }
  if (SERVER_NAME in servers) {
    return { client, outcome: "exists", detail: "already set up, left as is" };
  }
  try {
    await mkdir(dirname(file), { recursive: true });
    const next = { ...config, [key]: { ...servers, [SERVER_NAME]: entry } };
    await writeFile(file, `${JSON.stringify(next, null, 2)}\n`);
    return { client, outcome: "added", detail: `added to ${file}` };
  } catch (err) {
    return { client, outcome: "failed", detail: (err as Error).message };
  }
}

const CLINE_EXTENSION = "saoudrizwan.claude-dev";
const CLINE_SETTINGS = [
  "globalStorage",
  CLINE_EXTENSION,
  "settings",
  "cline_mcp_settings.json",
];

function vscodeUserDir(env: SetupEnv): string {
  if (env.platform === "darwin") {
    return join(env.home, "Library", "Application Support", "Code", "User");
  }
  if (env.platform === "win32") {
    return join(
      env.appData ?? join(env.home, "AppData", "Roaming"),
      "Code",
      "User"
    );
  }
  return join(env.home, ".config", "Code", "User");
}

export async function setupClients(env: SetupEnv): Promise<ClientResult[]> {
  const stdio = { command: COMMAND, args: ARGS };
  const vscodeDir = vscodeUserDir(env);
  // Sequential on purpose: output order is stable and the CLIs don't contend.
  return [
    await viaCli(env, "Claude Code", "claude", [
      "mcp",
      "add",
      "-s",
      "user",
      SERVER_NAME,
      "--",
      COMMAND,
      ...ARGS,
    ]),
    await viaCli(env, "Codex", "codex", [
      "mcp",
      "add",
      SERVER_NAME,
      "--",
      COMMAND,
      ...ARGS,
    ]),
    await viaJson(
      "Cursor",
      join(env.home, ".cursor", "mcp.json"),
      "mcpServers",
      existsSync(join(env.home, ".cursor")),
      stdio
    ),
    await viaJson(
      "Windsurf",
      join(env.home, ".codeium", "windsurf", "mcp_config.json"),
      "mcpServers",
      existsSync(join(env.home, ".codeium", "windsurf")),
      stdio
    ),
    await viaJson(
      "VS Code",
      join(vscodeDir, "mcp.json"),
      "servers",
      existsSync(vscodeDir),
      { type: "stdio", ...stdio }
    ),
    // Cline is a VS Code extension, so its config hangs off the same user
    // directory — but in the extension's own globalStorage, not VS Code's
    // mcp.json. The extension folder existing is what says it is installed.
    await viaJson(
      "Cline",
      join(vscodeDir, ...CLINE_SETTINGS),
      "mcpServers",
      existsSync(join(vscodeDir, "globalStorage", CLINE_EXTENSION)),
      stdio
    ),
    // The Cline CLI (`npm i -g cline`) is a separate product from the VS Code
    // extension: its own config path, and a nested `transport` shape instead of
    // the flat one. Registering only the extension leaves CLI users unset up.
    await viaJson(
      "Cline CLI",
      join(env.home, ".cline", "data", "settings", "cline_mcp_settings.json"),
      "mcpServers",
      existsSync(join(env.home, ".cline")),
      { transport: { type: "stdio", ...stdio } }
    ),
  ];
}

const MARK: Record<Outcome, string> = {
  added: "✓",
  exists: "✓",
  skipped: "–",
  failed: "✗",
};

/** CLI entry. Resolves to the process exit code. */
export async function runSetup(
  env: SetupEnv = {
    run: defaultRun,
    home: homedir(),
    platform: process.platform,
    appData: process.env.APPDATA,
  },
  log: (line: string) => void = (line) => console.log(line)
): Promise<number> {
  const results = await setupClients(env);
  log("Swebsy MCP setup");
  for (const r of results) log(`  ${MARK[r.outcome]} ${r.client}: ${r.detail}`);
  const ready = results.filter(
    (r) => r.outcome === "added" || r.outcome === "exists"
  );
  if (ready.length === 0) {
    log(
      "\nNo supported agent found. Add this MCP server by hand: npx -y @swebsy/mcp"
    );
  } else {
    log(
      '\nRestart your agent, then ask it: "Build me a landing page with Swebsy." The first request opens Studio and connects it.'
    );
  }
  return results.some((r) => r.outcome === "failed") ? 1 : 0;
}
