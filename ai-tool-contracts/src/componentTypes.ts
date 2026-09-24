/**
 * componentTypes.ts
 *
 * The valid `type` values the AI may emit. Moved here from the frontend's
 * componentSchema.ts so the tool schemas (and the agent bridge) can reference
 * them without importing frontend source. Pure data — no imports.
 *
 * Must match the types registered in frontend/src/gjs-components/.
 */
export const COMPONENT_TYPES = [
  // Layout
  "container",
  "layout-row",
  "column",
  "div",
  "divider",
  // Typography
  "heading",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "paragraph",
  "link",
  "link-block",
  "badge",
  "blockquote",
  "list",
  "ul",
  "ol",
  "li",
  // The editor registers `list-item` and defines `li` as an alias extending it
  // (gjs-components/typography/list.tsx), so a saved <li> serializes back as
  // `list-item`. Without it here, read_page emits a type the validator drops —
  // and because a dropped node is silently removed, ANY component/patch edit on
  // an ancestor of a list wipes the list while still reporting success.
  "list-item",
  "span",
  "text",
  "textnode",
  // Media
  "image",
  "video",
  "iframe",
  "audio",
  "google-map",
  // Content
  "card",
  "card-media",
  "card-overlay",
  "card-group",
  "card-header",
  "card-body",
  "card-footer",
  "swebsy-icon",
  "gallery",
  "lightbox",
  "svg",
  "svg-in",
  // Navigation
  "nav",
  "navbar",
  "navbar-brand",
  "navbar-toggler",
  "navbar-collapse",
  "navbar-nav",
  "nav-item",
  "nav-link",
  "breadcrumbs",
  // Interactive
  "btn",
  "copy-button",
  "dark-mode-switch",
  "marquee",
  // Forms
  "form",
  "input",
  "textarea",
  "select",
  "option",
  "label",
  "fieldset",
  "legend",
  "checkbox",
  "radio",
  "button",
] as const;

export type ComponentTypeId = (typeof COMPONENT_TYPES)[number];
