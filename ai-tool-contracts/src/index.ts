/**
 * @swebsy/ai-tool-contracts
 *
 * Single source of truth for the AI tool schemas. Pure data — safe to import
 * from both the frontend AI Builder (Vite) and the Node agent bridge. No
 * React, GrapesJS, DOM, Vite, or fetch; the tsconfig pins `types: []` so a
 * browser/Node global sneaking in fails typecheck.
 */
export * from "./componentTypes.ts";
export * from "./tools.ts";
