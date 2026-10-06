/**
 * StructSed — structural mutations, addressed the same way StructView reads.
 *
 * Split into focused modules: `commands` (vocabulary + budgets), `apply` (pure text
 * transforms and diffs), `resolve` (address/field validation), and `tool` (the tool shell
 * and its execute pipeline). This index preserves the original `./struct-sed` import path.
 */
export { previewStructSedChange, type StructSedChangePreview, structSedTool } from "./tool";
