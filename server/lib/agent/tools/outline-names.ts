/**
 * Outline tool names: string constants, no imports.
 *
 * Kept in a leaf module like `knowledge-kind.ts`, so that the permission, policy and loop modules
 * that only need the names do not import `tools/index.ts` (the shared tail of circular-import
 * chains back into the tool registry).
 */

export const OUTLINE_READ_TOOL = "OutlineRead";
export const OUTLINE_SEARCH_TOOL = "OutlineSearch";
export const OUTLINE_EDIT_TOOL = "OutlineEdit";

/** The tools that only read the outline. */
export const OUTLINE_READ_TOOLS = [OUTLINE_READ_TOOL, OUTLINE_SEARCH_TOOL] as const;

export const OUTLINE_TOOLS = [...OUTLINE_READ_TOOLS, OUTLINE_EDIT_TOOL] as const;

/** Whether a tool reads or writes the outline. */
export function isOutlineTool(name: string): boolean {
	return (OUTLINE_TOOLS as readonly string[]).includes(name);
}
