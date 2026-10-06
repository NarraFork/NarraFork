/**
 * StructView — read a file by its structure instead of by line windows.
 *
 * Split into focused modules: `constants`, `render` (text/outline rendering + `Resolved`),
 * `nodes` (outline-node helpers), `modes/*` (one file per mode family), and `tool` (the
 * shell and its dispatch). This index preserves the original `./struct-view` import path.
 */
export { structViewTool } from "./tool";
