/**
 * Row model for the tool-call timing popover.
 *
 * Kept as a standalone pure module so the row/delta rules can be unit tested without
 * mounting the popover (ToolCallCard pulls in the whole narrator surface).
 */

export interface ToolTimingStep {
	key: string;
	label: string;
	/** Epoch ms, or null when the tool never reached this phase. */
	time: number | null;
}

export interface ToolTimingRow {
	key: string;
	label: string;
	time: number;
	/**
	 * Elapsed ms since the previous rendered row, or null for the first row.
	 * A null delta still occupies a column: the renderer emits an aria-hidden spacer so
	 * every row keeps the same number of columns and the time column stays aligned.
	 */
	deltaMs: number | null;
}

/**
 * Drop phases the tool never reached and attach the gap to the previous surviving phase.
 * Clock skew between phases is clamped to 0 rather than shown as a negative gap.
 */
export function buildToolTimingRows(steps: readonly ToolTimingStep[]): ToolTimingRow[] {
	const rows: ToolTimingRow[] = [];
	for (const step of steps) {
		if (step.time == null || !Number.isFinite(step.time)) continue;
		const previous = rows[rows.length - 1];
		rows.push({
			key: step.key,
			label: step.label,
			time: step.time,
			deltaMs: previous ? Math.max(0, step.time - previous.time) : null,
		});
	}
	return rows;
}
