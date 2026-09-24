/**
 * tools.ts
 *
 * Tool definitions passed to Claude's tool use API. Each tool's input_schema
 * is a JSON Schema describing the exact structure the AI must emit.
 *
 * Keep schemas tight — a looser schema means looser AI output and more
 * validation work downstream.
 */

import { COMPONENT_TYPES } from "./componentTypes.ts";

// Recursive component schema. We reuse this across tools.
// Note: "additionalProperties: true" is deliberate — components may carry
// custom props (tagname, iconPosition, etc.) for specific types AND the
// compact-form aliases (t/c/x/a/k/g) documented below.
const COMPONENT_SCHEMA = {
  type: "object",
  description:
    "A GrapesJS component node. Use `type`, `attributes`, `classes`, `content`, `style`, `components`. Or use the equivalent COMPACT aliases (`t`, `a`, `c`, `x`, `k`, `g`) to save output tokens — they expand server-side into the same canonical form.",
  properties: {
    type: {
      type: "string",
      enum: [...COMPONENT_TYPES],
      description:
        "The registered component type. For structural layout use the semantic " +
        "types — `container`, `layout-row`, `column` — NOT a bare `div` carrying " +
        "`.container`/`.row`/`.col-*` classes. Only the real types keep their " +
        'Layers-panel label ("Container"/"Row"/"Column") and Design-panel traits; ' +
        'a div with those classes shows as "Div" and loses them.',
    },
    "custom-name": {
      type: "string",
      description:
        'Friendly label shown in the Layers panel (e.g. "Hero", "Contact", ' +
        '"Footer"). Set one on EVERY top-level section so the layer tree reads ' +
        'as names, not a stack of "Div". Nested `container`/`layout-row`/`column` ' +
        "nodes self-label, so only reach for custom-name on a generic `div` " +
        "wrapper (top-level sections, notable cards).",
    },
    tagName: {
      type: "string",
      description:
        "HTML tag for generic types. Often inferred from type — only set when overriding.",
    },
    attributes: {
      type: "object",
      description:
        "HTML attributes. NEVER include `on*` event handlers or `javascript:` URLs.",
      additionalProperties: { type: "string" },
    },
    classes: {
      type: "array",
      items: { type: "string" },
      description:
        "CSS class names. Prefer preset component classes, then Tailwind utilities. For visual properties the Design panel edits (box-shadow, custom radius/filters) use the `style` object instead of an arbitrary `shadow-[…]`/`foo-[…]` bracket utility, so the value stays panel-editable.",
    },
    content: {
      type: "string",
      description: "Text content for leaf nodes.",
    },
    style: {
      type: "object",
      additionalProperties: { type: "string" },
      description:
        "Panel-editable CSS as kebab-case declarations, e.g. " +
        '{ "box-shadow": "8px 8px 0px 0px var(--color-secondary)" }. ' +
        "Use this — NOT an arbitrary utility like `shadow-[8px_8px_0_#f0f]` — " +
        "for any visual property the Design panel exposes. Colors MUST be theme " +
        "vars. Values must match the exact shape the panel parses back: see " +
        '"Panel-editable style objects" in the builder guide.',
    },
    components: {
      type: "array",
      description: "Child components (recursive).",
      items: { type: "object" },
    },
    // Compact-form aliases. All optional. Mixable with the verbose keys.
    // Verbose keys win on conflict — never set both for the same field.
    t: {
      type: "string",
      enum: [...COMPONENT_TYPES],
      description: "Compact alias for `type`.",
    },
    g: {
      type: "string",
      description: "Compact alias for `tagName`.",
    },
    c: {
      description:
        "Compact alias for `classes`. Either a space-separated string ('btn btn-primary btn-lg') or a string array. Prefer the string form — it's shorter.",
      anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
    },
    x: {
      type: "string",
      description: "Compact alias for `content`.",
    },
    a: {
      type: "object",
      description:
        "Compact alias for `attributes`. Same shape; same prohibitions on `on*` handlers and `javascript:` URLs.",
      additionalProperties: { type: "string" },
    },
    k: {
      type: "array",
      description: "Compact alias for `components` (children, recursive).",
      items: { type: "object" },
    },
    symbol: {
      description:
        'Mark this component as a reusable SYMBOL so styling edits propagate to every copy. Use `true` for site-wide singletons (navbar, footer, the CTA band above the footer). Use a short string id (e.g. "blog-card") to define a reusable MASTER that repeated items reference via `symbolRef` with the same id — the master node is also rendered as the FIRST instance, so give it real content. Prefer a symbol over hand-duplicating a repeated custom component: symbolized sections stay in sync AND stay harvestable as theme-adopting blocks. Load the `symbols` skill first.',
      anyOf: [{ type: "boolean" }, { type: "string" }],
    },
    symbolRef: {
      type: "string",
      description:
        'Create a linked INSTANCE of the symbol master that declared `symbol: "<id>"`. Repeats stay style-synced with the master; classes and structure CANNOT diverge per instance. To vary an instance, supply its own `content`/`attributes` inline (different title, image, href) — those leaves detach and diverge while styling stays shared (the artup "Card Overlay ×4" pattern). Use for repeated cards, link blocks, badges, eyebrow labels.',
    },
  },
  // Note: no longer require `type` — the AI may emit `t` instead. Both
  // missing is caught downstream by the validator with a clearer error.
  additionalProperties: true,
};

export const TOOL_REPLACE_PAGE_CONTENT = {
  name: "replace_page_content",
  description:
    "Replace ALL top-level sections of the CURRENTLY SELECTED page with a generated list of components. This OVERWRITES the page — it does NOT create a new page (use `create_page`) and does NOT append a single section (use `add_section`). Use when the user asks to build/replace/redesign an entire page. Each top-level component should be wrapped in a container.",
  input_schema: {
    type: "object",
    properties: {
      plan: {
        type: "string",
        description:
          "A 1-2 sentence summary of the sections you will create and why. This surfaces as an assistant message.",
      },
      components: {
        type: "array",
        description:
          "Top-level page components (sections). Each should be wrapped in a container.",
        items: COMPONENT_SCHEMA,
        minItems: 1,
      },
    },
    required: ["plan", "components"],
    additionalProperties: false,
  },
} as const;

export const TOOL_CREATE_PAGE = {
  name: "create_page",
  description:
    "Create a NEW blank page in the project and (by default) select it. Returns the new page's id and fileName. The page starts nearly empty — fill it with `replace_page_content` or `add_section`, and point a navbar/link at it with `link_page`. Use THIS to add an additional page; use `replace_page_content` (NOT this) to overwrite the current page's content.",
  input_schema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Display name / title for the page (e.g. 'About').",
      },
      fileName: {
        type: "string",
        description:
          "Optional URL slug without .html (e.g. 'about'). Defaults to a slug derived from `name`; auto-deduplicated against existing pages.",
      },
      select: {
        type: "boolean",
        description: "Select the new page after creating it. Default true.",
      },
    },
    required: ["name"],
    additionalProperties: false,
  },
} as const;

export const TOOL_LINK_PAGE = {
  name: "link_page",
  description:
    "Point an existing link at a project page — the same wiring the UI's 'Link to' picker does. Pass the link's `targetPath` (from `read_page`) and the target `page` (id or name). For a navbar link this sets its page target so the href and active state stay in sync; for a plain link or button it sets href to the page's ./slug.html. Use after `create_page` to wire a navbar to the new page.",
  input_schema: {
    type: "object",
    properties: {
      targetPath: {
        type: "array",
        description:
          "Zero-based component indexes from the current page root, exactly as returned by `read_page` (e.g. the nav link inside the navbar).",
        items: { type: "integer", minimum: 0 },
        minItems: 1,
      },
      page: {
        type: "string",
        description: "Page id or name to link to.",
      },
    },
    required: ["targetPath", "page"],
    additionalProperties: false,
  },
} as const;

export const TOOL_ADD_SECTION = {
  name: "add_section",
  description:
    "Insert a new section into the current page. Use for adding discrete sections (hero, features, pricing, CTA) to an existing page. Appends to the end by default; to place it somewhere specific, pass `position` plus the `targetPath` of the component to place it next to.",
  input_schema: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description: "1 sentence describing what this section does.",
      },
      component: {
        ...COMPONENT_SCHEMA,
        description: "The section component to insert.",
      },
      position: {
        type: "string",
        enum: ["start", "end", "before-selected", "after-selected"],
        description:
          "Where to insert. Defaults to 'end' if omitted. 'before-selected'/'after-selected' are measured against `targetPath` when you pass one, otherwise against the canvas selection — so pass `targetPath` with them unless the user has selected something.",
      },
      targetPath: {
        type: "array",
        description:
          "Zero-based component indexes from the current page root, exactly as returned by the most recent `read_page` call. The new section lands as a sibling immediately before or after this component, per `position`. Ignored when `position` is 'start' or 'end'.",
        items: { type: "integer", minimum: 0 },
        minItems: 1,
      },
    },
    required: ["summary", "component"],
    additionalProperties: false,
  },
} as const;

export const TOOL_EDIT_SECTION = {
  name: "edit_section",
  description:
    "Modify an existing component. By default this edits the selected component. To edit a component identified by `read_page`, provide its `targetPath`; an explicit path overrides the canvas selection. Preferred: provide `component` — the full replacement component tree (compact DSL OK), best for structural changes. Alternative: provide `html` — the complete modified HTML string. Fallback: provide `patch` — JSON Patch (RFC 6902) for tiny single-property tweaks. Supply exactly one. Preserve existing IDs: an id kept in the edit keeps the styles attached to it; an id you drop loses them.",
  input_schema: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description: "1 sentence explaining what the edit does.",
      },
      targetPath: {
        type: "array",
        description:
          "Zero-based component indexes from the current page root, exactly as returned by the most recent `read_page` call (for example [0] for the first top-level section or [0, 2] for its third child). Use this when the user names or relatively identifies a component instead of selecting it.",
        items: { type: "integer", minimum: 0 },
        minItems: 1,
      },
      component: {
        ...COMPONENT_SCHEMA,
        description:
          "Full replacement component tree. Use compact DSL (t/c/x/a/k) to save tokens. Preserve existing attributes.id values. A `style` object merges into the styles already on that id, so you only send the declarations that change.",
      },
      html: {
        type: "string",
        description:
          "The complete modified HTML for the target component. Prefer existing semantic/theme classes over raw Tailwind utilities. Preserve existing id attributes.",
      },
      patch: {
        type: "array",
        description:
          "JSON Patch (RFC 6902) operations applied to the target component JSON. Only for tiny single-property tweaks.",
        items: {
          type: "object",
          properties: {
            op: {
              type: "string",
              enum: ["add", "remove", "replace", "move", "copy", "test"],
            },
            path: { type: "string" },
            value: {},
            from: { type: "string" },
          },
          required: ["op", "path"],
          additionalProperties: false,
        },
        minItems: 1,
      },
    },
    required: ["summary"],
    additionalProperties: false,
  },
} as const;

export const TOOL_DELETE_SECTION = {
  name: "delete_section",
  description:
    "Remove a component from the current page entirely. Use this instead of emptying a section's contents — an emptied section leaves a stray blank div on the page. Deletes the selected component by default; pass `targetPath` (from `read_page`) to delete a component you did not select.",
  input_schema: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description: "1 sentence naming what is being removed.",
      },
      targetPath: {
        type: "array",
        description:
          "Zero-based component indexes from the current page root, exactly as returned by the most recent `read_page` call. Omit to delete the selected component.",
        items: { type: "integer", minimum: 0 },
        minItems: 1,
      },
    },
    required: ["summary"],
    additionalProperties: false,
  },
} as const;

export const TOOL_UPDATE_SETTINGS = {
  name: "update_settings",
  description:
    "Update site settings — SEO title/description, site URL, structured data (JSON-LD), per-page SEO overrides, language, theme tokens (light + dark), Google fonts, dark mode toggle, and site-wide custom CSS for component-level restyling (globalTheme.customTailwindConfig). Provide ONLY the fields that change. `general`/`seo` are SITE-WIDE; use `page` to change ONE page. Also used to match the theme to a reference IMAGE's vibe: sample its palette into brand/surface tokens and ALWAYS set BOTH light and dark variants.",
  input_schema: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description: "1 sentence explaining the settings change.",
      },
      general: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          language: { type: "string" },
          author: { type: "string" },
          keywords: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
      seo: {
        type: "object",
        description:
          "SITE-WIDE SEO. `siteUrl` is what makes robots.txt/sitemap.xml and canonical/og:url real — without it they ship the `https://yoursite.com` placeholder and the site is not indexable.",
        properties: {
          siteUrl: {
            type: "string",
            description:
              "Canonical base URL of the live site, e.g. `https://example.com` (scheme required, no trailing slash). Drives sitemap.xml, the robots.txt Sitemap line, and every canonical/og:url.",
          },
          ogTitle: { type: "string" },
          ogDescription: { type: "string" },
          ogImage: {
            type: "string",
            description:
              "Default social preview image for every page — the `/builder-assets/<siteId>/<assetId>` src returned by `upload_asset`, or an absolute URL. Wants a 1200x630 landscape image: a square one (a logo, a favicon) makes X render the small `summary` card instead of the wide one. Export resolves it against `siteUrl` so crawlers get an absolute URL.",
          },
          twitterTitle: { type: "string" },
          twitterDescription: { type: "string" },
          twitterImage: {
            type: "string",
            description:
              "Overrides `ogImage` on X only. Omit unless the two images genuinely differ.",
          },
          generateLlmsTxt: {
            type: "boolean",
            description:
              "Emit `/llms.txt` — the AEO counterpart to robots.txt, a Markdown brief AI assistants read to learn what the site is. Generated from the site title, description and page list unless `llmsTxt` overrides it.",
          },
          llmsTxt: {
            type: "string",
            description:
              "Custom llms.txt body (Markdown: `# Name`, a `>` summary, then link sections). Leave unset to use the generated brief. Requires `generateLlmsTxt: true`.",
          },
          jsonLd: {
            type: "array",
            description:
              'Site-wide schema.org structured data, emitted into every page\'s <head> as application/ld+json. Pass the schema.org OBJECTS themselves — never a string, never HTML, never a <script> tag; the wrapper and escaping are added for you. Each entry needs an `@type` (add `"@context": "https://schema.org"` to each top-level node). Use this for entities true of the whole site (Organization, WebSite); put page-specific types (FAQPage, Product, Article) in `page.jsonLd` instead.',
            items: { type: "object" },
            maxItems: 20,
          },
        },
        additionalProperties: false,
      },
      page: {
        // `null` is part of the contract, not a looseness — it is the documented
        // "clear every override" reset, and a schema-validating client cannot
        // send it unless the type says so.
        type: ["object", "null"],
        description:
          "SEO for the CURRENTLY SELECTED PAGE ONLY — the per-page overrides otherwise reachable just from the Pages panel. Use this whenever you mean one page: `general.title`/`general.description` are SITE-WIDE and setting them to fix one page silently rewrites the meta description of every other page. Each field overrides its site-wide counterpart for this page; omit a field to keep inheriting. Pass `null` as the whole object to clear every override.",
        properties: {
          title: {
            type: "string",
            description: "Meta <title> for this page only.",
          },
          description: {
            type: "string",
            description:
              "Meta description for this page only. THIS is the per-page fix — not `general.description`.",
          },
          ogTitle: { type: "string" },
          ogDescription: { type: "string" },
          ogImage: { type: "string" },
          twitterTitle: { type: "string" },
          twitterDescription: { type: "string" },
          twitterImage: { type: "string" },
          canonicalUrl: {
            type: "string",
            description:
              "Absolute canonical URL. Leave unset to derive it from `seo.siteUrl` + the page's filename.",
          },
          robots: {
            type: "string",
            description: 'e.g. "index, follow" or "noindex, nofollow".',
          },
          jsonLd: {
            type: "array",
            description:
              "schema.org structured data for THIS page, appended after the site-wide `seo.jsonLd` nodes. Same rules: plain objects with an `@type`, no markup. This is where FAQPage, Product, Article, SoftwareApplication+Offer belong.",
            items: { type: "object" },
            maxItems: 20,
          },
        },
        additionalProperties: false,
      },
      fonts: {
        type: "object",
        description:
          "Google fonts to add/replace. Pass the full desired list — the array replaces what was there.",
        properties: {
          google: {
            type: "array",
            items: {
              type: "object",
              properties: {
                family: { type: "string" },
                variants: { type: "array", items: { type: "string" } },
                subsets: { type: "array", items: { type: "string" } },
              },
              required: ["family"],
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      globalTheme: {
        type: "object",
        description:
          "Theme overrides. Shallow diff — only include keys that change.",
        properties: {
          brandColors: {
            type: "object",
            description:
              "PREFERRED way to change a brand color. Pick a Tailwind color family; the full coherent light AND dark ramps (lighter/light/base/dark/darker) are generated automatically from the palette — dark mode is the same hue, dimmed. Do NOT also set color-* brand tokens by hand.",
            properties: Object.fromEntries(
              [
                "primary",
                "secondary",
                "success",
                "warning",
                "danger",
                "info",
              ].map((role) => [
                role,
                {
                  type: "object",
                  properties: {
                    family: {
                      type: "string",
                      description:
                        "Tailwind color family: slate, gray, zinc, neutral, stone, red, orange, amber, yellow, lime, green, emerald, teal, cyan, sky, blue, indigo, violet, purple, fuchsia, pink, rose.",
                    },
                  },
                  required: ["family"],
                  additionalProperties: false,
                },
              ])
            ),
            additionalProperties: false,
          },
          typography: {
            type: "object",
            description:
              "Typography. Set the global font here (NOT via themeTokens). Defining a stack only LOADS it — headingFont/bodyFont decide which stack each role actually uses.",
            properties: {
              fontFamily: {
                type: "object",
                description:
                  "Font-family stacks. To change the site font you must ALSO add it under fonts.google. The first family MUST exactly match the fonts.google family, and the stack MUST end with a generic fallback.",
                properties: {
                  sans: {
                    type: "string",
                    description:
                      "Sans stack, e.g. 'Space Grotesk, sans-serif'. The default stack for both roles.",
                  },
                  serif: {
                    type: "string",
                    description: "Serif stack, e.g. 'Lora, serif'.",
                  },
                  mono: {
                    type: "string",
                    description:
                      "Monospace stack, e.g. 'JetBrains Mono, monospace'.",
                  },
                },
                additionalProperties: false,
              },
              headingFont: {
                type: "string",
                description:
                  "Which stack h1-h6 use: 'sans' | 'serif' | 'mono'. REQUIRED whenever headings should differ from body — setting fontFamily.serif alone does NOT move headings onto it. This is the only correct way to give a site a serif heading face; never put font-serif on individual headings.",
              },
              bodyFont: {
                type: "string",
                description:
                  "Which stack body text uses: 'sans' | 'serif' | 'mono'. Defaults to 'sans'.",
              },
            },
            additionalProperties: false,
          },
          themeTokens: {
            type: "object",
            description:
              "Light-mode color map. Semantic Theme Colors keys (for example 'color-primary', 'background-color-default', 'text-color-muted', 'border-color-default') MUST reference a Base Colors swatch with var(--color-FAMILY-SHADE); never assign them hex/rgb/custom colors. Custom literals are allowed only on Base Colors keys such as 'color-blue-500', then semantic keys may reference that swatch. Do NOT set fonts here — use typography.fontFamily.",
            additionalProperties: { type: "string" },
          },
          darkThemeTokens: {
            type: "object",
            description:
              "Dark-mode semantic overrides. Every value MUST reference a Base Colors swatch with var(--color-FAMILY-SHADE); never use a hex/rgb/custom color here. Only include keys that should differ in dark mode.",
            additionalProperties: { type: "string" },
          },
          darkMode: {
            type: "object",
            description: "Dark mode toggle and default color mode.",
            properties: {
              enabled: { type: "boolean" },
              defaultColorMode: {
                type: "string",
                enum: ["system", "light", "dark"],
              },
            },
            additionalProperties: false,
          },
          customTailwindConfig: {
            type: "string",
            description:
              "Raw CSS appended to the compiled stylesheet (canvas + export). Use for " +
              "SITE-WIDE rules that utilities/tokens can't express — restyling a whole " +
              "component type (e.g. make every `.btn` neobrutalist), custom box-shadows, " +
              "border-width/radius. Colors MUST use theme vars (var(--color-neutral), " +
              "var(--color-secondary)) so they stay dark-mode aware. This REPLACES the " +
              "previous value — send the full CSS you want, not a fragment. " +
              "This CSS is document-scoped: it does NOT travel into a harvested block, " +
              "so it locks styled sections to this template. NEVER use it to build a " +
              "repeated custom component (card, link block, tile) — make that a SYMBOL " +
              "styled with theme classes so it stays harvestable. Reserve custom CSS for " +
              "genuinely global polish only.",
          },
        },
        additionalProperties: true,
      },
    },
    required: ["summary"],
    additionalProperties: false,
  },
} as const;

export const TOOL_INSERT_BLOCK = {
  name: "insert_block",
  description:
    "Insert a pre-built block from the catalog and optionally customize its content. STRONGLY preferred over generating from scratch when a matching block exists. The block re-themes on insert — its colour and font classes resolve against THIS site's theme, so the result is meant to differ from the catalog thumbnail (a screenshot of the block in the template it came from).",
  input_schema: {
    type: "object",
    properties: {
      blockId: {
        type: "string",
        description:
          "The block ID from the catalog (e.g., 'clarity-content-with-image').",
      },
      adaptations: {
        type: "object",
        description:
          "Structured customizations applied to the block before insertion.",
        properties: {
          imageSide: {
            type: "string",
            enum: ["left", "right"],
            description:
              "Which side the image appears in a two-column image+text layout.",
          },
          heading: {
            type: "string",
            description: "Replace the first heading's text.",
          },
          paragraphs: {
            type: "array",
            items: { type: "string" },
            description:
              "Replace paragraph content. Each string becomes one paragraph.",
          },
          ctaLabel: {
            type: "string",
            description: "Replace the primary CTA button's label.",
          },
          ctaHref: {
            type: "string",
            description: "Replace the primary CTA button's href.",
          },
          imageAlt: {
            type: "string",
            description: "Set the image's alt text.",
          },
        },
        additionalProperties: false,
      },
      position: {
        type: "string",
        enum: ["start", "end", "before-selected", "after-selected"],
        description:
          "Where to insert. Defaults to 'end' if omitted. 'before-selected'/'after-selected' are measured against `targetPath` when you pass one, otherwise against the canvas selection — so pass `targetPath` with them unless the user has selected something.",
      },
      targetPath: {
        type: "array",
        description:
          "Zero-based component indexes from the current page root, exactly as returned by the most recent `read_page` call. The block lands as a sibling immediately before or after this component, per `position`. Ignored when `position` is 'start' or 'end'.",
        items: { type: "integer", minimum: 0 },
        minItems: 1,
      },
    },
    required: ["blockId"],
    additionalProperties: false,
  },
} as const;

export const TOOL_CLARIFY_SCOPE = {
  name: "clarify_scope",
  description:
    "Ask the user to choose between an element-scoped change and a theme-wide change before acting. ALWAYS call this first when the scope is ambiguous.",
  input_schema: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "What you want to change, phrased as a question.",
      },
      options: {
        type: "array",
        minItems: 2,
        maxItems: 4,
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            label: { type: "string" },
            description: { type: "string" },
          },
          required: ["id", "label"],
          additionalProperties: false,
        },
      },
    },
    required: ["question", "options"],
    additionalProperties: false,
  },
} as const;

export const TOOL_LOOKUP_CLASSES = {
  name: "lookup_classes",
  description:
    "Retrieve the full list of preset component classes for a given family (e.g., 'btn', 'card', 'navbar', 'semantic', 'animation'). Use when you need to choose among specific variants.",
  input_schema: {
    type: "object",
    properties: {
      family: {
        type: "string",
        enum: [
          "btn",
          "badge",
          "grid",
          "card",
          "navbar",
          "semantic",
          "animation",
        ],
      },
    },
    required: ["family"],
    additionalProperties: false,
  },
} as const;

export const TOOL_GET_SKILL = {
  name: "get_skill",
  description:
    "Load deep, on-demand guidance for a specific area before acting on it (e.g. before adding animations, composing a new page, writing copy, building forms, editing the nav, or reusing components with symbols). Returns the full instructions for that skill.",
  input_schema: {
    type: "object",
    properties: {
      skill: {
        type: "string",
        enum: [
          "design-direction",
          "animation",
          "page-composition",
          "copywriting-ux",
          "forms-interactivity",
          "nav-management",
          "symbols",
        ],
        description: "Which skill's guidance to load.",
      },
    },
    required: ["skill"],
    additionalProperties: false,
  },
} as const;

export const TOOL_READ_PAGE = {
  name: "read_page",
  description:
    "Read the current page structure and addressable component target paths. Call this BEFORE editing a named or relative page component that is not the current selection. The default `sections` read lists every top-level section with its target path — enough to pick the one to edit. When copying content between components, use `detail: full` WITH the `targetPath` of the one section you're copying, not a whole-page read. Also call it AFTER applying edits to verify the result.",
  input_schema: {
    type: "object",
    properties: {
      detail: {
        type: "string",
        enum: ["sections", "outline", "full"],
        description:
          "'sections' (default): every section at the read root with its target path, an ~80-char text preview, and its descendant count — bounded and complete (~1-2 KB). 'outline': a deeper type/tag/class tree, character-capped. 'full': the complete cleaned JSON tree, for copying content between components (scope it with targetPath).",
      },
      targetPath: {
        type: "array",
        items: { type: "integer", minimum: 0 },
        description:
          "Optional. Zero-based component indexes from the page root (as returned by a prior read_page) that scope the read to that ONE subtree instead of the whole page. Strongly recommended with `detail: full` — reading one section's JSON instead of the entire page.",
      },
    },
    additionalProperties: false,
  },
} as const;

export const TOOL_ANIMATE_PAGE = {
  name: "animate_page",
  description:
    "Apply Swebsy's built-in scroll-reveal animation in one step — a smart, per-section staggered entrance on headings, text, images, buttons, and cards (navbars/footers skipped). Prefer this over hand-placing animate-* classes whenever the user asks to animate the page or site, or wants a consistent reveal.",
  input_schema: {
    type: "object",
    properties: {
      scope: {
        type: "string",
        enum: ["current_page", "all_pages"],
        description:
          "Animate just the current page (default) or every page in the site.",
      },
    },
    additionalProperties: false,
  },
} as const;

export const TOOL_COMMIT_DESIGN_DIRECTION = {
  name: "commit_design_direction",
  description:
    "Commit this site to a specific visual direction, and apply it (fonts, type roles, palette swatches). Call this ONCE, BEFORE generating a new site's first page — a site with no committed direction has nothing for later edits to stay consistent with, and the result drifts to generic. Prefer a `directionId` from the sampled menu; supply the `custom` fields only when the user's brief clearly calls for something the menu doesn't cover. Not needed when editing a site that already has a direction.",
  input_schema: {
    type: "object",
    properties: {
      directionId: {
        type: "string",
        description:
          "Id of a direction from the sampled menu (e.g. 'oat-editorial'). Preferred over `custom`.",
      },
      custom: {
        type: "object",
        description:
          "A direction you authored, when no menu entry fits the brief. Must be as specific as a menu entry — a face with actual character, a real palette, a named signature move.",
        properties: {
          id: {
            type: "string",
            description: "Short kebab-case slug naming the direction.",
          },
          label: { type: "string" },
          mode: {
            type: "string",
            enum: ["persuade", "operate", "read", "experience"],
            description:
              "What visitor success looks like: persuade (decide + act), operate (complete a task), read (understand), experience (the work itself leads).",
          },
          primaryFace: {
            type: "string",
            description:
              "Google Fonts family for body/UI. Must have character — never Geist, Inter, Roboto, Arial, Helvetica or system-ui.",
          },
          displayFace: {
            type: "string",
            description:
              "Optional Google Fonts family for headings. Omit for a deliberate single-face direction.",
          },
          displaySlot: {
            type: "string",
            enum: ["serif", "mono"],
            description:
              "Which family slot the display face occupies. Required when `displayFace` is set.",
          },
          headingFont: {
            type: "string",
            enum: ["sans", "serif", "mono"],
            description:
              "Route h1-h6 onto a slot site-wide. Omit to keep headings on the primary face and opt in per element with `font-serif`.",
          },
          neutralFamily: {
            type: "string",
            description:
              "Tailwind family for surfaces and ink (e.g. stone, zinc, slate, gray, neutral).",
          },
          accentFamily: {
            type: "string",
            description:
              "Tailwind family the brand primary ramp derives from (e.g. orange, teal, indigo).",
          },
          swatches: {
            type: "object",
            description:
              'Base Colors swatch literals keyed by token, e.g. { "color-stone-50": "#FAF6EF" }. This is what makes the palette specific rather than a stock Tailwind ramp — supply at least three.',
            additionalProperties: { type: "string" },
          },
          topology: {
            type: "string",
            description:
              "How the page is organized. Concrete enough to drive section rhythm, not a mood word.",
          },
          signatureMove: {
            type: "string",
            description: "The one thing a visitor would remember.",
          },
          notLike: {
            type: "string",
            description: "The nearby cliché this must not collapse into.",
          },
        },
        required: [
          "id",
          "mode",
          "primaryFace",
          "neutralFamily",
          "accentFamily",
          "topology",
          "signatureMove",
        ],
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
} as const;

export const ALL_TOOLS = [
  TOOL_REPLACE_PAGE_CONTENT,
  TOOL_COMMIT_DESIGN_DIRECTION,
  TOOL_CREATE_PAGE,
  TOOL_LINK_PAGE,
  TOOL_ADD_SECTION,
  TOOL_EDIT_SECTION,
  TOOL_DELETE_SECTION,
  TOOL_INSERT_BLOCK,
  TOOL_UPDATE_SETTINGS,
  TOOL_ANIMATE_PAGE,
  TOOL_CLARIFY_SCOPE,
  TOOL_GET_SKILL,
  TOOL_READ_PAGE,
] as const;

export type AIToolName = (typeof ALL_TOOLS)[number]["name"];
