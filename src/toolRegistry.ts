/**
 * toolRegistry.ts — the drift-proof MCP tool surface.
 *
 * The agent-facing surface is an *explicit allowlist*, never "all real
 * handlers": `clarify_scope` is internal and stays out even though it ships in
 * `ALL_TOOLS`; `lookup_classes` has no handler and isn't in `ALL_TOOLS` at all.
 * Two groups make up the surface:
 *   1. allowlisted shared AI-builder tools (schemas from @swebsy/ai-tool-contracts)
 *   2. net-new bridge tools (session/read/knowledge/visual/export)
 * Every tool is exposed as `swebsy_<name>`; the wire command sent to the browser
 * is the bare `<name>`. A parity test asserts the surface == this allowlist.
 *
 * ── THE PERFECT-SYNC RULE (do not break) ──────────────────────────────────
 * A bare tool name must live in exactly ONE of two worlds:
 *   • EDITING VERBS (create_page, replace_page_content, link_page, add_section,
 *     …) are SHARED contract tools. Their schema is in @swebsy/ai-tool-contracts
 *     and their behavior in ONE place — frontend `handleToolCall`. Both surfaces
 *     (in-app AI Builder, MCP bridge) run that same handler, so the same command
 *     always does the same thing. Expose them by adding the name to
 *     AGENT_TOOL_ALLOWLIST — never by re-authoring a schema/behavior in
 *     NET_NEW_TOOLS.
 *   • BRIDGE-ONLY tools (pairing, status, capture, export, asset management,
 *     symbols, guide, read_selection) exist only over MCP. They live in
 *     NET_NEW_TOOLS and their bare names MUST be disjoint from ALL_TOOLS.
 * Putting an editing verb in NET_NEW_TOOLS forks its behavior between the two
 * surfaces — the exact drift this file exists to prevent. `toolRegistry.test.ts`
 * asserts NET_NEW_TOOLS bare names ∩ ALL_TOOLS names = ∅.
 */

import { ALL_TOOLS, type AIToolName } from "@swebsy/ai-tool-contracts";

export const AGENT_TOOL_PREFIX = "swebsy_";

/**
 * Shared AI-builder tools exposed to agents. Hand-curated — NOT derived from
 * ALL_TOOLS. `satisfies readonly AIToolName[]` makes a renamed/removed shared
 * tool fail typecheck here.
 */
export const AGENT_TOOL_ALLOWLIST = [
  "replace_page_content",
  "create_page",
  "link_page",
  "add_section",
  "edit_section",
  "delete_section",
  "insert_block",
  "update_settings",
  "commit_design_direction",
  "animate_page",
  "read_page",
  "get_skill",
] as const satisfies readonly AIToolName[];

export interface McpToolDef {
  /** Full agent-facing name, e.g. `swebsy_add_section`. */
  name: string;
  description: string;
  /** JSON Schema for the tool input (MCP `inputSchema`). */
  inputSchema: Record<string, unknown>;
}

const emptyObject = {
  type: "object" as const,
  properties: {},
  additionalProperties: false,
};

/**
 * Net-new tools the bridge implements itself (not shared with the frontend AI
 * Builder). Schemas are authored here; execution is in server.ts / the browser
 * runtime.
 */
export const NET_NEW_TOOLS: readonly McpToolDef[] = [
  {
    name: "swebsy_start_pairing",
    description:
      "Start a pairing session. Returns a single-use `pairUrl` — give it to the user to click; opening it connects their Studio tab automatically. (Also returns the raw `code`/`port` for manual entry.)",
    inputSchema: emptyObject,
  },
  {
    name: "swebsy_status",
    description:
      "Report bridge status, siteName, selected page, and editorReady, plus a short theme summary (fonts, default color mode, brand colors). After creating or opening a site, wait until editorReady is true and siteId matches the expected site before editing.",
    inputSchema: {
      type: "object",
      properties: {
        verbose: {
          type: "boolean",
          description:
            "Also return the full site settings object (all theme tokens + custom CSS). Default false — the summary answers 'am I connected and what is open?'.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "swebsy_list_pages",
    description:
      "List the project's pages (id, name, fileName, section count, which one is selected). Call this instead of guessing a page name for select_page or link_page.",
    inputSchema: emptyObject,
  },
  {
    name: "swebsy_list_templates",
    description:
      "Refresh and list installed site templates with names, descriptions, tags, fonts, preview URLs, and thumbnail URLs. Works from Home or Studio.",
    inputSchema: emptyObject,
  },
  {
    name: "swebsy_create_site",
    description:
      "Create a site and open it in Studio. Omit templateId for Swebsy's standard blank site; provide an installed template ID to import that template unchanged. Then poll swebsy_status until editorReady is true and siteId matches before editing.",
    inputSchema: {
      type: "object",
      properties: {
        templateId: {
          type: "string",
          minLength: 1,
          description:
            "Optional installed template ID from swebsy_list_templates. Omit for a blank site.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "swebsy_list_sites",
    description:
      "List saved sites newest-first as metadata only: IDs, internal names, status, timestamps, template ID, page count, and whether each site is open.",
    inputSchema: emptyObject,
  },
  {
    name: "swebsy_open_site",
    description:
      "Open a saved site by ID in the paired tab and return its metadata. Idempotent if it is already open. Poll swebsy_status for the expected siteId and editorReady before editing.",
    inputSchema: {
      type: "object",
      properties: {
        siteId: {
          type: "string",
          minLength: 1,
          description: "Authoritative site ID from swebsy_list_sites.",
        },
      },
      required: ["siteId"],
      additionalProperties: false,
    },
  },
  {
    name: "swebsy_rename_site",
    description:
      "Rename a saved site's internal Studio/Home name. This does not change its SEO or public title settings.",
    inputSchema: {
      type: "object",
      properties: {
        siteId: {
          type: "string",
          minLength: 1,
          description: "Authoritative site ID from swebsy_list_sites.",
        },
        name: {
          type: "string",
          minLength: 1,
          description:
            "New non-empty internal site name (trimmed before saving).",
        },
      },
      required: ["siteId", "name"],
      additionalProperties: false,
    },
  },
  {
    name: "swebsy_select_page",
    description: "Select a page in the connected Studio project.",
    inputSchema: {
      type: "object",
      properties: {
        page: { type: "string", description: "Page id or name to select." },
      },
      required: ["page"],
      additionalProperties: false,
    },
  },
  {
    name: "swebsy_read_selection",
    description:
      "Read the currently selected component (type, classes, attributes, text). Secrets are never surfaced.",
    inputSchema: emptyObject,
  },
  {
    name: "swebsy_list_symbols",
    description:
      "List the project's SYMBOLS (reusable components that stay in sync across every page). Returns each symbol's id, name, component type, instance count, and how many pages use it, plus a `health` report of BROKEN linkage: `orphans` (copies whose main was deleted — editing them changes nothing elsewhere), `unregistered` (instances the main doesn't list back, so edits propagate one way only) and `ghosts`. Repair any of it by calling promote_to_symbol on one affected section. Use before add_symbol_instance to find the symbol id.",
    inputSchema: emptyObject,
  },
  {
    name: "swebsy_promote_to_symbol",
    description:
      "Promote an existing component into a reusable SYMBOL so it can be shared, in sync, across pages. Pass its `targetPath` from read_page (e.g. the navbar or the CTA band). Also REPAIRS broken linkage (see list_symbols → health): re-promoting an orphaned copy rebuilds its main and re-links every other copy of it, and re-promoting a symbol registers instances it had lost. Returns the symbol id (for add_symbol_instance) and a `repaired` count; copies whose structure has diverged too far are reported as `detached` — delete_section + add_symbol_instance those instead.",
    inputSchema: {
      type: "object",
      properties: {
        targetPath: {
          type: "array",
          description:
            "Zero-based component indexes from the current page root, exactly as returned by read_page (e.g. [0] for the first top-level section).",
          items: { type: "integer", minimum: 0 },
          minItems: 1,
        },
        name: {
          type: "string",
          description: "Optional friendly name for the symbol (e.g. 'Navbar').",
        },
      },
      required: ["targetPath"],
      additionalProperties: false,
    },
  },
  {
    name: "swebsy_add_symbol_instance",
    description:
      "Add a linked INSTANCE of an existing symbol (see list_symbols) to the CURRENT page. The instance stays in sync with the symbol main and every other instance — the way to reuse one navbar/footer/CTA across pages. Select the target page with select_page first.",
    inputSchema: {
      type: "object",
      properties: {
        symbolId: {
          type: "string",
          description: "Id of the symbol main (from list_symbols).",
        },
        position: {
          type: "string",
          enum: ["start", "end", "before-selected", "after-selected"],
          description:
            "Where to place it on the page: 'start' prepends (e.g. a shared navbar), 'end' appends (e.g. a shared footer). 'before-selected'/'after-selected' land it next to `targetPath` — how you put a shared CTA ABOVE an existing footer without deleting the footer. Default 'end'.",
        },
        targetPath: {
          type: "array",
          description:
            "Zero-based component indexes from read_page identifying the section to sit next to. Required for 'before-selected'/'after-selected' — an agent has no canvas selection.",
          items: { type: "integer", minimum: 0 },
          minItems: 1,
        },
      },
      required: ["symbolId"],
      additionalProperties: false,
    },
  },
  {
    name: "swebsy_get_builder_guide",
    description:
      "Load the static Swebsy builder guidance (component system, theme classes, conventions) that the in-app AI Builder is primed with.",
    inputSchema: emptyObject,
  },
  {
    name: "swebsy_list_skills",
    description:
      "List the available deep-guidance skills (animation, page-composition, copywriting, forms, nav) with one-line summaries.",
    inputSchema: emptyObject,
  },
  {
    name: "swebsy_list_blocks",
    description:
      "List the pre-built block catalog (ids + labels) available to insert_block.",
    inputSchema: emptyObject,
  },
  {
    name: "swebsy_capture",
    description:
      "Capture a styled screenshot of the current page at a fixed viewport, written under .swebsy-agent/screenshots/. Returns the file path. Scope it with `targetPath` when verifying ONE section — a whole-page PNG downscales so far that component detail is unreadable.",
    inputSchema: {
      type: "object",
      properties: {
        viewport: {
          type: "string",
          enum: ["mobile", "tablet", "desktop", "wide"],
          description:
            "mobile=390px, tablet=768px, desktop=1280px, wide=1536px.",
        },
        targetPath: {
          type: "array",
          description:
            "Optional. Capture only the component at this read_page target path (e.g. [3] for the fourth section) instead of the whole page.",
          items: { type: "integer", minimum: 0 },
          minItems: 1,
        },
        selectionOnly: {
          type: "boolean",
          description:
            "Capture only the selected component instead of the full page.",
        },
      },
      required: ["viewport"],
      additionalProperties: false,
    },
  },
  {
    name: "swebsy_list_assets",
    description:
      "List managed assets in the open site with whole-project usage counts. References are checked across every page, shared symbols, styles, and site settings. Use imagesOnly:true and unusedOnly:true before deleting unused gallery images.",
    inputSchema: {
      type: "object",
      properties: {
        imagesOnly: {
          type: "boolean",
          description: "Return only image MIME types. Default false.",
        },
        unusedOnly: {
          type: "boolean",
          description:
            "Return only assets with no references anywhere in the project. Default false.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "swebsy_upload_asset",
    description:
      "Upload a local image file into the open site's asset library and return the `src` to use on an `image` component. This is the ONLY way to get your own imagery (screenshots, logos, textures, mockups) into a site — an `image` with an empty src gets a random stock photo instead. Reads the file from the agent's own filesystem, so pass a path you can see (for example a screenshot you just captured). The asset is stored in the project and travels with static export and project JSON.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          minLength: 1,
          description:
            "Absolute path to the image on the agent's machine. Allowed types: .png, .jpg, .jpeg, .webp, .gif, .avif, .svg. Max 10 MB — re-encode larger files first. Prefer .svg for logos and other flat vector art so it stays crisp at any size; uploaded SVG is sanitized (scripts and external references are stripped).",
        },
        filename: {
          type: "string",
          description:
            "Optional display name in the asset library. Defaults to the file's own basename.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "swebsy_delete_asset",
    description:
      "Delete one managed asset from the open site's asset gallery. By default this refuses assets referenced by any page, shared symbol, style, or site setting; call swebsy_list_assets first. force:true also clears live component references and should be used only when that is explicitly intended.",
    inputSchema: {
      type: "object",
      properties: {
        assetId: {
          type: "string",
          minLength: 1,
          description: "Managed asset ID returned by swebsy_list_assets.",
        },
        force: {
          type: "boolean",
          description:
            "Allow deleting an in-use asset and clearing its live references. Default false.",
        },
      },
      required: ["assetId"],
      additionalProperties: false,
    },
  },
  {
    name: "swebsy_export",
    description:
      "Export the site to .swebsy-agent/exports/. Static files via the site exporter and/or the project JSON (with assets). Returns `outDir`, the exported page paths, and per-kind file counts — verify a build by grepping those HTML files.",
    inputSchema: {
      type: "object",
      properties: {
        verbose: {
          type: "boolean",
          description:
            "Return every written file path (fonts and assets included) instead of the page list + counts. Default false.",
        },
        includeStatic: {
          type: "boolean",
          description: "Write the static HTML/CSS/JS export. Default true.",
        },
        includeProjectJson: {
          type: "boolean",
          description:
            "Write the portable project JSON + assets. Default false.",
        },
        minify: { type: "boolean", description: "Minify static output." },
        baseUrl: {
          type: "string",
          description: "Base URL for absolute links in the static export.",
        },
      },
      additionalProperties: false,
    },
  },
] as const;

/**
 * Dev-only template-authoring tools. NOT part of the default surface: they are
 * advertised only when the developer sets SWEBSY_AUTHORING=1, and the browser
 * runtime additionally refuses them outside a dev build (import.meta.env.DEV),
 * so end users of the published package can never reach them. Bare names must
 * stay disjoint from ALL_TOOLS (same rule as NET_NEW_TOOLS).
 */
export const DEV_AUTHORING_TOOLS: readonly McpToolDef[] = [
  {
    name: "swebsy_mark_block",
    description:
      "DEV-ONLY template authoring: mark the component at `targetPath` (from read_page) as a harvestable block, or update/remove its annotation. Marked sections become catalog blocks when the template is exported (see swebsy_export_template). Selection rule: mark the smallest meaningful designed composition, not an atomic content element. Never mark a lone image, video, heading, paragraph, divider, spacer, or a wrapper whose only meaningful child is one of those. A valid block combines at least two complementary content/layout elements (for example image + copy, heading + CTA, or label + stats), or is a self-contained structured component such as a navbar, form, gallery, card grid, pricing table, or stats grid. Prefer the nearest parent that captures the complete reusable composition. Avoid nested or overlapping markers unless the child is independently reusable and meaningfully different. Conventions: `localId` is a short kebab-case pattern name describing the section (e.g. 'hero-split', 'pricing-three-tier'); `description` is one sentence stating layout + style, shown on the catalog card; every `tags` entry is ONLY the canonical single-word vocabulary key (for example 'stats', never 'stats — Numbers, facts, or metrics'). Vocabulary descriptions are explanatory UI/help text and must never be copied into a tag value. Known aliases are auto-corrected to canonical form (returned as `correctedTags`), while unknown tags fail with the allowed list. Typically you mark every distinct reusable section of a page, then export once.",
    inputSchema: {
      type: "object",
      properties: {
        targetPath: {
          type: "array",
          description:
            "Zero-based component indexes from the current page root, exactly as returned by read_page (e.g. [0] for the first top-level section). The target must be a meaningful designed composition, not a lone atomic content element or its one-child wrapper.",
          items: { type: "integer", minimum: 0 },
          minItems: 1,
        },
        tags: {
          type: "array",
          description:
            "Canonical single-word vocabulary keys only (e.g. hero, cta, testimonials, pricing, stats). Never include the human-readable vocabulary description or the ' — description' display label in a tag value. Invalid tags return the full allowed list — retry with corrected tags.",
          items: { type: "string" },
        },
        localId: {
          type: "string",
          description:
            "Local block id (kebab-case). The catalog id becomes {templateId}-{localId} at export. Omitted → auto-suggested; pass the same id again to update an existing annotation in place.",
        },
        description: {
          type: "string",
          description:
            "One-sentence catalog-card summary of the section's layout and style.",
        },
        remove: {
          type: "boolean",
          description: "Remove the annotation instead of writing one (unmark).",
        },
      },
      required: ["targetPath"],
      additionalProperties: false,
    },
  },
  {
    name: "swebsy_export_template",
    description:
      "DEV-ONLY template authoring: export the open site as a template into the local content catalog. This installs the template (meta, project.json, static preview, thumbnail), harvests every component marked via swebsy_mark_block into the block catalog (light+dark thumbnails included), and rebuilds both catalogs. Requires the local content server (pnpm -F @swebsy/content run dev). Passing an existing `id` replaces that template; omitting `id` re-exports to the template this site was last exported as (or derives an id from `name`). Returns { id, blocksHarvested }.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "Distinctive one- or two-word public display name (for example 'Booked' or 'Aurora Glass'). Do not append the audience, purpose, style, or the word 'Template'; put that context in the description and SEO metadata.",
        },
        id: {
          type: "string",
          description:
            "Template id (kebab-case). Omit to update the last-exported template for this site; pass an existing catalog id to replace it.",
        },
        description: {
          type: "string",
          description: "One-sentence template description for the catalog.",
        },
        purpose: {
          type: "string",
          description:
            "What the site is for — drives the category shown on the Create-page card and its filter. Omitted defaults to 'other'.",
          enum: [
            "portfolio",
            "services",
            "saas",
            "link-in-bio",
            "nonprofit",
            "local-business",
            "events",
            "course",
            "other",
          ],
        },
        industries: {
          type: "array",
          description:
            "Controlled industry vocabulary: creative-services, professional-services, coaching, fitness-wellness, food-beverage, beauty-grooming, music-entertainment, nonprofit-community, personal-brand, software-tech, retail-ecommerce, education, other.",
          items: { type: "string" },
        },
        styles: {
          type: "array",
          description:
            "Controlled style vocabulary: minimal, editorial, bold, playful, brutalist, glass, classic, dark, colorful.",
          items: { type: "string" },
        },
        features: {
          type: "array",
          description:
            "Controlled feature vocabulary: gallery, video, testimonials, contact-form, booking-cta, blog-layout, portfolio-showcase, donation-cta, social-links, dark-mode, pricing, team, events, menu.",
          items: { type: "string" },
        },
        goodFor: {
          type: "array",
          description:
            "Free-form audience phrases shown on the template detail page (e.g. 'Software teams').",
          items: { type: "string" },
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
] as const;

const sharedByName = new Map(ALL_TOOLS.map((t) => [t.name, t]));

/** The allowlisted shared tools mapped to the MCP shape (prefixed). */
export function sharedMcpTools(): McpToolDef[] {
  return AGENT_TOOL_ALLOWLIST.map((name) => {
    const tool = sharedByName.get(name);
    if (!tool) {
      throw new Error(
        `AGENT_TOOL_ALLOWLIST names "${name}" but it is not in ALL_TOOLS.`
      );
    }
    return {
      name: AGENT_TOOL_PREFIX + name,
      description: tool.description,
      inputSchema: tool.input_schema as Record<string, unknown>,
    };
  });
}

/** The full agent-facing tool surface: shared (allowlisted) + net-new, plus
 *  the dev-only authoring tools when SWEBSY_AUTHORING=1 (checked per call so
 *  tests can stub the env). */
export function buildMcpTools(): McpToolDef[] {
  const devTools =
    process.env.SWEBSY_AUTHORING === "1" ? DEV_AUTHORING_TOOLS : [];
  return [...sharedMcpTools(), ...NET_NEW_TOOLS, ...devTools];
}

/** Strip the `swebsy_` prefix to get the wire command name for the browser. */
export function toWireName(mcpName: string): string {
  return mcpName.startsWith(AGENT_TOOL_PREFIX)
    ? mcpName.slice(AGENT_TOOL_PREFIX.length)
    : mcpName;
}
