import { describe, expect, test } from "bun:test";
import { buildPretextLayoutIndex, restorePretextLayoutAnchor } from "@shared/pretext-layout";
import { captureCoordinatorAnchor } from "./pretext-layout-coordinator";
import { sliceBracketedRegion } from "./source-slice";
import type { PretextDocumentView } from "./usePretextDocument";
import { createVListVisibleViewport, hasVisibleVListGeometry } from "./vlist-visible-viewport";

function viewport() {
	let hidden = false;
	let top = 800;
	let height = 4000;
	const writes: number[] = [];
	const node = {
		get offsetWidth() {
			return hidden ? 0 : 800;
		},
		get clientHeight() {
			return hidden ? 0 : 400;
		},
		get scrollHeight() {
			if (hidden) throw new Error("hidden scrollHeight must not be read");
			return height;
		},
		get scrollTop() {
			if (hidden) throw new Error("hidden scrollTop must not be read");
			return top;
		},
		set scrollTop(value: number) {
			if (hidden) throw new Error("hidden scrollTop must not be written");
			top = Math.max(0, Math.min(value, height - 400));
			writes.push(top);
		},
	};
	return {
		node,
		writes,
		hide: () => {
			hidden = true;
		},
		show: (nextHeight = height) => {
			height = nextHeight;
			hidden = false;
		},
		write: (value: number) => {
			node.scrollTop = value;
		},
	};
}

function layout(headGrowth = 0, tailGrowth = 0) {
	return buildPretextLayoutIndex({
		layoutRevision: `visible:${headGrowth}:${tailGrowth}`,
		documentRevision: "visible",
		lod: 5,
		widthBucket: "800",
		metrics: { topPadding: 16, itemGap: 4, bottomPadding: 16 },
		items: Array.from({ length: 30 }, (_, i) => ({
			itemKey: `item-${i}`,
			firstSeq: i,
			lastSeq: i,
			sourceMessageIds: [`message-${i}`],
			kind: "markdown",
			height: 120 + (i === 0 ? headGrowth : 0) + (i === 29 ? tailGrowth : 0),
		})),
	});
}

const historyView: PretextDocumentView = {
	scrollTop: 800,
	viewportHeight: 400,
	pinnedToBottom: false,
};

describe("parked vlist viewport", () => {
	test("production gates scroll classification and writes, and resumes before resize preview", async () => {
		const source = await Bun.file(new URL("./PretextExactMessageList.tsx", import.meta.url)).text();
		const region = (anchor: string) => {
			const result = sliceBracketedRegion(source, anchor);
			if (result === null) throw new Error(`Missing production region: ${anchor}`);
			return result;
		};
		for (const [anchor, unsafeRead] of [
			["const processScrollFrame = useCallback(", "const previousTop ="],
			["const writeScrollTopCore = useCallback(", "node.scrollTop = target"],
		]) {
			const callback = region(anchor);
			const guard = callback.indexOf("!visibleViewportRef.current.isVisible(node)");
			expect(guard).toBeGreaterThan(-1);
			expect(callback.indexOf(unsafeRead)).toBeGreaterThan(guard);
		}
		const correction = region("const onScrollTopCorrection = useCallback(");
		expect(correction).toContain("visibleViewportRef.current.deferCorrection(");
		expect(correction).toContain("readViewportView()");
		const measure = region("const measure = () => {");
		expect(measure).toContain("visibleViewportRef.current.isVisible(node)");
		const replay = measure.indexOf("visibleViewportRef.current.resume(");
		expect(replay).toBeGreaterThan(-1);
		expect(measure.indexOf("controller.observe()")).toBeGreaterThan(replay);
	});

	test("a hidden pending scroll frame cannot pin history; semantic corrections survive restoration and streaming", () => {
		const box = viewport();
		const visible = createVListVisibleViewport();
		let pinned = false;
		const fallback = () => ({ ...historyView, pinnedToBottom: pinned });
		expect(visible.read(box.node, fallback(), false)).toEqual(historyView);

		// Queue while visible, execute after the stable host parks in display:none.
		const queuedScrollFrame = () => {
			if (!visible.isVisible(box.node)) return;
			pinned = visible.read(box.node, fallback(), false).pinnedToBottom;
		};
		box.hide();
		queuedScrollFrame();
		expect(pinned).toBe(false);
		expect(visible.read(box.node, fallback(), false)).toEqual(historyView);

		let index = layout();
		for (const headGrowth of [80, 140]) {
			// These are the real document coordinator's capture/restore functions,
			// fed by the same production view/deferred-correction helper as the shell.
			const view = visible.read(box.node, fallback(), false);
			const anchor = captureCoordinatorAnchor(index, view);
			expect(anchor.kind).toBe("item");
			index = layout(headGrowth);
			const corrected = restorePretextLayoutAnchor(anchor, index, view.viewportHeight);
			expect(corrected).toBe(800 + headGrowth);
			visible.deferCorrection(corrected, anchor.kind, view);
			// A hidden observer must not consume the queued correction.
			visible.resume(box.node, pinned, box.write);
			expect(box.writes).toEqual([]);
		}
		expect(visible.read(box.node, fallback(), false).scrollTop).toBe(940);
		box.show(index.totalHeight);
		// Observer/scroll recovery replays BEFORE any new geometry classification.
		visible.resume(box.node, pinned, box.write);
		expect(box.writes).toEqual([940]);
		visible.resume(box.node, pinned, box.write);
		expect(box.writes).toEqual([940]);
		const restored = visible.read(box.node, fallback(), false);
		expect(restored).toEqual({ ...historyView, scrollTop: 940 });

		const streaming = layout(140, 700);
		const anchor = captureCoordinatorAnchor(index, restored);
		expect(anchor.kind).toBe("item");
		expect(restorePretextLayoutAnchor(anchor, streaming, restored.viewportHeight)).toBe(940);
		expect(940).toBeLessThan(streaming.totalHeight - restored.viewportHeight);
		expect(pinned).toBe(false);
	});

	test("hidden reads retain the last visible pin decision rather than a stale React fallback", () => {
		const box = viewport();
		const visible = createVListVisibleViewport();
		const staleFallback = { ...historyView, pinnedToBottom: true };
		expect(visible.read(box.node, staleFallback, false)).toEqual(historyView);
		box.hide();
		expect(visible.read(box.node, staleFallback, false)).toEqual(historyView);
	});

	test("parking without semantic changes preserves the visible scroll position", () => {
		const box = viewport();
		const visible = createVListVisibleViewport();
		visible.read(box.node, historyView, false);
		box.hide();
		expect(visible.isVisible(box.node)).toBe(false);
		box.show();
		visible.resume(box.node, false, box.write);
		expect(box.writes).toEqual([800]);
	});

	test("a deferred bottom correction uses the restored box and latest footer, not a zero target", () => {
		const box = viewport();
		const visible = createVListVisibleViewport();
		const pinned = { ...historyView, pinnedToBottom: true };
		visible.read(box.node, pinned, true); // mid-chase is still bottom-pinned
		box.hide();
		expect(visible.read(box.node, pinned, false).pinnedToBottom).toBe(true);
		visible.deferCorrection(3600, "bottom", pinned);
		box.show(5300); // stream + footer grew while hidden
		visible.resume(box.node, true, box.write);
		expect(box.writes).toEqual([4900]);
	});

	test("explicit detach while hidden cancels a deferred bottom target without losing history", () => {
		const box = viewport();
		const visible = createVListVisibleViewport();
		const pinned = { ...historyView, pinnedToBottom: true };
		visible.read(box.node, pinned, true);
		box.hide();
		visible.deferCorrection(3600, "bottom", pinned);
		visible.setPinned(false);
		expect(visible.read(box.node, historyView, false)).toEqual(historyView);
		box.show(5300);
		visible.resume(box.node, false, box.write);
		expect(box.writes).toEqual([800]);
	});

	test("an explicit hidden bottom request supersedes an older item correction", () => {
		const box = viewport();
		const visible = createVListVisibleViewport();
		visible.read(box.node, historyView, false);
		box.hide();
		visible.deferCorrection(940, "item", historyView);
		visible.deferCorrection(0, "bottom", { ...historyView, pinnedToBottom: true });
		box.show(5300);
		visible.resume(box.node, true, box.write);
		expect(box.writes).toEqual([4900]);
	});

	test("unmeasured/zero-width/zero-height boxes never become reading geometry", () => {
		const visible = createVListVisibleViewport();
		for (const node of [
			null,
			{ offsetWidth: 0, clientHeight: 400 },
			{ offsetWidth: 800, clientHeight: 0 },
		]) {
			const box = node && { ...node, scrollTop: 0, scrollHeight: 0 };
			expect(hasVisibleVListGeometry(box)).toBe(false);
			expect(visible.isVisible(box)).toBe(false);
			expect(visible.read(box, historyView, false)).toEqual(historyView);
		}
	});
});
