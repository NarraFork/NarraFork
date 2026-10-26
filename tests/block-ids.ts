/**
 * Block ids for route tests (docs/BLOCK_STORAGE-DESIGN.md §5.5): actions on part of a
 * message are addressed by block id, as a client reads it from a page.
 */

/**
 * The id of the block holding element `index` of a message: its block row's id, or the
 * decoded id of a legacy envelope (`<messageId>:<index>`).
 */
export async function blockIdAt(messageId: string, index: number): Promise<string> {
	const { blockLayouts } = await import("../server/services/narrator-block-page");
	const rows = blockLayouts([messageId]).get(messageId);
	if (!rows) return `${messageId}:${index}`;
	let from = 0;
	for (const row of rows) {
		if (index < from + row.length) return row.id;
		from += row.length;
	}
	throw new Error(`Message ${messageId} has no element ${index}`);
}
