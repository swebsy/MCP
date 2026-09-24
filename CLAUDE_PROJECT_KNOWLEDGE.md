# Swebsy MCP — feature reference

Project knowledge for building and editing real websites through the
`@swebsy/mcp` bridge. Everything below is the **tool surface**: it assumes you
have the MCP server connected and are driving a live Swebsy Studio tab. You do
not need — and should not read — the Swebsy source code to use it.

Package: `@swebsy/mcp` (v0.6.1). Every tool is named `swebsy_<verb>`.

---

## 1. What the bridge is

Swebsy is a visual website builder that exports real HTML/CSS/JS. The MCP
server lets any MCP-capable agent (Claude Code, Codex, Cursor, Copilot,
Windsurf) drive an open Studio tab over a local `127.0.0.1` WebSocket relay.
Nothing is proxied through Swebsy's servers, and Studio redacts secrets (API
keys, deploy tokens, chat history) before anything crosses the bridge.

Two surfaces share one tool set: the **in-app AI Builder** and the **MCP
bridge**. The same command does the same thing on both — schemas live once, and
so does behavior. What you learn on one surface transfers to the other.

### Setup

```bash
claude mcp add swebsy -- npx -y @swebsy/mcp     # Claude Code
codex mcp add swebsy -- npx -y @swebsy/mcp      # Codex
```

Cursor / Windsurf / Copilot take the equivalent JSON:
`{"command": "npx", "args": ["-y", "@swebsy/mcp"]}`.

### Pairing

Run `swebsy_start_pairing`. It opens a single-use pair URL in the default
browser (also returned, along with the raw code and relay port). Studio connects
and strips the code from the address bar. Fallback: **Global settings → Coding
agents**, paste the code, port `37373`.

Several agents can share one paired tab — register the server in each with the
same `SWEBSY_AGENT_PORT`. The broker serializes commands so the editor handles
one at a time and routes each result back to the requesting agent.

| Env var | Default | Purpose |
|---|---|---|
| `SWEBSY_AGENT_PORT` | `37373` | Relay port |
| `SWEBSY_AGENT_DIR` | workspace `.swebsy-agent` | Where screenshots/exports land |
| `SWEBSY_APP_URL` | `https://studio.swebsy.com` | Studio origin for the pair link |
| `SWEBSY_NO_OPEN` | unset | Skip auto-opening the pair link |

---

## 2. Session protocol

1. `swebsy_start_pairing` → user clicks the link.
2. `swebsy_status` → confirm `editorReady: true`. It also returns the site name,
   selected page, and a theme summary (fonts, default color mode, brand colors).
   `verbose: true` adds the full settings object including custom CSS.
3. `swebsy_create_site` (optionally `templateId`) or `swebsy_open_site`
   (`siteId` from `swebsy_list_sites`).
4. **Poll `swebsy_status` again** until the expected `siteId` appears and
   `editorReady` is true. Editing before that silently targets the wrong site.
5. `swebsy_select_page` before any page-scoped edit. Page tools act on the
   *currently selected* page, not on a page you name in the call.

`swebsy_get_builder_guide` returns the same static guidance the in-app AI
Builder is primed with — component system, theme classes, conventions. Load it
before authoring markup. `swebsy_list_skills` / `swebsy_get_skill` give deeper
guidance on animation, page composition, copywriting, forms, and nav.

---

## 3. Tool surface

### Session & discovery

| Tool | What it does |
|---|---|
| `swebsy_start_pairing` | Begin a pairing session; returns `pairUrl`. |
| `swebsy_status` | Bridge state, site, selected page, `editorReady`, theme summary. |
| `swebsy_list_sites` | Saved sites, newest first — **metadata only**, no content. |
| `swebsy_open_site` / `swebsy_create_site` / `swebsy_rename_site` | Open, create (blank or from a template), rename (internal name only, not SEO title). |
| `swebsy_list_templates` | Installed templates with names, tags, fonts, previews. |
| `swebsy_list_pages` / `swebsy_select_page` | Enumerate and switch pages. Never guess a page name. |
| `swebsy_list_blocks` | The pre-built block catalog (ids + labels) for `insert_block`. |

### Reading

| Tool | What it does |
|---|---|
| `swebsy_read_page` | The page component tree. `targetPath` arrays from here address every other tool. Supports detail levels; the default outline **truncates** — request more detail when you need ids or attributes. |
| `swebsy_read_selection` | The currently selected component (type, classes, attributes, text). |

### Editing

| Tool | What it does |
|---|---|
| `swebsy_add_section` | Append/insert a new section. |
| `swebsy_edit_section` | Replace or patch a component at `targetPath`. |
| `swebsy_delete_section` | Remove a component. |
| `swebsy_insert_block` | Drop in a catalog block by id. |
| `swebsy_replace_page_content` | Replace a whole page's content. |
| `swebsy_create_page` / `swebsy_link_page` | Add a page; point a link at a page. |
| `swebsy_update_settings` | Theme tokens, fonts, brand colors, SEO, custom CSS. |
| `swebsy_animate_page` | Apply scroll/entrance animation across a page. |
| `swebsy_commit_design_direction` | Lock an art direction from Swebsy's own catalog before building. Do this first; a second source of art direction produces incoherent pages. |
| `swebsy_upload_asset` | Put a local image into the asset library and get its `src`. |
| `swebsy_list_assets` | List managed assets with whole-project usage counts. |
| `swebsy_delete_asset` | Delete a managed asset, refusing live references unless forced. |

### Symbols (reusable, synced components)

| Tool | What it does |
|---|---|
| `swebsy_list_symbols` | Every symbol: id, name, type, instance count, page count — plus a **`health`** report. |
| `swebsy_promote_to_symbol` | Turn a component into a symbol; also **repairs** broken linkage. |
| `swebsy_add_symbol_instance` | Place a linked instance of a symbol on the current page. |

### Verification

| Tool | What it does |
|---|---|
| `swebsy_capture` | Styled screenshot at `mobile` (390) / `tablet` (768) / `desktop` (1280) / `wide` (1536). Scope with `targetPath` — a full-page PNG downscales past legibility. |
| `swebsy_export` | Write the site to `.swebsy-agent/exports/`. Static HTML/CSS/JS by default; `includeProjectJson: true` adds the portable project JSON with assets. |

Two dev-only tools (`swebsy_mark_block`, `swebsy_export_template`) appear only
when the developer sets `SWEBSY_AUTHORING=1` **and** Studio is a dev build.
They exist for authoring shipped templates and block catalogs.

---

## 4. Symbols in depth

A symbol is one **main** component plus linked **instances**. Editing any of
them propagates to all of them — the correct way to share a navbar, footer, or
CTA band across pages. Per-instance content overrides are supported: the styling
stays in sync while the copy can differ.

### Placement

`swebsy_add_symbol_instance` takes the same placement vocabulary as
`add_section`:

- `start` — prepend (shared navbar)
- `end` — append (shared footer, the default)
- `before-selected` / `after-selected` — land it next to `targetPath`

Relative placement **requires** `targetPath` (an agent has no canvas selection);
without it the call fails with `validation_failed` rather than silently
appending. This is how a shared CTA goes *above* an existing footer without
deleting and re-adding the footer.

### Health

Symbol linkage is stored as plain model props, so it can rot in ways that look
completely healthy from the outside. `swebsy_list_symbols` reports three states:

- **`orphans`** — copies whose main was deleted. Editing them changes nothing
  anywhere else.
- **`unregistered`** — instances the main doesn't list back. Edits propagate one
  way only, so some copies drift.
- **`ghosts`** — self-references inside a main. Corrupt, safe to clear.

Each group reports the ref, how many nodes, and which pages.

### Repair

**Never fix symbol state by deleting and re-adding.** Call
`swebsy_promote_to_symbol` on one affected section instead. Re-promoting:

- rebuilds a missing main and adopts every other copy carrying the same dead ref
- registers instances the main had lost
- clears ghosts

It returns a `repaired` count. Copies whose structure has **diverged too far**
come back as `detached` — they are deliberately left alone, because re-linking a
structurally different copy corrupts it on the next sync. Those are the only
ones you delete and re-add via `add_symbol_instance`.

### Reading symbol state

`swebsy_read_page` tags symbol roots inline:

- `sym=main:<id>` — this node is a symbol main
- `sym=<mainId>` — a healthy instance of that main
- `sym=orphan:<ref>` — a broken copy pointing at a main that no longer exists

Descendants stay untagged, so the outline shows structure, not noise.

---

## 5. Hidden state `edit_section` preserves

An edit is remove + add, so anything the edit DSL cannot express used to be
destroyed silently. Two classes of state are now carried across:

- **id-scoped CSS.** Design-panel styles live in `#id` rules that a class-only
  patch never mentions. They survive; ids the edit genuinely drops are still
  cleaned up, so no orphan CSS accumulates.
- **`changeProp` model props.** A nav link's `pageTarget` and the whole
  `animation*` family live on the model, not in classes or attributes. They are
  re-applied when the replacement leaves them empty, and reported back as
  **`carriedProps`** in the response so you can see what was preserved.

A value the replacement sets itself always wins. A replacement of a different
component type carries nothing.

**A page target can only be re-pointed with `swebsy_link_page`, never cleared by
an edit.** If you see `carriedProps` in a response, that is the system telling
you it saved state you would otherwise have lost — not a warning.

---

## 6. Known traps

- **`swebsy_add_section` appends after the footer.** Use an explicit position +
  `targetPath` when order matters.
- **Prefer a `component` replace over a `patch`** when an edit must reliably
  stick — patches are the narrower path and are easier to get wrong.
- **An `image` with an empty `src` gets a random stock photo.**
  `swebsy_upload_asset` is the only way to get your own imagery in. Prefer SVG
  for logos; uploaded SVG is sanitized. Max 10 MB.
- **Tailwind v4: `col-*` means `grid-column`, not a column width.** Using it as
  a Bootstrap-style width poisons grids. Build grids with
  `grid md:grid-cols-N` and plain-div children.
- **Custom CSS is a last resort.** Use real components, traits, and symbols, and
  restyle existing classes through CSS variables. Stay on theme colors — use
  `color-mix()`, never hard-coded `rgba()`.
- **`swebsy_capture` can come back unstyled after `swebsy_animate_page`.**
  Verify with `swebsy_export` and read the HTML rather than trusting the PNG.
- **`swebsy_export` output can be ~10 MB.** Grep the written files; don't read
  them whole.
- **`swebsy_create_page` can leave a stray `h1`.** Check the new page's tree
  before building on it.
- **Theme changes go through `swebsy_update_settings`** (brand colors, fonts).
  Always produce both a light and a dark variant.

---

## 7. Verification loop

Tool responses report what the editor *accepted*, not what the site *renders*.
For anything structural:

1. `swebsy_export` (add `includeProjectJson: true` when checking symbol linkage).
2. Grep the written HTML for the thing you changed — classes, `href`,
   `data-page-target`, `aria-current`, section order.
3. `swebsy_capture` a single section (`targetPath`) for visual checks.

Symbol linkage in particular is only truly confirmed in `project.json`: every
instance ref should resolve to a registered main.
