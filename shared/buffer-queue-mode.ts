export type BufferQueueMode = "turn" | "tool" | "interrupt";

export function resolveBufferQueueMode(queueMode: unknown, priority?: boolean): BufferQueueMode {
	return queueMode === "turn" || queueMode === "tool" || queueMode === "interrupt"
		? queueMode
		: priority
			? "tool"
			: "turn";
}

export interface BufferedQueueRow {
	id: string;
	seq: number;
	priority: boolean;
	metadataJson: string | null;
}

export function bufferedRowMode(row: BufferedQueueRow): BufferQueueMode {
	return resolveBufferQueueMode(JSON.parse(row.metadataJson ?? "{}").queueMode, row.priority);
}

/** Admission/mode changes own guidance order; only ordinary inputs may be dragged. */
export function ordinaryBufferReorder(
	rows: BufferedQueueRow[],
	ids: readonly string[],
): string[] | null {
	const ordered = [...rows].sort(
		(a, b) => Number(b.priority) - Number(a.priority) || a.seq - b.seq,
	);
	const guidance = ordered.filter((row) => bufferedRowMode(row) !== "turn").map((row) => row.id);
	const ordinary = ordered.filter((row) => bufferedRowMode(row) === "turn").map((row) => row.id);
	if (new Set(ids).size !== ids.length) return null;
	// Accept both the legacy complete list and a list containing ordinary IDs only.
	const requested = ids.length === ordered.length ? ids.slice(guidance.length) : ids;
	if (
		(ids.length === ordered.length && guidance.some((id, index) => ids[index] !== id)) ||
		requested.length !== ordinary.length ||
		ordinary.some((id) => !requested.includes(id))
	)
		return null;
	return [...requested];
}

/** Interrupt is hard-front; other group changes append and preserve existing guidance order. */
export function bufferedModePatch(
	row: BufferedQueueRow,
	rows: BufferedQueueRow[],
	mode: BufferQueueMode,
) {
	const previous = bufferedRowMode(row);
	const priority = mode !== "turn";
	const seq =
		mode === "interrupt"
			? Math.min(0, ...rows.filter((r) => r.priority).map((r) => r.seq)) - 1
			: (previous !== "turn") === priority
				? row.seq
				: Math.max(
						0,
						...rows.filter((r) => r.id !== row.id && r.priority === priority).map((r) => r.seq),
					) + 1;
	return {
		metadataJson: JSON.stringify({ ...JSON.parse(row.metadataJson ?? "{}"), queueMode: mode }),
		priority,
		seq,
	};
}
