/**
 * vlist-stream-anim-extra.ts — the ONE place that builds the streaming fade's
 * `extra` fields for a row.
 *
 * Why this is a function and not two lines inside the shell: the animation store
 * needs a per-block key AND the narrator scope that decides mount-vs-live-birth,
 * and those two must describe the same narrator. When the shell built them inline,
 * the only test that could have caught a change re-implemented the same template
 * itself (`animKeyBase: \`n1:${md.key}\``), so it agreed with whatever the test
 * author believed rather than with the shell. Both now call this.
 *
 * Zero imports: safe for the shell, the render registry and tests alike.
 */

/** The row kinds that carry a streaming per-grapheme fade. */
export type StreamAnimKind = "markdown" | "reasoning";

export interface StreamAnimExtra {
	animateStreaming: true;
	/**
	 * Per-block key base. Namespaced by narrator because a live row's spec.key
	 * derives from the synthetic `__streaming__` id and is therefore IDENTICAL
	 * across narrators, while the store is module-level: switching narrator
	 * mid-stream used to find the other one's text under the same key, read it as a
	 * rewrite, and ask for the whole body to animate at once.
	 */
	animKeyBase: string;
	/**
	 * The mount-vs-live-birth scope. Passed on its own rather than parsed back out
	 * of `animKeyBase`: the store used to slice that key at its first ":", which
	 * made this template's shape load-bearing — reorder it and every first sighting
	 * reads as a cold mount, i.e. every new paragraph pops in with no fade, with
	 * nothing to announce it.
	 */
	animScope: string;
}

/**
 * The streaming-fade `extra` for a row, or `null` when the row must not animate.
 *
 * Committed rows never animate: they would re-fade every time they re-enter the
 * mounted window (CONTRACT §0 — a committed row does not change without the
 * reader asking).
 */
export function resolveStreamAnimExtra(input: {
	/** Whether this row is the LIVE one and animation is enabled. */
	animateStreaming: boolean;
	/** The row's kind; only markdown/reasoning carry the fade. */
	kind: string;
	/** The vlist item's spec key. */
	specKey: string;
	/** The panel narrator's id — the animation scope. */
	narratorId: string;
}): StreamAnimExtra | null {
	if (!input.animateStreaming) return null;
	if (input.kind !== "markdown" && input.kind !== "reasoning") return null;
	return {
		animateStreaming: true,
		animKeyBase: `${input.narratorId}:${input.specKey}`,
		animScope: input.narratorId,
	};
}
