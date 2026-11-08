/**
 * Keys of an as-of read split into layers in which no block repeats: a statement keyed by block
 * (`CASE id WHEN … THEN seq`) takes one seq per block. Duplicate keys are dropped; a block asked
 * for at several seqs lands in several layers. Shared by both backends' `listVersionMetasAt`.
 */
export function keyLayers(
	keys: ReadonlyArray<{ blockId: string; seq: number }>,
): Array<Array<{ blockId: string; seq: number }>> {
	const seqs = new Map<string, number[]>();
	for (const key of keys) {
		const list = seqs.get(key.blockId);
		if (!list) seqs.set(key.blockId, [key.seq]);
		else if (!list.includes(key.seq)) list.push(key.seq);
	}
	const layers: Array<Array<{ blockId: string; seq: number }>> = [];
	for (const [blockId, list] of seqs) {
		for (const [i, seq] of list.entries()) {
			let layer = layers[i];
			if (!layer) {
				layer = [];
				layers.push(layer);
			}
			layer.push({ blockId, seq });
		}
	}
	return layers;
}
