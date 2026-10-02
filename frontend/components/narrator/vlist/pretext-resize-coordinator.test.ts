import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { PretextDocumentPageResult, TreeMessage } from "@frontend/lib/api/types";
import { restorePretextLayoutAnchor } from "@shared/pretext-layout";
import type { NarratorMsg } from "../narrator-panel-types";
import { installCanvasStub } from "./measure/test-canvas-stub";
import { buildPretextDocumentLayout } from "./pretext-document-layout";
import type { PretextDocumentFetchPage } from "./pretext-document-loader";
import {
	captureCoordinatorAnchor,
	type PrependView,
	type PretextLayoutBuildOptions,
	PretextLayoutCoordinator,
	type PretextLayoutCoordinatorSnapshot,
} from "./pretext-layout-coordinator";
import { projectStreamingDocument } from "./streaming-handoff";
import { indexWithHeightOverrides } from "./vlist-resize-preview";

let disposeCanvas: () => void;
let fixtureId = 0;
beforeAll(() => {
	disposeCanvas = installCanvasStub();
});
afterAll(() => disposeCanvas());

const BUILD: PretextLayoutBuildOptions = Object.freeze({
	lod: 5,
	widthBucket: "860",
	contentWidth: 860,
	viewportHeight: 260,
	topPadding: 16,
	bottomPadding: 24,
	gap: 4,
	segmentGap: 28,
});
const topView = (): PrependView => ({
	scrollTop: 0,
	viewportHeight: 260,
	pinnedToBottom: false,
});

function message(narratorId: string, seq: number, text: string): TreeMessage {
	return {
		id: `${narratorId}-m${seq}`,
		narratorId,
		parentToolUseId: null,
		role: "assistant",
		contentJson: [{ type: "text", text }],
		contentText: text,
		toolCalls: [],
		createdAt: "2026-08-01T00:00:00.000Z",
		children: [],
		seq,
	};
}

/** Actual cursor/limit transport contract, not a pre-constructed coordinator snapshot. */
function pageAPI(
	count = 100,
	text = "An actual historical response that wraps at narrow widths. ".repeat(8),
) {
	const narratorId = `resize-coordinator-${++fixtureId}`;
	const messageVersion = fixtureId;
	const messages = Array.from({ length: count }, (_, seq) => message(narratorId, seq, text));
	const requests: Parameters<PretextDocumentFetchPage>[1][] = [];
	const fetchPage: PretextDocumentFetchPage = async (id, options) => {
		expect(id).toBe(narratorId);
		requests.push({ ...options });
		const eligible = messages.filter((row) =>
			options.beforeSeq != null
				? (row.seq ?? -1) < options.beforeSeq
				: options.afterSeq != null
					? (row.seq ?? -1) > options.afterSeq
					: true,
		);
		const rows =
			options.afterSeq != null ? eligible.slice(0, options.limit) : eligible.slice(-options.limit);
		const minSeq = rows[0]?.seq ?? null;
		const maxSeq = rows.at(-1)?.seq ?? null;
		return {
			messages: rows,
			messageVersion,
			minSeq,
			maxSeq,
			hasPrev: minSeq != null && minSeq > 0,
			hasNext: maxSeq != null && maxSeq < count - 1,
		} satisfies PretextDocumentPageResult;
	};
	return { narratorId, messages, requests, fetchPage };
}

function fetchGate() {
	let release: () => void = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

async function loaded(api = pageAPI(), build = BUILD) {
	const coordinator = new PretextLayoutCoordinator();
	await coordinator.load(api.narratorId, build, { fetchPage: api.fetchPage }, undefined, 260);
	for (let page = 0; coordinator.getSnapshot().hasPrev && page < 10; page++) {
		await coordinator.loadOlder(build, topView);
	}
	expect(coordinator.getSnapshot().input?.messages).toHaveLength(api.messages.length);
	return { coordinator, api };
}

function ready(coordinator: PretextLayoutCoordinator, status: "ready" | "loading" = "ready") {
	const snapshot = coordinator.getSnapshot();
	if (
		snapshot.status !== status ||
		!snapshot.index ||
		!snapshot.items ||
		!snapshot.manifest ||
		!snapshot.input
	)
		throw new Error("expected a complete real layout");
	return {
		...snapshot,
		index: snapshot.index,
		items: snapshot.items,
		manifest: snapshot.manifest,
		input: snapshot.input,
	};
}

function layoutGeometry(snapshot: ReturnType<typeof ready>) {
	return {
		manifest: structuredClone(snapshot.manifest),
		messages: structuredClone(snapshot.input.messages),
		streamingMessage: structuredClone(snapshot.streamingMessage ?? null),
		starts: [...snapshot.index.itemStarts],
		ends: [...snapshot.index.itemEnds],
		totalHeight: snapshot.index.totalHeight,
		frames: snapshot.items.map((item) => ({
			key: item.spec.key,
			kind: item.spec.kind,
			width: item.contentWidth,
			height: item.measured.height,
		})),
	};
}

/** Independent complete build through segmentation, adaptation, measures and source indexing. */
function expectFullBuild(snapshot: ReturnType<typeof ready>, build: PretextLayoutBuildOptions) {
	const messages = projectStreamingDocument(
		snapshot.input.messages,
		snapshot.streamingMessage ?? null,
	);
	const full = buildPretextDocumentLayout(messages as NarratorMsg[], {
		...build,
		layoutRevision: snapshot.manifest.layoutRevision,
		documentRevision: snapshot.manifest.documentRevision,
	});
	expect(snapshot.manifest).toEqual(full.manifest);
	expect(snapshot.index.itemStarts).toEqual(full.index.itemStarts);
	expect(snapshot.index.itemEnds).toEqual(full.index.itemEnds);
	expect(snapshot.index.totalHeight).toBe(full.index.totalHeight);
	expect(snapshot.items.map((item) => item.spec)).toEqual(full.items.map((item) => item.spec));
	expect(snapshot.items.map((item) => item.measured)).toEqual(
		full.items.map((item) => item.measured),
	);
	expect(snapshot.items.every((item) => item.contentWidth === build.contentWidth)).toBe(true);
	expect(snapshot.semanticItems).toBe(snapshot.items);
	expect(snapshot.semanticManifest).toBe(snapshot.manifest);
}

function tailView(snapshot: ReturnType<typeof ready>): PrependView {
	return {
		scrollTop: snapshot.index.totalHeight - 260,
		viewportHeight: 260,
		pinnedToBottom: true,
	};
}

describe("coordinator width previews with the real paginated document API", () => {
	it("publishes only ready local frames, keeps old snapshots and committed global options intact", async () => {
		const { coordinator, api } = await loaded();
		const old = ready(coordinator);
		const saved = layoutGeometry(old);
		const states: PretextLayoutCoordinatorSnapshot[] = [];
		const unsubscribe = coordinator.subscribe(() => states.push(coordinator.getSnapshot()));
		coordinator.previewWidth(420, topView);
		const local = ready(coordinator);
		expect(states.map((state) => state.status)).toEqual(["ready"]);
		expect(local.resizePreview).toBe(true);
		expect(local.resizeWidth).toBe(420);
		expect(local.resizeMeasuredCount).toBeGreaterThan(0);
		expect(local.resizeMeasuredCount).toBeLessThanOrEqual(64);
		expect(local.manifest.widthBucket).toBe("860");
		expect(local.input).toBe(old.input);
		expect(old.semanticItems).toBe(old.items);
		expect(old.semanticManifest).toBe(old.manifest);
		expect(local.semanticItems).toBe(old.items);
		expect(local.semanticManifest).toBe(old.manifest);
		expect(local.resizeRevision).toBeGreaterThan(old.resizeRevision ?? 0);
		expect(local.items.at(-1)).toBe(old.items.at(-1));
		expect(layoutGeometry(old)).toEqual(saved);
		// An out-of-band semantic build must still use the global, committed 860px options.
		const next = message(api.narratorId, 100, "a newly persisted tail message");
		expect(coordinator.upsertMessage(next, false, topView)).toBe(true);
		const semantic = ready(coordinator);
		expect(semantic.resizePreview).toBeUndefined();
		expect(semantic.manifest.widthBucket).toBe("860");
		expectFullBuild(semantic, BUILD);
		expect(BUILD.contentWidth).toBe(860);
		expect(layoutGeometry(old)).toEqual(saved);
		unsubscribe();
	});

	it("emits a new resize revision at a different width even when all affected heights stay equal", async () => {
		const { coordinator } = await loaded(pageAPI(100, "short"));
		const initial = ready(coordinator);
		coordinator.previewWidth(700, topView);
		const first = ready(coordinator);
		coordinator.previewWidth(600, topView);
		const second = ready(coordinator);
		expect(first.index).toBe(initial.index);
		expect(second.index).toBe(first.index);
		expect(second.resizeRevision).toBeGreaterThan(first.resizeRevision ?? 0);
		expect(second.resizeWidth).toBe(600);
		expect(second.items[0]?.measured.height).toBe(first.items[0]?.measured.height);
		expect(second.items[0]?.measured).not.toBe(first.items[0]?.measured);
		expect(second.items[0]?.contentWidth).toBe(600);
		expect(second.items.at(-1)).toBe(initial.items.at(-1));
		const settledPreview = coordinator.getSnapshot();
		expect(coordinator.previewWidth(600, topView)).toBe(false);
		expect(coordinator.getSnapshot()).toBe(settledPreview);
	});

	it("publishes an unmeasured display target without replaying a stale scroll correction", async () => {
		const { coordinator } = await loaded();
		coordinator.previewWidth(420, topView);
		const mixed = ready(coordinator);
		const view = { ...topView(), scrollTop: mixed.index.itemStart(70) + 13 };
		const states: PretextLayoutCoordinatorSnapshot[] = [];
		coordinator.subscribe(() => states.push(coordinator.getSnapshot()));
		expect(coordinator.previewWidth(860, () => view)).toBe(false);
		const returned = coordinator.getSnapshot();
		expect(returned.resizeWidth).toBe(860);
		expect(returned.resizeMeasuredCount).toBe(0);
		expect(returned.resizeRevision).toBeGreaterThan(mixed.resizeRevision ?? 0);
		expect(returned.index).toBe(mixed.index);
		expect(returned.items).toBe(mixed.items);
		expect(returned.semanticItems).toBe(mixed.semanticItems);
		expect(returned.semanticManifest).toBe(mixed.semanticManifest);
		expect(returned.scrollTop).toBeUndefined();
		expect(states).toHaveLength(1);
		expect(coordinator.previewWidth(860, () => view)).toBe(false);
		expect(coordinator.getSnapshot()).toBe(returned);
		expect(states).toHaveLength(1);
	});

	it("publishes empty-document/footer display widths once, with no measured rows", async () => {
		const { coordinator } = await loaded(pageAPI(0));
		const initial = ready(coordinator);
		const view = { scrollTop: 0, viewportHeight: 260, pinnedToBottom: true };
		const states: PretextLayoutCoordinatorSnapshot[] = [];
		coordinator.subscribe(() => states.push(coordinator.getSnapshot()));
		coordinator.previewWidth(420, () => view);
		const narrow = coordinator.getSnapshot();
		expect(narrow.resizeWidth).toBe(420);
		expect(narrow.resizeMeasuredCount).toBe(0);
		expect(narrow.items).toBe(initial.items);
		expect(narrow.scrollTop).toBeUndefined();
		coordinator.previewWidth(420, () => view);
		expect(coordinator.getSnapshot()).toBe(narrow);
		coordinator.previewWidth(860, () => view);
		expect(ready(coordinator).resizeWidth).toBe(860);
		expect(states).toHaveLength(2);
	});

	for (const targetWidth of [860, 420]) {
		it(`reads LIVE older-page overrides and restores only ${targetWidth}px heights with gaps`, async () => {
			const build = { ...BUILD, contentWidth: targetWidth, widthBucket: String(targetWidth) };
			const api = pageAPI();
			const gate = fetchGate();
			const fetchPage: PretextDocumentFetchPage = async (id, options) => {
				if (options.beforeSeq != null) await gate.promise;
				return api.fetchPage(id, options);
			};
			const coordinator = new PretextLayoutCoordinator();
			await coordinator.load(api.narratorId, build, { fetchPage }, undefined, 260);
			const initial = ready(coordinator);
			const offscreen = initial.items[0];
			if (!offscreen) throw new Error("missing offscreen row");
			let overrides = new Map([[offscreen.spec.key, 300]]);
			let reads = 0;
			let view = { ...topView(), scrollTop: initial.index.itemStart(15) + 7 };
			const pending = coordinator.loadOlder(
				build,
				() => view,
				() => {
					reads++;
					return overrides;
				},
			);
			expect(reads).toBe(0);
			coordinator.previewWidth(targetWidth / 2, () => view);
			const preview = ready(coordinator);
			expect(preview.items[0]?.contentWidth).toBe(targetWidth);
			const changedIndex = preview.items.findIndex((item) => item.contentWidth !== targetWidth);
			expect(changedIndex).toBeGreaterThan(0);
			const changed = preview.items[changedIndex];
			if (!changed) throw new Error("missing resized row");
			// Reports received DURING the await must beat the fetch-time map.
			overrides = new Map([
				[offscreen.spec.key, 2000],
				[changed.spec.key, 900],
			]);
			const effective = indexWithHeightOverrides(preview.index, overrides);
			view = { ...view, scrollTop: effective.itemStart(changedIndex + 2) + 13 };
			const anchor = captureCoordinatorAnchor(effective, view);
			expect(anchor).not.toEqual(captureCoordinatorAnchor(preview.index, view));
			gate.release();
			expect(await pending).toBe(60);
			const committed = ready(coordinator);
			const restoreOverrides = new Map([[offscreen.spec.key, 2000]]);
			const restoredIndex = indexWithHeightOverrides(committed.index, restoreOverrides);
			expect(reads).toBe(1);
			expect(committed.scrollTop).toBe(restorePretextLayoutAnchor(anchor, restoredIndex, 260));
			expect(committed.scrollTop).not.toBe(
				restorePretextLayoutAnchor(anchor, committed.index, 260),
			);
			expect(committed.scrollTop).not.toBe(
				restorePretextLayoutAnchor(
					anchor,
					indexWithHeightOverrides(committed.index, overrides),
					260,
				),
			);
			const index = committed.index.itemByKey(offscreen.spec.key)?.index;
			if (index == null) throw new Error("missing retained row");
			expect(restoredIndex.manifest.items[index]?.gapAfter).toBe(
				committed.manifest.items[index]?.gapAfter,
			);
			expect(restoredIndex.itemStart(index + 1) - restoredIndex.itemEnd(index)).toBe(
				committed.index.itemStart(index + 1) - committed.index.itemEnd(index),
			);
			expectFullBuild(committed, build);
		});
	}

	for (const finalWidth of [420, 860]) {
		for (const pinnedToBottom of [false, true]) {
			it(`forces a full finish at ${finalWidth === 420 ? "the last preview width" : "the original width"}, ${pinnedToBottom ? "pinned" : "unpinned"}`, async () => {
				const { coordinator, api } = await loaded();
				let view = topView();
				coordinator.previewWidth(420, () => view);
				let preview = ready(coordinator);
				// Keep multiple width histories, including a different off-screen region.
				view = {
					scrollTop: preview.index.itemStart(50),
					viewportHeight: 260,
					pinnedToBottom: false,
				};
				coordinator.previewWidth(600, () => view);
				preview = ready(coordinator);
				view = pinnedToBottom
					? { ...tailView(preview), scrollTop: preview.index.totalHeight - 260 - 11 }
					: {
							scrollTop: preview.index.itemStart(20) + 7,
							viewportHeight: 260,
							pinnedToBottom: false,
						};
				coordinator.previewWidth(420, () => view);
				preview = ready(coordinator);
				view = { ...view, scrollTop: preview.scrollTop ?? view.scrollTop };
				if (finalWidth === 860) {
					coordinator.previewWidth(860, () => view);
					preview = ready(coordinator);
					view = { ...view, scrollTop: preview.scrollTop ?? view.scrollTop };
				}
				expect(preview.resizeWidth).toBe(finalWidth);
				expect(new Set(preview.items.map((item) => item.contentWidth)).size).toBeGreaterThan(1);
				const overrideKey = preview.items[20]?.spec.key ?? "";
				const overrides = new Map([[overrideKey, 450]]);
				const anchor = captureCoordinatorAnchor(
					indexWithHeightOverrides(preview.index, overrides),
					view,
				);
				const saved = layoutGeometry(preview);
				const states: string[] = [];
				coordinator.subscribe(() => states.push(coordinator.getSnapshot().status));
				const build = { ...BUILD, contentWidth: finalWidth, widthBucket: String(finalWidth) };
				coordinator.finishResize(build, view, overrides);
				const finished = ready(coordinator);
				expect(states).toEqual(["computing", "ready"]);
				expect(finished.items).not.toBe(preview.items);
				expect(finished.resizePreview).toBeUndefined();
				expect(finished.resizeWidth).toBeUndefined();
				expect(finished.scrollTopAnchorKind).toBe(anchor.kind);
				const targetOverrides =
					preview.items[20]?.contentWidth === finalWidth ? overrides : undefined;
				expect(finished.scrollTop).toBe(
					restorePretextLayoutAnchor(
						anchor,
						indexWithHeightOverrides(finished.index, targetOverrides),
						260,
					),
				);
				expectFullBuild(finished, build);
				const { coordinator: fresh } = await loaded(api, build);
				expect(layoutGeometry(finished)).toEqual(layoutGeometry(ready(fresh)));
				expect(layoutGeometry(preview)).toEqual(saved);
			});
		}
	}

	it("replaces a preview on canonical upsert and previews the latest segmented specs", async () => {
		const { coordinator, api } = await loaded();
		const original = api.messages[0];
		if (!original) throw new Error("fixture message missing");
		coordinator.previewWidth(420, topView);
		const old = ready(coordinator);
		const saved = layoutGeometry(old);
		const updated: TreeMessage = {
			...original,
			contentJson: [
				{ type: "reasoning", text: "The new canonical reasoning." },
				{ type: "text", text: "Latest canonical response with changed segmentation. ".repeat(12) },
			],
		};
		expect(coordinator.upsertMessage(updated, false, topView)).toBe(true);
		const semantic = ready(coordinator);
		expect(semantic.resizePreview).toBeUndefined();
		expect(semantic.input.messages[0]?.contentJson).toEqual(updated.contentJson);
		expectFullBuild(semantic, BUILD);
		coordinator.previewWidth(420, topView);
		const next = ready(coordinator);
		const indices = next.index.itemIndicesForSourceMessageId(original.id);
		expect(indices.length).toBeGreaterThan(1);
		expect(indices.map((i) => next.items[i]?.spec.kind)).toEqual(["reasoning", "markdown"]);
		for (const i of indices) {
			expect(next.items[i]?.spec).toBe(semantic.items[i]?.spec);
			expect(next.items[i]?.contentWidth).toBe(420);
		}
		expect(next.resizeRevision).toBeGreaterThan(old.resizeRevision ?? 0);
		expect(layoutGeometry(old)).toEqual(saved);
	});

	it("clears previews on streaming updates and measures the latest live body on the next frame", async () => {
		const { coordinator, api } = await loaded();
		const live = (text: string): TreeMessage => ({
			...message(api.narratorId, 999_999, text),
			id: "__streaming__",
			contentText: null,
			contentJson: [{ type: "text", id: "streaming:text:0", text }],
		});
		coordinator.setStreamingMessage(live("short"), () => tailView(ready(coordinator)));
		coordinator.previewWidth(420, () => tailView(ready(coordinator)));
		const old = ready(coordinator);
		const saved = layoutGeometry(old);
		const nextLive = live("Growing live output must be the latest measured spec. ".repeat(40));
		expect(coordinator.setStreamingMessage(nextLive, () => tailView(ready(coordinator)))).toBe(
			true,
		);
		const semantic = ready(coordinator);
		expect(semantic.resizePreview).toBeUndefined();
		expect(semantic.streamingMessage).toBe(nextLive);
		expect(semantic.input.messages).toHaveLength(api.messages.length);
		expectFullBuild(semantic, BUILD);
		coordinator.previewWidth(420, () => tailView(ready(coordinator)));
		const next = ready(coordinator);
		const indices = next.index.itemIndicesForSourceMessageId("__streaming__");
		expect(indices.length).toBeGreaterThan(0);
		for (const i of indices) {
			expect(next.items[i]?.spec).toBe(semantic.items[i]?.spec);
			expect(next.items[i]?.contentWidth).toBe(420);
		}
		expect(next.items.at(-1)?.measured.height).toBeGreaterThan(
			old.items.at(-1)?.measured.height ?? 0,
		);
		expect(layoutGeometry(old)).toEqual(saved);
		expect(coordinator.setStreamingMessage(null, topView)).toBe(true);
		expect(ready(coordinator).resizePreview).toBeUndefined();
	});

	it("clears a preview on font invalidation and previews newly prepared blocks", async () => {
		const { coordinator } = await loaded();
		coordinator.previewWidth(420, topView);
		const old = ready(coordinator);
		const saved = layoutGeometry(old);
		expect(coordinator.invalidateFontDependentLayout(topView)).toBe(true);
		const rebuilt = ready(coordinator);
		expect(rebuilt.resizePreview).toBeUndefined();
		expect(rebuilt.items[0]?.measured).not.toBe(old.items[0]?.measured);
		expectFullBuild(rebuilt, BUILD);
		coordinator.previewWidth(420, topView);
		const next = ready(coordinator);
		expect(next.items[0]?.spec).toBe(rebuilt.items[0]?.spec);
		expect(next.items[0]?.measured).not.toBe(old.items[0]?.measured);
		expect(next.items[0]?.contentWidth).toBe(420);
		expect(next.resizeRevision).toBeGreaterThan(old.resizeRevision ?? 0);
		expect(layoutGeometry(old)).toEqual(saved);
	});

	it("reset drops the mixed-width snapshot; reloading previews only the new document", async () => {
		const { coordinator } = await loaded();
		coordinator.previewWidth(420, topView);
		const old = ready(coordinator);
		const saved = layoutGeometry(old);
		coordinator.reset();
		expect(coordinator.getSnapshot()).toEqual({ status: "idle" });
		expect(coordinator.previewWidth(420, topView)).toBe(false);
		const nextAPI = pageAPI(12, "The new narrator's current document. ".repeat(8));
		await coordinator.load(nextAPI.narratorId, BUILD, { fetchPage: nextAPI.fetchPage });
		const initial = ready(coordinator);
		expect(initial.resizePreview).toBeUndefined();
		coordinator.previewWidth(420, topView);
		const next = ready(coordinator);
		expect(next.resizePreview).toBe(true);
		expect(next.input.messages).toEqual(nextAPI.messages);
		expect(next.items[0]?.spec).toBe(initial.items[0]?.spec);
		expect(next.items[0]?.contentWidth).toBe(420);
		expect(next.items.every((item) => item.spec.key.startsWith(nextAPI.narratorId))).toBe(true);
		expect(layoutGeometry(old)).toEqual(saved);
	});

	it("preview during an in-flight older page keeps the page and the live item anchor", async () => {
		const api = pageAPI();
		let release: () => void = () => {
			throw new Error("page gate not installed");
		};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const fetchPage: PretextDocumentFetchPage = async (id, options) => {
			if (options.beforeSeq != null) await gate;
			return api.fetchPage(id, options);
		};
		const coordinator = new PretextLayoutCoordinator();
		await coordinator.load(api.narratorId, BUILD, { fetchPage }, undefined, 260);
		const initial = ready(coordinator);
		expect(initial.input.messages).toHaveLength(40);
		let view: PrependView = {
			scrollTop: initial.index.itemStart(5) + 7,
			viewportHeight: 260,
			pinnedToBottom: false,
		};
		const pending = coordinator.loadOlder(BUILD, () => view);
		expect(coordinator.getSnapshot().loadingOlder).toBe(true);
		coordinator.previewWidth(420, () => view);
		const local = ready(coordinator);
		expect(local.resizePreview).toBe(true);
		expect(local.loadingOlder).toBe(true);
		view = { ...view, scrollTop: local.scrollTop ?? view.scrollTop };
		const anchor = captureCoordinatorAnchor(local.index, view);
		const saved = layoutGeometry(local);
		release();
		expect(await pending).toBe(60);
		const committed = ready(coordinator);
		expect(api.requests).toHaveLength(2);
		expect(api.requests[1]?.beforeSeq).toBe(60);
		expect(committed.input.messages).toEqual(api.messages);
		expect(committed.loadingOlder).toBe(false);
		expect(committed.resizePreview).toBeUndefined();
		expectFullBuild(committed, BUILD);
		expect(committed.scrollTop).toBe(restorePretextLayoutAnchor(anchor, committed.index, 260));
		coordinator.previewWidth(420, topView);
		expect(ready(coordinator).items[0]?.spec).toBe(committed.items[0]?.spec);
		expect(ready(coordinator).items[0]?.contentWidth).toBe(420);
		expect(layoutGeometry(local)).toEqual(saved);
	});

	for (const finalWidth of [420, 860]) {
		it(`keeps the older fetch through finish at ${finalWidth} and restores the latest live anchor`, async () => {
			const api = pageAPI();
			const gate = fetchGate();
			let fetches = 0;
			const fetchPage: PretextDocumentFetchPage = async (id, options) => {
				fetches++;
				if (options.beforeSeq != null) await gate.promise;
				return api.fetchPage(id, options);
			};
			const coordinator = new PretextLayoutCoordinator();
			await coordinator.load(api.narratorId, BUILD, { fetchPage }, undefined, 260);
			const initial = ready(coordinator);
			const saved = layoutGeometry(initial);
			let view = { ...topView(), scrollTop: initial.index.itemStart(5) + 7 };
			const pending = coordinator.loadOlder(BUILD, () => view);
			coordinator.previewWidth(420, () => view);
			view = { ...view, scrollTop: coordinator.getSnapshot().scrollTop ?? view.scrollTop };
			const build = { ...BUILD, contentWidth: finalWidth, widthBucket: String(finalWidth) };
			coordinator.finishResize(build, view);
			const finished = ready(coordinator);
			expect(finished.resizePreview).toBeUndefined();
			expect(finished.resizeWidth).toBeUndefined();
			expect(finished.resizeMeasuredCount).toBeUndefined();
			expect(finished.loadingOlder).toBe(true);
			expectFullBuild(finished, build);
			// Momentum scroll after finish must win over both fetch-time and finish-time views.
			view = { ...view, scrollTop: finished.index.itemStart(8) + 13 };
			const anchor = captureCoordinatorAnchor(finished.index, view);
			gate.release();
			expect(await pending).toBe(60);
			const committed = ready(coordinator);
			expect(fetches).toBe(2);
			expect(committed.input.messages).toEqual(api.messages);
			expect(committed.loadingOlder).toBe(false);
			expect(committed.resizeRevision).toBeGreaterThan(finished.resizeRevision ?? 0);
			expect(committed.scrollTop).toBe(restorePretextLayoutAnchor(anchor, committed.index, 260));
			expectFullBuild(committed, build);
			expect(layoutGeometry(initial)).toEqual(saved);
		});
	}

	it("settles a width-only finish without a preview while keeping an older page alive", async () => {
		const api = pageAPI();
		const gate = fetchGate();
		const fetchPage: PretextDocumentFetchPage = async (id, options) => {
			if (options.beforeSeq != null) await gate.promise;
			return api.fetchPage(id, options);
		};
		const coordinator = new PretextLayoutCoordinator();
		await coordinator.load(api.narratorId, BUILD, { fetchPage }, undefined, 260);
		let view = { ...topView(), scrollTop: ready(coordinator).index.itemStart(5) + 7 };
		const pending = coordinator.loadOlder(BUILD, () => view);
		const build = { ...BUILD, contentWidth: 420, widthBucket: "420" };
		coordinator.finishResize(build, view);
		const finished = ready(coordinator);
		view = { ...view, scrollTop: finished.scrollTop ?? view.scrollTop };
		const anchor = captureCoordinatorAnchor(finished.index, view);
		gate.release();
		expect(await pending).toBe(60);
		const committed = ready(coordinator);
		expect(committed.scrollTop).toBe(restorePretextLayoutAnchor(anchor, committed.index, 260));
		expectFullBuild(committed, build);
	});

	for (const pinnedToBottom of [false, true]) {
		it(`previews and finishes a gated background reload without discarding its result (${pinnedToBottom ? "pinned" : "item"})`, async () => {
			const api = pageAPI();
			const coordinator = new PretextLayoutCoordinator();
			await coordinator.load(api.narratorId, BUILD, { fetchPage: api.fetchPage }, undefined, 260);
			const initial = ready(coordinator);
			const saved = layoutGeometry(initial);
			const gate = fetchGate();
			let fetches = 0;
			const fetchPage: PretextDocumentFetchPage = async (id, options) => {
				fetches++;
				await gate.promise;
				return api.fetchPage(id, options);
			};
			api.messages[99] = message(api.narratorId, 99, "Newly reloaded tail content. ".repeat(40));
			const pending = coordinator.load(api.narratorId, BUILD, { fetchPage }, undefined, 260, {
				forceReload: true,
			});
			expect(coordinator.getSnapshot().status).toBe("loading");
			const states: PretextLayoutCoordinatorSnapshot[] = [];
			coordinator.subscribe(() => states.push(coordinator.getSnapshot()));
			let view = pinnedToBottom
				? { ...tailView(initial), scrollTop: initial.index.totalHeight - 260 - 11 }
				: { ...topView(), scrollTop: initial.index.itemStart(5) + 7 };
			coordinator.previewWidth(600, () => view);
			const preview = ready(coordinator, "loading");
			expect(preview.resizePreview).toBe(true);
			expect(preview.resizeRevision).toBeGreaterThan(initial.resizeRevision ?? 0);
			expect(preview.input).toBe(initial.input);
			expect(preview.semanticItems).toBe(initial.items);
			expect(preview.semanticManifest).toBe(initial.manifest);
			view = { ...view, scrollTop: preview.scrollTop ?? view.scrollTop };
			coordinator.finishResize({ ...BUILD, contentWidth: 600, widthBucket: "600" }, view);
			const interim = ready(coordinator, "loading");
			expect(interim.resizePreview).toBeUndefined();
			view = { ...view, scrollTop: interim.scrollTop ?? view.scrollTop, viewportHeight: 300 };
			coordinator.previewWidth(420, () => view);
			const latest = ready(coordinator, "loading");
			expect(latest.resizeRevision).toBeGreaterThan(interim.resizeRevision ?? 0);
			view = { ...view, scrollTop: latest.scrollTop ?? view.scrollTop };
			const anchor = captureCoordinatorAnchor(latest.index, view);
			const build = { ...BUILD, contentWidth: 420, widthBucket: "420", viewportHeight: 300 };
			const finished = coordinator.finishResize(build, view);
			const retargeted = coordinator.load(api.narratorId, build, { fetchPage }, anchor, 300);
			expect(finished.status).toBe("loading");
			expect(finished.resizeRevision).toBeGreaterThan(latest.resizeRevision ?? 0);
			expect(finished.resizePreview).toBeUndefined();
			expect(finished.resizeWidth).toBeUndefined();
			expect(finished.resizeMeasuredCount).toBeUndefined();
			expectFullBuild(ready(coordinator, "loading"), build);
			expect(states.every((snapshot) => snapshot.status === "loading")).toBe(true);
			gate.release();
			const committed = await pending;
			expect(await retargeted).toBe(committed);
			expect(committed).toBe(coordinator.getSnapshot());
			expect(fetches).toBe(1);
			expect(api.requests).toHaveLength(2);
			expect(committed.status).toBe("ready");
			expect(committed.input?.messages.at(-1)).toEqual(api.messages[99]);
			expect(committed.resizeRevision).toBeGreaterThan(finished.resizeRevision ?? 0);
			expect(committed.scrollTopAnchorKind).toBe(anchor.kind);
			expect(committed.scrollTop).toBe(
				restorePretextLayoutAnchor(anchor, ready(coordinator).index, 300),
			);
			expectFullBuild(ready(coordinator), build);
			expect(layoutGeometry(initial)).toEqual(saved);
		});
	}

	for (const pinnedToBottom of [false, true]) {
		it(`restores final-width DOM overrides on both sides of finish (${pinnedToBottom ? "bottom" : "item"})`, async () => {
			const { coordinator } = await loaded();
			coordinator.previewWidth(420, topView);
			const preview = ready(coordinator);
			const saved = layoutGeometry(preview);
			const visible = preview.items[0];
			const offscreen = preview.items.at(-1);
			if (!visible || !offscreen) throw new Error("fixture items missing");
			expect(visible.contentWidth).toBe(420);
			expect(offscreen.contentWidth).toBe(860);
			const overrides = new Map([
				[visible.spec.key, visible.measured.height + 100],
				[offscreen.spec.key, offscreen.measured.height + 200],
			]);
			const effective = indexWithHeightOverrides(preview.index, overrides);
			const view = {
				...topView(),
				pinnedToBottom,
				scrollTop: pinnedToBottom ? effective.totalHeight - 260 - 11 : effective.itemStart(1) + 7,
			};
			const anchor = captureCoordinatorAnchor(effective, view);
			const build = { ...BUILD, contentWidth: 420, widthBucket: "420" };
			coordinator.finishResize(build, view, overrides);
			const finished = ready(coordinator);
			const validOverrides = new Map([[visible.spec.key, visible.measured.height + 100]]);
			expect(finished.scrollTop).toBe(
				restorePretextLayoutAnchor(
					anchor,
					indexWithHeightOverrides(finished.index, validOverrides),
					260,
				),
			);
			expect(finished.scrollTop).not.toBe(restorePretextLayoutAnchor(anchor, finished.index, 260));
			if (pinnedToBottom) {
				expect(finished.scrollTop).not.toBe(
					restorePretextLayoutAnchor(
						anchor,
						indexWithHeightOverrides(finished.index, overrides),
						260,
					),
				);
			}
			expectFullBuild(finished, build);
			expect(layoutGeometry(preview)).toEqual(saved);
		});
	}
});
