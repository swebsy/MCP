import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSetup, setupClients, type Run, type SetupEnv } from "./setup.ts";

/** Stub CLIs: `installed` lists which exist, `has` which already know swebsy. */
function stubRun(
  installed: string[],
  has: string[] = [],
  failAdd: string[] = []
): { run: Run; calls: string[] } {
  const calls: string[] = [];
  const run: Run = async (cmd, args) => {
    calls.push(`${cmd} ${args.join(" ")}`);
    if (!installed.includes(cmd)) return { code: 127, output: "not found" };
    if (args[0] === "--version") return { code: 0, output: "1.0" };
    if (args[1] === "get")
      return { code: has.includes(cmd) ? 0 : 1, output: "" };
    if (args[1] === "add") {
      return failAdd.includes(cmd)
        ? { code: 1, output: "permission denied" }
        : { code: 0, output: "" };
    }
    return { code: 1, output: "unexpected" };
  };
  return { run, calls };
}

describe("setup", () => {
  let home: string;
  const env = (run: Run): SetupEnv => ({ run, home, platform: "linux" });
  const cursorFile = () => join(home, ".cursor", "mcp.json");
  const vscodeFile = () => join(home, ".config", "Code", "User", "mcp.json");
  const clineDir = () =>
    join(
      home,
      ".config",
      "Code",
      "User",
      "globalStorage",
      "saoudrizwan.claude-dev"
    );
  const clineFile = () =>
    join(clineDir(), "settings", "cline_mcp_settings.json");
  const clineCliFile = () =>
    join(home, ".cline", "data", "settings", "cline_mcp_settings.json");

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "swebsy-setup-test-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("registers with each installed CLI and merges into JSON configs", async () => {
    await mkdir(join(home, ".cursor"));
    await writeFile(
      cursorFile(),
      JSON.stringify({ mcpServers: { other: { command: "x" } }, theme: 1 })
    );
    await mkdir(join(home, ".config", "Code", "User"), { recursive: true });
    // Cline is detected by its extension folder, and its settings file lives a
    // level deeper than the folder that proves it is installed.
    await mkdir(clineDir(), { recursive: true });
    // The Cline CLI is a separate install with its own config root.
    await mkdir(join(home, ".cline"), { recursive: true });
    const { run, calls } = stubRun(["claude"]);

    const results = await setupClients(env(run));

    expect(results.map((r) => [r.client, r.outcome])).toEqual([
      ["Claude Code", "added"],
      ["Codex", "skipped"],
      ["Cursor", "added"],
      ["Windsurf", "skipped"],
      ["VS Code", "added"],
      ["Cline", "added"],
      ["Cline CLI", "added"],
    ]);
    expect(calls).toContain(
      "claude mcp add -s user swebsy -- npx -y @swebsy/mcp"
    );
    // Other servers and settings survive the merge.
    expect(JSON.parse(await readFile(cursorFile(), "utf8"))).toEqual({
      mcpServers: {
        other: { command: "x" },
        swebsy: { command: "npx", args: ["-y", "@swebsy/mcp"] },
      },
      theme: 1,
    });
    expect(JSON.parse(await readFile(vscodeFile(), "utf8"))).toEqual({
      servers: {
        swebsy: { type: "stdio", command: "npx", args: ["-y", "@swebsy/mcp"] },
      },
    });
    expect(JSON.parse(await readFile(clineFile(), "utf8"))).toEqual({
      mcpServers: {
        swebsy: { command: "npx", args: ["-y", "@swebsy/mcp"] },
      },
    });
    // The CLI takes a nested `transport` block, not the extension's flat one.
    expect(JSON.parse(await readFile(clineCliFile(), "utf8"))).toEqual({
      mcpServers: {
        swebsy: {
          transport: {
            type: "stdio",
            command: "npx",
            args: ["-y", "@swebsy/mcp"],
          },
        },
      },
    });
  });

  it("leaves an existing, customised swebsy entry exactly as it is", async () => {
    await mkdir(join(home, ".cursor"));
    const custom = JSON.stringify({
      mcpServers: {
        swebsy: { command: "npx", args: ["@swebsy/mcp@0.6"], env: { A: "1" } },
      },
    });
    await writeFile(cursorFile(), custom);
    const { run, calls } = stubRun(["claude"], ["claude"]);

    const results = await setupClients(env(run));

    expect(results[0]).toMatchObject({ outcome: "exists" });
    expect(calls.some((c) => c.includes("mcp add"))).toBe(false);
    expect(results[2]).toMatchObject({ outcome: "exists" });
    expect(await readFile(cursorFile(), "utf8")).toBe(custom);
  });

  it("never rewrites a malformed config, and exits non-zero", async () => {
    await mkdir(join(home, ".cursor"));
    await writeFile(cursorFile(), "{ not json");
    const lines: string[] = [];

    const code = await runSetup(env(stubRun([]).run), (l) => lines.push(l));

    expect(code).toBe(1);
    expect(await readFile(cursorFile(), "utf8")).toBe("{ not json");
    expect(lines.join("\n")).toContain("not valid JSON");
  });

  it("keeps going when one client fails, reporting each result", async () => {
    await mkdir(join(home, ".cursor"));
    const { run } = stubRun(["claude", "codex"], [], ["claude"]);
    const lines: string[] = [];

    const code = await runSetup(env(run), (l) => lines.push(l));

    expect(code).toBe(1);
    const out = lines.join("\n");
    expect(out).toContain("✗ Claude Code: permission denied");
    expect(out).toContain("✓ Codex: added");
    expect(out).toContain("✓ Cursor: added");
  });

  it("ends with the same next steps Studio, the docs and swebsy.com show", async () => {
    const lines: string[] = [];
    await runSetup(env(stubRun(["claude"]).run), (l) => lines.push(l));

    expect(lines.at(-1)).toBe(
      '\nRestart your agent, then ask it: "Build me a landing page with Swebsy." The first request opens Studio and connects it.'
    );
  });

  it("changes nothing on a second run", async () => {
    await mkdir(join(home, ".cursor"));
    const first = stubRun(["claude"]);
    await setupClients(env(first.run));
    const before = await readFile(cursorFile(), "utf8");

    // The CLI now knows swebsy, as it would after the first run.
    const second = stubRun(["claude"], ["claude"]);
    const results = await setupClients(env(second.run));

    expect(results.filter((r) => r.outcome === "added")).toEqual([]);
    expect(second.calls.some((c) => c.includes("mcp add"))).toBe(false);
    expect(await readFile(cursorFile(), "utf8")).toBe(before);
  });
});

// Real CLIs, each isolated in a throwaway config dir so nothing touches the
// developer's own setup. Opt-in: SWEBSY_SETUP_IT=1 pnpm --filter @swebsy/mcp test
describe.runIf(process.env.SWEBSY_SETUP_IT === "1")("setup (real CLIs)", () => {
  it("adds once, then leaves it alone, for Claude Code and Codex", async () => {
    const { spawnSync } = await import("node:child_process");
    const home = await mkdtemp(join(tmpdir(), "swebsy-setup-it-"));
    const isolated = {
      ...process.env,
      HOME: home,
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      CODEX_HOME: join(home, ".codex"),
    };
    await mkdir(isolated.CODEX_HOME, { recursive: true });
    const run: Run = async (cmd, args) => {
      const r = spawnSync(cmd, args, { env: isolated, encoding: "utf8" });
      return { code: r.status ?? 127, output: `${r.stdout}${r.stderr}` };
    };
    try {
      const first = await setupClients({
        run,
        home,
        platform: process.platform,
      });
      const second = await setupClients({
        run,
        home,
        platform: process.platform,
      });
      for (const client of ["Claude Code", "Codex"]) {
        const a = first.find((r) => r.client === client)!;
        if (a.outcome === "skipped") continue; // CLI not installed here
        expect(a.outcome).toBe("added");
        expect(second.find((r) => r.client === client)!.outcome).toBe("exists");
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 60_000);
});
