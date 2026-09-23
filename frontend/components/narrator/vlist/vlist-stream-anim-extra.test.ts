/**
 * vlist-stream-anim-extra.test.ts — the streaming fade must not replay over text the
 * reader has ALREADY watched arrive.
 *
 * ── The reported defect ───────────────────────────────────────────────────────
 *
 * Switch away from a narrator that is mid-stream, come back, and everything it
 * produced BEFORE the switch blurred in again. The server re-sends the whole
 * accumulated body on every `kind: "messages"` subscribe (`streaming_snapshot`), so
 * the returning client receives one enormous "append" — and the animation store
 * classified it as live typing.
 *
 * Cause: the store's mount-vs-live-birth SCOPE was the narratorId, while the store
 * itself is module-level and outlives the switch. Its own header always called a
 * narrator switch a cold mount; the scope simply could not express "n1 again" as
 * distinct from "n1 still".
 *
 * These tests drive the REAL store through the REAL shell wiring
 * (`resolveStreamAnimExtra`), because the defect lives in the relationship between
 * the two: the key template and the scope have to describe the same MOUNT, and a
 * test that rebuilds either one only proves it agrees with itself.
 */

import { describe, expect, it } from "bun:test";
import { StreamAnimStore } from "./render/stream-token-anim";
import {
	nextStreamAnimEpoch,
	resolveStreamAnimExtra,
	streamAnimScope,
} from "./vlist-stream-anim-extra";

/** The shell's own wiring for one live markdown row of one mount. */
function rowExtra(narratorId: string, mountEpoch: number, blockKey = "__streaming__-b0") {
	const extra = resolveStreamAnimExtra({
		animateStreaming: true,
		kind: "markdown",
		specKey: blockKey,
		narratorId,
		mountEpoch,
	});
	if (!extra) throw new Error("expected the live row to carry the fade");
	return extra;
}

/**
 * Drive one frame the way `InlineBlockView` does: peek during render, commit after.
 * Returns how many graphemes this frame would mount an animated span for.
 */
function frame(
	store: StreamAnimStore,
	extra: { animKeyBase: string; animScope: string },
	blockIndex: number,
	text: string,
	now: number,
): number {
	const key = `${extra.animKeyBase}:${blockIndex}`;
	const resolved = store.peekFrame(key, text, now, extra.animScope);
	store.commitFrame(key, text, now, extra.animScope, resolved);
	return Math.max(0, text.length - resolved.sealOffset);
}

describe("mount epoch", () => {
	it("mints a strictly increasing generation", () => {
		const first = nextStreamAnimEpoch();
		const second = nextStreamAnimEpoch();
		expect(second).toBeGreaterThan(first);
	});

	it("separates two mounts of the SAME narrator", () => {
		// The distinction the narratorId alone could not draw.
		expect(streamAnimScope({ narratorId: "n1", epoch: 1 })).not.toBe(
			streamAnimScope({ narratorId: "n1", epoch: 2 }),
		);
	});

	it("puts the epoch on the KEY as well as the scope", () => {
		// Key-only was measured against the real store and still animated the whole
		// catch-up: the previous mount's entries keep the OLD scope warm. Scope-only
		// leaves the key carrying the old body, so the catch-up reads as an append onto
		// it. Both halves are required, and neither failure is visible from the other.
		const first = rowExtra("n1", 1);
		const second = rowExtra("n1", 2);
		expect(second.animScope).not.toBe(first.animScope);
		expect(second.animKeyBase).not.toBe(first.animKeyBase);
	});

	it("keeps the epoch out of the identity when a caller omits it", () => {
		// A caller outside the shell (harness, older test) keeps single-mount behaviour
		// rather than silently getting a scope that never warms.
		const extra = resolveStreamAnimExtra({
			animateStreaming: true,
			kind: "markdown",
			specKey: "s-0",
			narratorId: "n1",
		});
		expect(extra?.animScope).toBe("n1");
	});
});

describe("snapshot animation baseline", () => {
	it("namespaces a delayed snapshot in both key and scope without a narrator remount", () => {
		const input = {
			animateStreaming: true,
			kind: "markdown",
			specKey: "__streaming__-b0",
			narratorId: "catchup-n",
			mountEpoch: 1,
		};
		const live = resolveStreamAnimExtra(input);
		const caughtUp = resolveStreamAnimExtra({ ...input, snapshotEpoch: 2 });
		const reconnected = resolveStreamAnimExtra({ ...input, snapshotEpoch: 3 });
		expect(caughtUp?.animScope).not.toBe(live?.animScope);
		expect(caughtUp?.animKeyBase).not.toBe(live?.animKeyBase);
		expect(reconnected?.animScope).not.toBe(caughtUp?.animScope);
		expect(reconnected?.animKeyBase).not.toBe(caughtUp?.animKeyBase);
		// Mount policy comes from each block's snapshot provenance, not the scope:
		// a NEW live text lane after catch-up must still animate its opening chunk.
		expect(caughtUp).not.toHaveProperty("sealOnMount");
	});

	it("seals a delayed snapshot, then resumes animation for subsequent live text", () => {
		const store = new StreamAnimStore();
		const live = rowExtra("catchup-n", 1);
		frame(store, live, 0, "初始小段", 1_000);
		frame(store, live, 0, "初始小段新增", 1_016);
		const caughtUp = resolveStreamAnimExtra({
			animateStreaming: true,
			kind: "markdown",
			specKey: "__streaming__-b0",
			narratorId: "catchup-n",
			mountEpoch: 1,
			snapshotEpoch: 2,
		});
		if (!caughtUp) throw new Error("missing snapshot animation extra");
		const full = "初始小段新增补載历史";
		expect(frame(store, caughtUp, 0, full, 1_032)).toBe(0);
		expect(frame(store, caughtUp, 0, `${full}实时`, 1_048)).toBe(2);
	});
});

describe("returning to a narrator that kept streaming", () => {
	it("does not re-fade the body the reader already watched arrive", () => {
		const store = new StreamAnimStore();
		const visit1 = rowExtra("n1", 1);
		// Visit 1: the mount seals, then two deltas the reader watches fade in.
		frame(store, visit1, 0, "开头", 1_000);
		expect(frame(store, visit1, 0, "开头第一段", 1_016)).toBeGreaterThan(0);

		// The reader switches away for 30s. The stream keeps going, and on return the
		// `streaming_snapshot` delivers the WHOLE accumulated body in one frame.
		const visit2 = rowExtra("n1", 2);
		const caughtUp = `开头第一段${"后来输出的内容".repeat(40)}`;
		expect(frame(store, visit2, 0, caughtUp, 31_000)).toBe(0);
	});

	it("does not fade a block produced entirely while away", () => {
		const store = new StreamAnimStore();
		const visit1 = rowExtra("n1", 1);
		frame(store, visit1, 0, "第一段", 1_000);

		// A paragraph that was born AND finished during the absence arrives fully
		// formed under a key this mount has never seen. Under the old scope it was a
		// warm-scope first sighting, i.e. a live birth: boundary 0, whole block faded.
		const visit2 = rowExtra("n1", 2);
		const bornAway = "整段都在离开期间输出完了。".repeat(10);
		expect(frame(store, visit2, 1, bornAway, 31_000)).toBe(0);
	});

	it("still fades the deltas that arrive AFTER the reader is back", () => {
		// The seal must be one frame, not a permanent opt-out: live typing the reader
		// is now watching has to animate, or coming back kills the fade for the rest of
		// the turn.
		const store = new StreamAnimStore();
		const visit2 = rowExtra("n1", 2);
		const caughtUp = "回来时已经有的内容";
		expect(frame(store, visit2, 0, caughtUp, 31_000)).toBe(0);
		expect(frame(store, visit2, 0, `${caughtUp}新来的字`, 31_016)).toBeGreaterThan(0);
	});

	it("still fades a NEW paragraph born after the reader is back", () => {
		// The warm-scope live-birth behaviour must survive within a mount — that is the
		// fix that stopped new paragraphs popping in.
		const store = new StreamAnimStore();
		const visit2 = rowExtra("n1", 2);
		frame(store, visit2, 0, "回来时已经有的内容", 31_000);
		expect(frame(store, visit2, 1, "新段落", 31_016)).toBeGreaterThan(0);
	});

	it("keeps two narrators independent within one mount generation", () => {
		// Scopes are compared exactly, so `n1#2` must not warm off `n2#2`.
		const store = new StreamAnimStore();
		frame(store, rowExtra("n2", 2), 0, "另一个叙述者的正文", 1_000);
		expect(frame(store, rowExtra("n1", 2), 0, "本叙述者的首帧", 1_016)).toBe(0);
	});
});
