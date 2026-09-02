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

/**
 * The row kinds that carry a streaming per-grapheme fade.
 *
 * `reasoning-steps` is the SAME content as `reasoning` in a different shape: the
 * adapter picks it the moment a run carries a `**title**`, which is what models
 * normally emit. Omitting it made the fade depend on the model's prose style — the
 * plain card faded, the titled trace did not, for one reasoning run.
 */
export type StreamAnimKind = "markdown" | "reasoning" | "reasoning-steps";

const STREAM_ANIM_KINDS: ReadonlySet<string> = new Set<StreamAnimKind>([
	"markdown",
	"reasoning",
	"reasoning-steps",
]);

/**
 * The animation identity of one MOUNT of a narrator's live row.
 *
 * Why the narratorId alone is not enough
 * -------------------------------------
 * `StreamAnimStore` tells a mount from a live birth by asking whether the scope is
 * warm (any sibling key committed under it). The scope used to be the narratorId,
 * but the store is MODULE-LEVEL and outlives a narrator switch: coming back to a
 * narrator that is still streaming finds its own earlier entries, reads the scope as
 * warm, and treats the `streaming_snapshot` catch-up as one enormous live append.
 * Measured on the real store: a 285-char catch-up produced boundary 5, i.e. 280
 * characters the reader had ALREADY been shown faded in again; a paragraph born
 * entirely while away produced boundary 0 and re-faded whole.
 *
 * The store's own header always described a narrator switch as a COLD mount — the
 * intent was right and the scope could not express it, because "n1 again" is
 * indistinguishable from "n1 still" without a generation.
 *
 * ⚠️ The epoch must reach BOTH the key and the scope. Putting it only on the key
 * leaves the previous mount's entries sitting under the old scope, which stays warm
 * and animates the catch-up exactly as before — verified against the real store
 * before this was written, because the two variants are indistinguishable from the
 * key template alone.
 */
export interface StreamAnimMount {
	narratorId: string;
	/** Monotonic per-mount generation; see `nextStreamAnimEpoch`. */
	epoch: number;
}

/**
 * Mint the next mount epoch.
 *
 * A plain module counter rather than a timestamp: two mounts inside one millisecond
 * (a remount from a re-render, a dock panel swap) must not collide, and collision
 * here is silent — the new mount would inherit the old one's warm scope and replay
 * the fade, which is the whole defect.
 */
let streamAnimEpoch = 0;
export function nextStreamAnimEpoch(): number {
	streamAnimEpoch += 1;
	return streamAnimEpoch;
}

/**
 * The store scope for one mount: `narratorId#epoch`.
 *
 * "#" cannot appear in a nanoid, so the two parts stay unambiguous. Scopes are
 * compared EXACTLY by the store, so `n1#2` never warms off `n1#1` — that inequality
 * is what makes the first frame after a switch seal.
 */
export function streamAnimScope(mount: StreamAnimMount): string {
	return `${mount.narratorId}#${mount.epoch}`;
}

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
	/**
	 * This mount's generation (see StreamAnimMount). Optional so a caller outside the
	 * shell keeps the old single-mount behaviour; the shell always supplies it.
	 */
	mountEpoch?: number;
}): StreamAnimExtra | null {
	if (!input.animateStreaming) return null;
	if (!STREAM_ANIM_KINDS.has(input.kind)) return null;
	const scope =
		input.mountEpoch == null
			? input.narratorId
			: streamAnimScope({ narratorId: input.narratorId, epoch: input.mountEpoch });
	return {
		animateStreaming: true,
		// The scope prefixes the key too, so a new mount's blocks are new keys rather
		// than appends onto the previous mount's remembered text. Without this the key
		// still carries the OLD body and the catch-up reads as a append/rewrite of it.
		animKeyBase: `${scope}:${input.specKey}`,
		animScope: scope,
	};
}
