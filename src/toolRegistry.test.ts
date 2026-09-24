import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALL_TOOLS } from "@swebsy/ai-tool-contracts";
import {
  AGENT_TOOL_ALLOWLIST,
  AGENT_TOOL_PREFIX,
  buildMcpTools,
  DEV_AUTHORING_TOOLS,
  NET_NEW_TOOLS,
  sharedMcpTools,
  toWireName,
} from "./toolRegistry.ts";

// ponytail: these two files live outside mcp/ and are absent from the public
// mirror (github.com/swebsy/MCP ships mcp/ + ai-tool-contracts/ only). They back
// monorepo cross-checks, so skip those tests where the files aren't there rather
// than redherring the mirror's CI. Absence skips; any other read error still throws.
const readMonorepoFile = (relative: string): string | null => {
  const url = new URL(relative, import.meta.url);
  return existsSync(url) ? readFileSync(url, "utf8") : null;
};

const codingAgentGuide = readMonorepoFile(
  "../../docs-site/src/content/docs/settings/ai-coding-agent.mdx"
);

// ponytail: regex the Set literal out of the source rather than importing the
// runtime — that module pulls in GrapesJS and the whole editor graph, which a
// bridge-contract test has no business booting.
const agentRuntimeSource = readMonorepoFile(
  "../../frontend/src/services/agent/SwebsyAgentRuntime.ts"
);

describe("toolRegistry", () => {
  const originalAuthoring = process.env.SWEBSY_AUTHORING;

  beforeEach(() => {
    delete process.env.SWEBSY_AUTHORING;
  });

  afterEach(() => {
    if (originalAuthoring === undefined) delete process.env.SWEBSY_AUTHORING;
    else process.env.SWEBSY_AUTHORING = originalAuthoring;
  });

  it.skipIf(!agentRuntimeSource)(
    "routes every allowlisted tool through the Studio bridge",
    () => {
      // Advertising a tool over MCP that SwebsyAgentRuntime cannot dispatch makes
      // it fail at call time with "Unknown command" — the tool looks available and
      // is not. commit_design_direction shipped that way.
      const block = /const MUTATE_READ_TOOLS = new Set\(\[([\s\S]*?)\]\)/.exec(
        agentRuntimeSource!
      );
      expect(block, "MUTATE_READ_TOOLS literal not found").not.toBeNull();
      const routed = [...block![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      expect([...AGENT_TOOL_ALLOWLIST].sort()).toEqual([...routed].sort());
    }
  );

  it("exposes exactly the allowlist for shared tools (no drift)", () => {
    const shared = sharedMcpTools().map((t) => t.name);
    expect(shared).toEqual(
      AGENT_TOOL_ALLOWLIST.map((n) => AGENT_TOOL_PREFIX + n)
    );
  });

  it("excludes clarify_scope and lookup_classes", () => {
    // clarify_scope ships in ALL_TOOLS but is internal; lookup_classes has no handler.
    expect(AGENT_TOOL_ALLOWLIST).not.toContain("clarify_scope");
    expect(AGENT_TOOL_ALLOWLIST).not.toContain("lookup_classes");
    const names = buildMcpTools().map((t) => t.name);
    expect(names).not.toContain("swebsy_clarify_scope");
    expect(names).not.toContain("swebsy_lookup_classes");
  });

  it("every tool is swebsy_-prefixed and unique", () => {
    const names = buildMcpTools().map((t) => t.name);
    for (const n of names) expect(n.startsWith(AGENT_TOOL_PREFIX)).toBe(true);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every tool has an object inputSchema", () => {
    const tools = buildMcpTools();
    for (const t of tools) {
      expect(t.inputSchema).toBeTypeOf("object");
      expect(t.inputSchema.type).toBe("object");
      expect(typeof t.description).toBe("string");
    }
  });

  it("shared tools preserve the contract's required fields (contract parity)", () => {
    const tools = buildMcpTools();
    const byName = new Map(ALL_TOOLS.map((t) => [t.name, t]));
    for (const name of AGENT_TOOL_ALLOWLIST) {
      const contract = byName.get(name)!;
      const contractSchema = contract.input_schema as { required?: unknown };
      const mcp = tools.find((t) => t.name === AGENT_TOOL_PREFIX + name)!;
      expect(mcp.inputSchema.required).toEqual(contractSchema.required);
      expect(mcp.inputSchema).toBe(contract.input_schema); // same object, no fork
    }
  });

  it("includes the expected net-new tools", () => {
    const netNew = NET_NEW_TOOLS.map((t) => t.name);
    expect(netNew).toEqual([
      "swebsy_start_pairing",
      "swebsy_status",
      "swebsy_list_pages",
      "swebsy_list_templates",
      "swebsy_create_site",
      "swebsy_list_sites",
      "swebsy_open_site",
      "swebsy_rename_site",
      "swebsy_select_page",
      "swebsy_read_selection",
      "swebsy_list_symbols",
      "swebsy_promote_to_symbol",
      "swebsy_add_symbol_instance",
      "swebsy_get_builder_guide",
      "swebsy_list_skills",
      "swebsy_list_blocks",
      "swebsy_capture",
      "swebsy_list_assets",
      "swebsy_upload_asset",
      "swebsy_delete_asset",
      "swebsy_export",
    ]);
  });

  it("publishes strict workspace-management schemas", () => {
    const tools = new Map(NET_NEW_TOOLS.map((tool) => [tool.name, tool]));
    for (const name of [
      "swebsy_list_templates",
      "swebsy_create_site",
      "swebsy_list_sites",
      "swebsy_open_site",
      "swebsy_rename_site",
    ]) {
      expect(tools.get(name)?.inputSchema.additionalProperties).toBe(false);
    }
    expect(
      tools.get("swebsy_create_site")?.inputSchema.required
    ).toBeUndefined();
    expect(tools.get("swebsy_open_site")?.inputSchema.required).toEqual([
      "siteId",
    ]);
    expect(tools.get("swebsy_rename_site")?.inputSchema.required).toEqual([
      "siteId",
      "name",
    ]);
    expect(tools.get("swebsy_status")?.description).toContain(
      "editorReady is true"
    );
  });

  it("keeps dev authoring tools out of the default public surface", () => {
    const names = buildMcpTools().map((t) => t.name);
    expect(names).not.toContain("swebsy_mark_block");
    expect(names).not.toContain("swebsy_export_template");
  });

  it("adds dev authoring tools only when SWEBSY_AUTHORING=1", () => {
    process.env.SWEBSY_AUTHORING = "1";
    const names = buildMcpTools().map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["swebsy_mark_block", "swebsy_export_template"])
    );
  });

  it("tells authoring agents to send canonical single-word tag values", () => {
    const markBlock = DEV_AUTHORING_TOOLS.find(
      (tool) => tool.name === "swebsy_mark_block"
    )!;
    const properties = markBlock.inputSchema.properties as Record<
      string,
      { description?: string }
    >;

    expect(markBlock.description).toContain("canonical single-word");
    expect(markBlock.description).toContain(
      "never 'stats — Numbers, facts, or metrics'"
    );
    expect(properties.tags.description).toContain(
      "Never include the human-readable vocabulary description"
    );
  });

  it("tells authoring agents to harvest designed compositions, not atomic elements", () => {
    const markBlock = DEV_AUTHORING_TOOLS.find(
      (tool) => tool.name === "swebsy_mark_block"
    )!;
    const properties = markBlock.inputSchema.properties as Record<
      string,
      { description?: string }
    >;

    expect(markBlock.description).toContain("smallest meaningful designed");
    expect(markBlock.description).toContain("Never mark a lone image");
    expect(markBlock.description).toContain(
      "nearest parent that captures the complete reusable composition"
    );
    expect(properties.targetPath.description).toContain(
      "not a lone atomic content element"
    );
  });

  it("tells authoring agents to use short template display names", () => {
    const exportTemplate = DEV_AUTHORING_TOOLS.find(
      (tool) => tool.name === "swebsy_export_template"
    )!;
    const properties = exportTemplate.inputSchema.properties as Record<
      string,
      { description?: string }
    >;

    expect(properties.name.description).toContain("one- or two-word");
    expect(properties.name.description).toContain(
      "Do not append the audience, purpose, style, or the word 'Template'"
    );
  });

  it.skipIf(!codingAgentGuide)(
    "documents every exposed tool in the coding-agent guide",
    () => {
      const names = buildMcpTools().map((t) => t.name);
      const start = codingAgentGuide!.indexOf("## Available tools");
      const end = codingAgentGuide!.indexOf(
        "## Switching between agent and API key"
      );
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      const toolSection = codingAgentGuide!.slice(start, end);

      for (const name of names) {
        expect(toolSection).toContain(`\`${name}\``);
      }
    }
  );

  it.skipIf(!codingAgentGuide)(
    "documents the shared multi-agent session contract",
    () => {
      const start = codingAgentGuide!.indexOf("## Use multiple coding agents");
      const end = codingAgentGuide!.indexOf("## Available tools");
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      const multiAgentSection = codingAgentGuide!.slice(start, end);

      expect(multiAgentSection).toContain("same `SWEBSY_AGENT_PORT`");
      expect(multiAgentSection).toContain("Pair the Studio tab once");
      expect(multiAgentSection).toContain("one editor");
      expect(multiAgentSection).toContain("revokes the previous tab");
    }
  );

  it("keeps editing verbs shared, not forked (the perfect-sync rule)", () => {
    // A bare tool name must live in exactly one world: a shared contract tool
    // (allowlist → one handler → both surfaces identical) OR a bridge-only tool
    // (NET_NEW_TOOLS / DEV_AUTHORING_TOOLS). Overlap = the same command doing
    // two different things.
    const contractNames = new Set<string>(ALL_TOOLS.map((t) => t.name));
    const netNewBare = NET_NEW_TOOLS.map((t) => toWireName(t.name));
    const authoringBare = DEV_AUTHORING_TOOLS.map((t) => toWireName(t.name));
    for (const bare of [...netNewBare, ...authoringBare]) {
      expect(contractNames.has(bare)).toBe(false);
    }
    expect(new Set([...netNewBare, ...authoringBare]).size).toBe(
      netNewBare.length + authoringBare.length
    );
    // The three page verbs must be exposed via the allowlist (shared handler).
    for (const verb of [
      "create_page",
      "replace_page_content",
      "link_page",
    ] as const) {
      expect(AGENT_TOOL_ALLOWLIST).toContain(verb);
      expect(netNewBare).not.toContain(verb);
    }
  });

  it("maps MCP names to bare wire command names", () => {
    expect(toWireName("swebsy_add_section")).toBe("add_section");
    expect(toWireName("swebsy_capture")).toBe("capture");
  });
});
