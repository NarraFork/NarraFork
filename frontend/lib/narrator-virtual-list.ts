/**
 * Production safety gate for the exact narrator virtual list.
 *
 * The exact renderer remains available through the development calibration harness, but the
 * ordinary narrator route must stay on ChunkedMessageList until interactive parity covers the
 * critical edit/retry/permission/rollback workflows.
 */
export const NARRATOR_VIRTUAL_LIST_INTERACTIVE = false;

/** Resolve a persisted user request through the non-bypassable production interaction gate. */
export function resolveNarratorVirtualListEnabled(requested: boolean): boolean {
	return NARRATOR_VIRTUAL_LIST_INTERACTIVE && requested;
}
