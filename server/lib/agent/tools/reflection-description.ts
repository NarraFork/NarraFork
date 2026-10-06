/**
 * Reflection-only tools stay in every request on purpose: removing them between
 * the parent turn and its bounded reflection turn would change the tool prefix
 * and reduce prompt-cache reuse. Being declared is not permission to call them.
 */
export const REFLECTION_ONLY_TOOL_AVAILABILITY =
	"This tool is intentionally declared in every request, including ordinary turns, to keep the tool list and prompt-cache prefix stable. Its declaration does NOT make it callable in an ordinary turn. It may be called only inside an active matching reflection loop when that loop's allowlist explicitly includes it; otherwise the call is rejected.";

export function describeReflectionOnlyTool(instructions: string): string {
	return `${instructions}\n\nAvailability: ${REFLECTION_ONLY_TOOL_AVAILABILITY}`;
}
