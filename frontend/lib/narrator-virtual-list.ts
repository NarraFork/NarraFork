/** Whether the exact narrator virtual list can be selected in ordinary narrator sessions. */
export const NARRATOR_VIRTUAL_LIST_INTERACTIVE = true;

/** Resolve the persisted Chunk/Virtual selection through the rollout gate. */
export function resolveNarratorVirtualListEnabled(requested: boolean): boolean {
	return NARRATOR_VIRTUAL_LIST_INTERACTIVE && requested;
}
