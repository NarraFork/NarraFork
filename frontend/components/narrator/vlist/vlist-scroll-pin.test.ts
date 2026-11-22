/**
 * vlist-scroll-pin.test.ts — The scroll-position invariants that streaming broke.
 *
 * Three separate defects lived here, all of them only visible while output streamed
 * (because that is when the list writes scrollTop every frame):
 *
 * 1. The reader's own scrolling was swallowed. Suppression of the pinned-state update
 *    was TIME-based — a flag set on each programmatic write, cleared next frame — so
 *    while the pin effect wrote every frame the window never really closed. A gentle
 *    upward drag was discarded and the next write pulled the reader back to the
 *    bottom. Now the suppression is VALUE-based.
 * 2. The browser's own scroll anchoring competed with those writes
 *    (`overflow-anchor: none`, asserted on the rendered container elsewhere).
 * 3. An anchored rebuild could jump by up to one inter-item gap: a scroll position
 *    sitting in the gap between two items resolved to the following item with its
 *    offset clamped to zero, so restoring pulled that item's top to the viewport top.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import type { PretextDocumentPageResult, TreeMessage } from "@frontend/lib/api/types";
import { rowWithElements } from "@shared/narrator-blocks/message-blocks";
import { resolveOlderHistoryAutoLoad } from "../history/older-history-auto-load";
import { installCanvasStub } from "./measure/test-canvas-stub";
import { sliceBracketedRegion } from "./source-slice";

beforeAll(() => {
	installCanvasStub();
});

function shellScrollCallback<T>(
	source: string,
	name: string,
	bindings: Record<string, unknown>,
): T {
	const declaration = sliceBracketedRegion(source, `const ${name} = useCallback(`);
	if (!declaration) throw new Error(`Missing ${name}`);
	const code = new Bun.Transpiler({ loader: "tsx" }).transformSync(`${declaration};`);
	return new Function("useCallback", ...Object.keys(bindings), `${code}\nreturn ${name};`)(
		(callback: unknown) => callback,
		...Object.values(bindings),
	) as T;
}

async function loadedTopHarness(itemCount = 40, narratorId = "loaded-top") {
	const scroll = await import("./vlist-exact-scroll");
	const { buildPretextLayoutIndex, resolveVisibleWindow } = await import("@shared/pretext-layout");
	const { createVListVisibleViewport } = await import("./vlist-visible-viewport");
	const { buildExactListLayout } = await import("./vlist-exact-layout");
	const source = await Bun.file(
		new URL("./PretextExactMessageList.tsx", import.meta.url).pathname,
	).text();
	const index = buildPretextLayoutIndex({
		layoutRevision: "loaded-top",
		documentRevision: 1,
		lod: 5,
		widthBucket: "800",
		metrics: { topPadding: 16, itemGap: 4, bottomPadding: 16 },
		items: Array.from({ length: itemCount }, (_, index) => ({
			itemKey: `top-${index}`,
			firstSeq: index,
			lastSeq: index,
			sourceMessageIds: [`top-m${index}`],
			kind: "markdown",
			height: 80,
		})),
	});
	const initialLayout = buildExactListLayout(index);
	if (!initialLayout) throw new Error("Missing loaded-history layout");
	let layout = initialLayout;
	const node = {
		offsetWidth: 800,
		clientHeight: 600,
		scrollHeight: layout.totalHeight,
		scrollTop: Math.max(0, layout.totalHeight - 600),
		getBoundingClientRect: () => ({ top: 0 }),
	};
	const events: string[] = [];
	const jumpTokenRef = { current: 7 };
	const loadedTopNarratorRef = { current: null as string | null };
	const olderHistoryIntentAtRef = { current: 10_000 as number | null };
	const pinnedToBottomRef = { current: true };
	const textReadingDetachedRef = { current: false };
	const scrollTopRef = { current: node.scrollTop };
	const suppressScrollStateRef = { current: false };
	const suppressedScrollTopRef = { current: null as number | null };
	const visible = createVListVisibleViewport();
	let following = true;
	let stateTop = node.scrollTop;
	let window = resolveVisibleWindow(layout, stateTop, node.clientHeight, 0);
	const follower = {
		cancel: () => {
			events.push(`cancel:jump=${jumpTokenRef.current}`);
			following = false;
		},
		ensure: () => {
			events.push("follow");
			following = true;
		},
		isActive: () => following,
		snapToTarget: () => {},
	};
	const bindings = {
		narratorId,
		jumpTokenRef,
		loadedTopNarratorRef,
		viewportRef: { current: node },
		pinnedToBottomRef,
		textReadingDetachedRef,
		scrollTopRef,
		suppressScrollStateRef,
		suppressedScrollTopRef,
		scrollViewportHeightRef: { current: node.clientHeight },
		visibleViewportRef: {
			current: {
				...visible,
				setPinned: (pinned: boolean) => {
					expect(pinnedToBottomRef.current).toBe(pinned);
					events.push(`visible-pin:${pinned}`);
					visible.setPinned(pinned);
				},
			},
		},
		interactionAdmissionRef: {
			current: {
				markHistoryIntent: () => events.push("history-intent"),
				observeScroll: () => {},
				setAtBottom: () => {},
			},
		},
		setPinnedToBottom: (pinned: boolean) => {
			expect(pinnedToBottomRef.current).toBe(pinned);
			events.push(`state-pin:${pinned}`);
		},
		morphScrollOrigin: { invalidate: () => {} },
		smoothFollowerRef: { current: follower },
		getSmoothFollower: () => follower,
		setScrollTop: (top: number) => {
			stateTop = top;
			window = resolveVisibleWindow(layout, top, node.clientHeight, 0);
			events.push(`window:${top}`);
		},
		requestAnimationFrame: () => 1,
	};
	const writeCore = shellScrollCallback<(top: number, advance: boolean) => void>(
		source,
		"writeScrollTopCore",
		bindings,
	);
	const writeScrollTop = (top: number) => {
		events.push(`write:${top}`);
		writeCore(top, true);
	};
	const readViewportView = () =>
		visible.read(
			node,
			{
				scrollTop: scrollTopRef.current,
				viewportHeight: node.clientHeight,
				pinnedToBottom: pinnedToBottomRef.current,
			},
			following,
		);
	readViewportView();
	const detachFromBottom = shellScrollCallback<() => void>(source, "detachFromBottom", bindings);
	const toTop = () =>
		scroll.scrollExactListToLoadedTop({
			jumpTokenRef,
			detachFromBottom,
			textReadingDetachedRef,
			loadedTopNarratorRef,
			narratorId,
			olderHistoryIntentAtRef,
			writeScrollTop,
		});
	const liveBindings = { ...bindings, writeScrollTop, readViewportView };
	const readCurrentView = shellScrollCallback<
		() => {
			scrollTop: number;
			viewportHeight: number;
			pinnedToBottom: boolean;
		}
	>(source, "readCurrentView", {
		...liveBindings,
		lodFocusRef: { current: null },
		resolveLodFocusOffset: () => undefined,
	});
	const correction = shellScrollCallback<
		(top: number, kind: "bottom" | "item", smooth?: boolean) => void
	>(source, "onScrollTopCorrection", {
		...liveBindings,
		applyExactScrollCorrection: scroll.applyExactScrollCorrection,
		footerHeightRef: { current: 0 },
	});
	const processScrollFrame = shellScrollCallback<() => void>(source, "processScrollFrame", {
		...scroll,
		...liveBindings,
		scrollRafRef: { current: 0 },
		BOTTOM_DISTANCE_EPSILON: 1,
		maybeAutoLoadOlder: () => {},
		olderHistoryIntentAtRef,
		onUnreadCountChange: undefined,
		onAtBottomChange: undefined,
		resizeControllerRef: { current: null },
		exactLayoutRef: { current: null },
		viewportHeight: node.clientHeight,
		tailFooter: null,
	});
	return {
		source,
		bindings: liveBindings,
		node,
		events,
		toTop,
		olderHistoryIntentAtRef,
		readCurrentView,
		correction,
		readerScrollTo: (top: number) => {
			node.scrollTop = top;
			processScrollFrame();
		},
		setLayout: (nextIndex: typeof index) => {
			const next = buildExactListLayout(nextIndex);
			if (!next) throw new Error("Missing committed layout");
			layout = next;
			node.scrollHeight = next.totalHeight;
		},
		readState: () => ({ stateTop, window, following }),
	};
}

describe("loaded-history scroll-to-top action", () => {
	it("invalidates jumps, cancels the follower and synchronously unpins before writing the window", async () => {
		const harness = await loadedTopHarness();
		harness.toTop();
		expect(harness.events).toEqual([
			"cancel:jump=8",
			"history-intent",
			"visible-pin:false",
			"state-pin:false",
			"write:0",
			"window:0",
		]);
		expect(harness.node.scrollTop).toBe(0);
		expect(harness.bindings.scrollTopRef.current).toBe(0);
		expect(harness.readState().stateTop).toBe(0);
		expect(harness.readState().window.start).toBe(0);
		expect(harness.readState().following).toBe(false);
		expect(harness.bindings.textReadingDetachedRef.current).toBe(true);
	});

	it("clears a recent history intent without loading another page on either scroll echo", async () => {
		const harness = await loadedTopHarness();
		const { isSuppressedScrollEcho, isUpwardHistoryScroll } = await import("./vlist-exact-scroll");
		harness.toTop();
		expect(harness.olderHistoryIntentAtRef.current).toBeNull();
		let olderLoads = 0;
		const maybeAutoLoadOlder = shellScrollCallback<(top: number, atBottom: boolean) => void>(
			harness.source,
			"maybeAutoLoadOlder",
			{
				olderHistoryIntentAtRef: harness.olderHistoryIntentAtRef,
				autoLoadEnabledRef: { current: true },
				hasPrevRef: { current: true },
				loadingOlderRef: { current: false },
				loadOlderRef: { current: () => olderLoads++ },
				resolveOlderHistoryAutoLoad,
				OLDER_LOAD_TRIGGER_PX: 400,
				Date: { now: () => 10_001 },
			},
		);
		for (const suppressing of [true, false]) {
			const echo = isSuppressedScrollEcho(
				suppressing,
				harness.bindings.suppressedScrollTopRef.current,
				harness.node.scrollTop,
			);
			if (
				isUpwardHistoryScroll(harness.bindings.scrollTopRef.current, harness.node.scrollTop, echo)
			)
				harness.olderHistoryIntentAtRef.current = 10_001;
			maybeAutoLoadOlder(harness.node.scrollTop, false);
			expect(harness.olderHistoryIntentAtRef.current).toBeNull();
		}
		expect(olderLoads).toBe(0);
	});

	it("cancels actual message jumps awaiting either search resolution or an older page", async () => {
		for (const stage of ["search", "page"]) {
			const harness = await loadedTopHarness();
			const ready = Promise.withResolvers<void>();
			const search = Promise.withResolvers<{ seq: number }>();
			const page = Promise.withResolvers<number>();
			let olderLoads = 0;
			const jump = shellScrollCallback<
				(target: { domIds: string[]; targetIds: string[] }) => Promise<boolean>
			>(harness.source, "scrollToMessageTarget", {
				...harness.bindings,
				mountedJumpTarget: () => null,
				pretextDocumentRef: { current: { readWindow: () => ({ index: null, hasPrev: true }) } },
				messageIdFromTarget: (id: string) => id,
				resolveJumpTargetSeq: () => {
					if (stage === "search") ready.resolve();
					return stage === "search" ? search.promise : Promise.resolve({ seq: 1 });
				},
				resolveJumpWindowDecision: ({ expansions }: { expansions: number }) =>
					expansions === 0
						? { kind: "load-older" }
						: { kind: "unreachable", reason: "budget-exhausted" },
				notifications: { show: () => {} },
				loadOlderAsyncRef: {
					current: () => {
						olderLoads++;
						ready.resolve();
						return page.promise;
					},
				},
				narratorId: "loaded-top",
				dataSource: undefined,
				t: (key: string) => key,
			});
			const pendingJump = jump({ domIds: ["missing"], targetIds: ["missing"] });
			await ready.promise;
			harness.toTop();
			const eventsAfterTop = [...harness.events];
			search.resolve({ seq: 1 });
			page.resolve(10);
			expect(await pendingJump).toBe(false);
			expect(olderLoads).toBe(stage === "page" ? 1 : 0);
			expect(harness.events).toEqual(eventsAfterTop);
			expect(harness.node.scrollTop).toBe(0);
		}
	});

	it("keeps an explicit top across a real in-flight prepend and restores item anchors after reader navigation", async () => {
		const { PretextLayoutCoordinator } = await import("./pretext-layout-coordinator");
		for (const navigation of [
			"hold",
			"scroll",
			"scroll-before-frame",
			"search",
			"upward",
			"manual",
		]) {
			const narratorId = `loaded-top-prepend-${navigation}`;
			const harness = await loadedTopHarness(40, narratorId);
			const older = Promise.withResolvers<PretextDocumentPageResult>();
			let fetches = 0;
			const makePage = (firstSeq: number, hasPrev: boolean): PretextDocumentPageResult => ({
				messages: [firstSeq, firstSeq + 1].map((seq) => {
					const text = `message ${seq}\n\n${"reading line\n".repeat(80)}`;
					return rowWithElements(
						{
							id: `${narratorId}-m${seq}`,
							narratorId,
							parentToolUseId: null,
							role: "assistant",
							contentText: text,
							toolCalls: [],
							createdAt: "2026-07-23T00:00:00.000Z",
							seq,
						},
						[{ type: "text", text }],
					) as TreeMessage;
				}),
				minSeq: firstSeq,
				maxSeq: firstSeq + 1,
				hasNext: firstSeq === 0,
				hasPrev,
				messageVersion: 3,
			});
			const buildOptions = {
				lod: 5 as const,
				widthBucket: "800",
				contentWidth: 800,
				viewportHeight: 600,
				topPadding: 16,
				bottomPadding: 16,
				gap: 4,
			};
			const coordinator = new PretextLayoutCoordinator();
			const initial = await coordinator.load(narratorId, buildOptions, {
				fetchPage: async (_id, options) => {
					fetches++;
					return options.beforeSeq == null ? makePage(2, true) : older.promise;
				},
			});
			if (!initial.index) throw new Error("Missing tail layout");
			harness.setLayout(initial.index);
			let revision = initial.resizeRevision;
			const unsubscribe = coordinator.subscribe(() => {
				const snapshot = coordinator.getSnapshot();
				if (!snapshot.index || snapshot.resizeRevision === revision) return;
				revision = snapshot.resizeRevision;
				harness.setLayout(snapshot.index);
				if (snapshot.scrollTop != null && snapshot.scrollTopAnchorKind)
					harness.correction(snapshot.scrollTop, snapshot.scrollTopAnchorKind);
			});
			const loadOlder = () => coordinator.loadOlder(buildOptions, harness.readCurrentView);
			let pending: Promise<number>;
			if (navigation === "manual") {
				harness.toTop();
				const button = harness.source.match(/<ManualOlderHistoryLoad\b[^>]*onLoad=\{(\w+)\}/);
				if (!button?.[1]) throw new Error("Missing manual history loader");
				let requested: Promise<number> | undefined;
				const startLoad = () => {
					requested = loadOlder();
				};
				const onLoad =
					button[1] === "loadOlder"
						? startLoad
						: shellScrollCallback<() => void>(harness.source, button[1], {
								...harness.bindings,
								loadOlder: startLoad,
							});
				onLoad();
				if (!requested) throw new Error("Manual history load did not request a page");
				pending = requested;
			} else {
				pending = loadOlder();
				harness.toTop();
			}
			expect(fetches).toBe(2);
			if (navigation === "scroll") harness.readerScrollTo(72);
			if (navigation === "scroll-before-frame") harness.node.scrollTop = 72;
			if (navigation === "search") {
				const jump = shellScrollCallback<
					(target: { domIds: string[]; targetIds: string[] }) => Promise<boolean>
				>(harness.source, "scrollToMessageTarget", {
					...harness.bindings,
					mountedJumpTarget: () => null,
					pretextDocumentRef: { current: { readWindow: () => ({ index: null }) } },
					messageIdFromTarget: (id: string) => id,
					resolveJumpTargetSeq: async () => null,
					dataSource: undefined,
					t: (key: string) => key,
				});
				expect(await jump({ domIds: ["missing"], targetIds: ["missing"] })).toBe(false);
			}
			if (navigation === "upward") {
				const intent = sliceBracketedRegion(harness.source, "const markUpwardIntent = () => {");
				if (!intent) throw new Error("Missing upward history intent callback");
				const code = new Bun.Transpiler({ loader: "tsx" }).transformSync(`${intent};`);
				new Function(
					"olderHistoryIntentAtRef",
					"loadedTopNarratorRef",
					`${code}\nmarkUpwardIntent();`,
				)(harness.olderHistoryIntentAtRef, harness.bindings.loadedTopNarratorRef);
				// The auto-load gate consumes the new gesture before the page commits.
				harness.olderHistoryIntentAtRef.current = null;
			}
			older.resolve(makePage(0, false));
			expect(await pending).toBe(2);
			const snapshot = coordinator.getSnapshot();
			if (!snapshot.index) throw new Error("Missing prepended layout");
			const addedHeight = snapshot.index.totalHeight - initial.index.totalHeight;
			expect(addedHeight).toBeGreaterThan(0);
			expect(snapshot.scrollTopAnchorKind).toBe("item");
			if (snapshot.scrollTop == null) throw new Error("Missing prepend scroll correction");
			expect(snapshot.scrollTop).toBeCloseTo(
				addedHeight + (navigation.startsWith("scroll") ? 72 : 0),
				5,
			);
			const expected = navigation === "hold" ? 0 : snapshot.scrollTop;
			expect(harness.node.scrollTop).toBeCloseTo(expected, 5);
			expect(harness.readState().stateTop).toBeCloseTo(expected, 5);
			if (navigation === "hold") expect(harness.readState().window.start).toBe(0);
			expect(fetches).toBe(2);
			unsubscribe();
			coordinator.reset();
		}
	});

	it("honors a real LOD focus correction after returning to top without scrolling first", async () => {
		const { captureCoordinatorAnchor, PretextLayoutCoordinator } = await import(
			"./pretext-layout-coordinator"
		);
		const { createLodFocusPoint, createLodStepThrottle, resolveLodFocusOffset } = await import(
			"./vlist-lod-gesture"
		);
		for (const origin of ["gesture", "toolbar"]) {
			const narratorId = `loaded-top-lod-${origin}`;
			const harness = await loadedTopHarness(40, narratorId);
			const toolUseId = `${narratorId}-tool`;
			const inputJson = { command: "printf 'geometry details'" };
			const toolMessage = rowWithElements(
				{
					id: `${narratorId}-m0`,
					narratorId,
					parentToolUseId: null,
					role: "assistant",
					contentText: null,
					toolCalls: [
						{
							id: `${narratorId}-tc`,
							narratorId,
							messageId: `${narratorId}-m0`,
							toolUseId,
							toolName: "Bash",
							status: "completed",
							inputJson,
							outputJson: { stdout: "geometry details\n".repeat(8), exitCode: 0 },
							createdAt: "2026-07-23T00:00:00.000Z",
						},
					],
					createdAt: "2026-07-23T00:00:00.000Z",
					seq: 0,
				},
				[
					{
						type: "tool_use",
						id: toolUseId,
						name: "Bash",
						input: inputJson,
						inputJson,
						status: "completed",
					},
				],
			) as unknown as TreeMessage;
			const textId = `${narratorId}-m1`;
			const focusedText = "focused text\n\n".repeat(40);
			const textMessage = rowWithElements(
				{
					id: textId,
					narratorId,
					parentToolUseId: null,
					role: "assistant",
					contentText: focusedText,
					toolCalls: [],
					createdAt: "2026-07-23T00:00:00.000Z",
					seq: 1,
				},
				[{ type: "text", text: focusedText }],
			) as TreeMessage;
			const buildOptions = {
				lod: 4 as const,
				widthBucket: "800",
				contentWidth: 800,
				viewportHeight: 600,
				topPadding: 16,
				bottomPadding: 16,
				gap: 4,
				recentMessageIds: new Set<string>(),
			};
			const coordinator = new PretextLayoutCoordinator();
			const initial = await coordinator.load(narratorId, buildOptions, {
				fetchPage: async () => ({
					messages: [toolMessage, textMessage],
					minSeq: 0,
					maxSeq: 1,
					hasNext: false,
					hasPrev: false,
					messageVersion: 3,
				}),
			});
			if (!initial.index) throw new Error("Missing LOD source layout");
			expect(initial.index.totalHeight).toBeGreaterThan(600);
			harness.setLayout(initial.index);
			const targetIndex = initial.index.manifest.items.findIndex((item) =>
				item.sourceMessageIds.includes(textId),
			);
			if (targetIndex < 0) throw new Error("Missing focused text item");
			const focusY = initial.index.itemStart(targetIndex) + 3;
			const lodFocusRef = { current: null as ReturnType<typeof createLodFocusPoint> | null };
			const focusBindings = {
				...harness.bindings,
				lodFocusRef,
				createLodFocusPoint,
				resolveLodFocusOffset,
			};
			const readCurrentView = shellScrollCallback<
				() => {
					scrollTop: number;
					viewportHeight: number;
					pinnedToBottom: boolean;
					focusOffset?: number;
				}
			>(harness.source, "readCurrentView", focusBindings);
			harness.toTop();
			expect(harness.node.scrollTop).toBe(0);
			if (origin === "toolbar") {
				shellScrollCallback<(clientY: number) => void>(
					harness.source,
					"prepareLodChange",
					focusBindings,
				)(focusY);
			} else {
				const emit = sliceBracketedRegion(
					harness.source,
					"const emit = (dir: 1 | -1, clientY: number | null) => {",
				);
				if (!emit) throw new Error("Missing gesture LOD emitter");
				const emitBindings = {
					...focusBindings,
					node: harness.node,
					throttle: createLodStepThrottle(),
					onLodStepRef: { current: () => {} },
				};
				const code = new Bun.Transpiler({ loader: "tsx" }).transformSync(`${emit};`);
				const emitStep = new Function(...Object.keys(emitBindings), `${code}\nreturn emit;`)(
					...Object.values(emitBindings),
				) as (dir: 1 | -1, clientY: number) => void;
				emitStep(1, focusY);
			}
			expect(harness.bindings.loadedTopNarratorRef.current).toBeNull();
			const view = readCurrentView();
			expect(view.scrollTop).toBe(0);
			expect(view.focusOffset).toBeCloseTo(focusY, 5);
			const anchor = captureCoordinatorAnchor(initial.index, view);
			const rebuilt = coordinator.rebuild({ ...buildOptions, lod: 5 }, anchor, 600);
			if (!rebuilt.index || rebuilt.scrollTop == null || !rebuilt.scrollTopAnchorKind)
				throw new Error("Missing LOD focus correction");
			const nextTarget = rebuilt.index.manifest.items.findIndex((item) =>
				item.sourceMessageIds.includes(textId),
			);
			if (nextTarget < 0) throw new Error("Missing rebuilt focused text");
			expect(rebuilt.scrollTop).toBeGreaterThan(0);
			expect(rebuilt.scrollTop).toBeLessThanOrEqual(rebuilt.index.totalHeight - 600);
			harness.setLayout(rebuilt.index);
			harness.correction(rebuilt.scrollTop, rebuilt.scrollTopAnchorKind);
			expect(harness.node.scrollTop).toBeCloseTo(rebuilt.scrollTop, 5);
			expect(harness.readState().stateTop).toBeCloseTo(rebuilt.scrollTop, 5);
			expect(rebuilt.index.itemStart(nextTarget) + 3 - harness.node.scrollTop).toBeCloseTo(
				focusY,
				5,
			);
			coordinator.reset();
		}
	});

	it("releases loaded-top reading before normal and reduced-motion folds capture their geometry", async () => {
		for (const reducedMotion of [false, true]) {
			const harness = await loadedTopHarness();
			harness.toTop();
			const capture = shellScrollCallback<(key: string) => void>(
				harness.source,
				"captureFoldBefore",
				{
					...harness.bindings,
					foldCaptureRef: { current: null },
					prefersReducedMotion: () => reducedMotion,
					readFoldGeometryRef: {
						current: () => ({ geometry: new Map([["row", {}]]), documentRevision: 1, lod: 5 }),
					},
				},
			);
			capture("row");
			expect(harness.bindings.loadedTopNarratorRef.current).toBeNull();
			harness.correction(24, "item");
			expect(harness.node.scrollTop).toBe(24);
		}
	});

	it("releases the loaded-top intent for marker and bottom navigation", async () => {
		const { getScrollBottomTarget } = await import("./vlist-exact-scroll");
		for (const name of ["handleUserMarkerJump", "handleCompactMarkerJump", "scrollToBottom"]) {
			const harness = await loadedTopHarness();
			harness.toTop();
			const navigate = shellScrollCallback<(target: { top: number } | boolean) => void>(
				harness.source,
				name,
				{
					...harness.bindings,
					getScrollBottomTarget,
					resolveVListUserMarkerScrollTop: (top: number) => top,
					VLIST_USER_MARKER_JUMP_LEAD: 0,
				},
			);
			navigate(name === "scrollToBottom" ? true : { top: 12 });
			expect(harness.bindings.loadedTopNarratorRef.current).toBeNull();
			harness.correction(24, "item");
			expect(harness.node.scrollTop).toBe(24);
		}
	});

	it("scopes the top intent to its narrator and clears it when a session changes", async () => {
		const harness = await loadedTopHarness();
		const { applyExactScrollCorrection } = await import("./vlist-exact-scroll");
		harness.toTop();
		const nextNarratorCorrection = shellScrollCallback<(top: number, kind: "item") => void>(
			harness.source,
			"onScrollTopCorrection",
			{
				...harness.bindings,
				narratorId: "next-narrator",
				applyExactScrollCorrection,
				footerHeightRef: { current: 0 },
			},
		);
		nextNarratorCorrection(12, "item");
		expect(harness.node.scrollTop).toBe(12);
		harness.toTop();
		const resetStart = harness.source.lastIndexOf(
			"useEffect(",
			harness.source.indexOf("appliedMessageRevisionRef.current = 0;"),
		);
		const reset = sliceBracketedRegion(harness.source.slice(resetStart), "useEffect(");
		if (!reset) throw new Error("Missing narrator reset effect");
		const resetBindings = {
			narratorId: "next-narrator",
			loadedTopNarratorRef: harness.bindings.loadedTopNarratorRef,
			textReadingDetachedRef: harness.bindings.textReadingDetachedRef,
			appliedMessageRevisionRef: { current: 3 },
			initialRevisionSyncRef: { current: false },
			setMessageRevision: () => {},
			setClosingRows: () => {},
			unknownHeightReporterCacheRef: { current: new Map() },
			togglesCacheRef: { current: new Map() },
			reflectionTakeOverCacheRef: { current: new Map() },
			permissionHeightReportersRef: { current: new Map() },
			heightOverrideWidthsRef: { current: new Map() },
			resizeDirtyKeysRef: { current: new Set() },
			useEffect: (callback: () => void) => callback(),
		};
		const resetCode = new Bun.Transpiler({ loader: "tsx" }).transformSync(`${reset};`);
		new Function(...Object.keys(resetBindings), resetCode)(...Object.values(resetBindings));
		expect(harness.bindings.loadedTopNarratorRef.current).toBeNull();
		harness.correction(24, "item");
		expect(harness.node.scrollTop).toBe(24);
	});

	it("cancels a queued bottom landing and a stale short-window fill effect", async () => {
		const harness = await loadedTopHarness(1);
		const { getScrollBottomTarget } = await import("./vlist-exact-scroll");
		const landing = { callback: undefined as (() => void) | undefined };
		const toBottom = shellScrollCallback<() => void>(harness.source, "scrollToBottom", {
			...harness.bindings,
			getScrollBottomTarget,
			requestAnimationFrame: (callback: () => void) => {
				landing.callback = callback;
				return 1;
			},
		});
		toBottom();
		harness.toTop();
		let olderLoads = 0;
		const fill = sliceBracketedRegion(
			harness.source.slice(harness.source.indexOf("// First-screen fill:")),
			"useEffect(",
		);
		if (!fill) throw new Error("Missing first-screen fill effect");
		const fillBindings = {
			pinnedToBottomRef: harness.bindings.pinnedToBottomRef,
			pinnedToBottom: true,
			pretextDocument: { status: "ready" },
			hasPrev: true,
			loadingOlder: false,
			viewportHeight: harness.node.clientHeight,
			exactLayout: { totalHeight: 100 },
			ITEM_OVERSCAN: 400,
			getLastTrimAt: () => 0,
			loadOlder: () => olderLoads++,
			useEffect: (callback: () => void) => callback(),
		};
		const fillCode = new Bun.Transpiler({ loader: "tsx" }).transformSync(`${fill};`);
		new Function(...Object.keys(fillBindings), fillCode)(...Object.values(fillBindings));
		const eventsAfterTop = [...harness.events];
		landing.callback?.();
		expect(harness.node.scrollTop).toBe(0);
		expect(harness.events).toEqual(eventsAfterTop);
		expect(olderLoads).toBe(0);
	});

	it("ignores old bottom anchors and a queued pin frame, and keeps short or long content detached as it grows", async () => {
		const { applyExactScrollCorrection, createPinnedBottomFrame, getScrollBottomTarget } =
			await import("./vlist-exact-scroll");
		for (const itemCount of [1, 40]) {
			const harness = await loadedTopHarness(itemCount);
			const bindings = {
				...harness.bindings,
				applyExactScrollCorrection,
				getScrollBottomTarget,
				footerHeightRef: { current: 0 },
			};
			const correction = shellScrollCallback<
				(top: number, kind: "bottom" | "item", smooth?: boolean) => void
			>(harness.source, "onScrollTopCorrection", bindings);
			const pinEffect = harness.source.slice(
				harness.source.indexOf("const scrollGeometryRevision ="),
				harness.source.indexOf("// First-screen fill:"),
			);
			const frame = sliceBracketedRegion(pinEffect, "const frame = requestAnimationFrame(");
			const snap = sliceBracketedRegion(pinEffect, "const snap = () => {");
			if (!frame || !snap) throw new Error("Missing bottom-pin frame");
			const queuedPin = { callback: undefined as (() => void) | undefined };
			const frameCode = new Bun.Transpiler({ loader: "tsx" }).transformSync(`${snap};${frame};`);
			const frameBindings = {
				...bindings,
				createPinnedBottomFrame,
				requestAnimationFrame: (callback: () => void) => {
					queuedPin.callback = callback;
					return 1;
				},
			};
			new Function(...Object.keys(frameBindings), frameCode)(...Object.values(frameBindings));
			harness.toTop();
			queuedPin.callback?.();
			correction(3000, "bottom", false);
			correction(3000, "bottom", true);
			expect(harness.node.scrollTop).toBe(0);
			expect(harness.readState().following).toBe(false);
			const readCurrentView = shellScrollCallback<
				() => { scrollTop: number; pinnedToBottom: boolean }
			>(harness.source, "readCurrentView", {
				...harness.bindings,
				lodFocusRef: { current: null },
				resolveLodFocusOffset: () => undefined,
			});
			expect(readCurrentView().pinnedToBottom).toBe(false);
			harness.node.scrollHeight += 5000;
			expect(readCurrentView()).toMatchObject({ scrollTop: 0, pinnedToBottom: false });
			correction(5000, "bottom", true);
			expect(harness.node.scrollTop).toBe(0);
			// A fresh item correction still preserves geometry after the reader moves.
			harness.readerScrollTo(12);
			correction(24, "item", false);
			expect(harness.node.scrollTop).toBe(24);
		}
	});
});

describe("isSuppressedScrollEcho — telling our own write from the reader", () => {
	it("treats a scroll event matching our written value as our own echo", async () => {
		const { isSuppressedScrollEcho } = await import("./vlist-exact-scroll");
		expect(isSuppressedScrollEcho(true, 1000, 1000)).toBe(true);
		// The browser may settle a programmatic write a fraction of a pixel away.
		expect(isSuppressedScrollEcho(true, 1000, 1000.4)).toBe(true);
		expect(isSuppressedScrollEcho(true, 1000, 999.7)).toBe(true);
	});

	it("honours the reader from ANY input source that moved the position", async () => {
		const { isSuppressedScrollEcho } = await import("./vlist-exact-scroll");
		// This is what makes the fix cover keyboard and scrollbar dragging too: the
		// list does not need a listener per gesture, only to notice the position is not
		// the one it wrote. (Only wheel/touch ever had explicit detach handlers.)
		expect(isSuppressedScrollEcho(true, 1000, 700)).toBe(false); // scrollbar drag
		expect(isSuppressedScrollEcho(true, 1000, 400)).toBe(false); // PageUp
		expect(isSuppressedScrollEcho(true, 1000, 997)).toBe(false); // gentle 3px nudge
	});

	it("is inert when no write is being suppressed", async () => {
		const { isSuppressedScrollEcho } = await import("./vlist-exact-scroll");
		expect(isSuppressedScrollEcho(false, 1000, 1000)).toBe(false);
		expect(isSuppressedScrollEcho(false, null, 42)).toBe(false);
	});

	it("stays conservative when the written value is unknown", async () => {
		const { isSuppressedScrollEcho } = await import("./vlist-exact-scroll");
		expect(isSuppressedScrollEcho(true, null, 123)).toBe(true);
	});
});

describe("upward scroll intent loads older history without a wheel event", () => {
	const baseInput = {
		now: 10_000,
		autoLoadEnabled: true,
		hasOlder: true,
		expanding: false,
		atBottom: false,
		scrollTop: 0,
		triggerPx: 400,
	};

	it("loads when a scrollbar drag or keyboard scroll reaches the top", async () => {
		const { isUpwardHistoryScroll } = await import("./vlist-exact-scroll");
		for (const previousTop of [4000, 600, 3]) {
			const intentAt = isUpwardHistoryScroll(previousTop, 0, false) ? baseInput.now : null;
			expect(resolveOlderHistoryAutoLoad({ ...baseInput, intentAt })).toEqual({
				shouldLoad: true,
				nextIntentAt: null,
			});
		}
	});

	it("refreshes intent during a drag longer than the gesture timeout", async () => {
		const { isUpwardHistoryScroll } = await import("./vlist-exact-scroll");
		const travelling = resolveOlderHistoryAutoLoad({
			...baseInput,
			scrollTop: 500,
			intentAt: isUpwardHistoryScroll(4000, 500, false) ? baseInput.now : null,
		});
		expect(travelling.shouldLoad).toBe(false);
		const now = baseInput.now + 4000;
		expect(
			resolveOlderHistoryAutoLoad({
				...baseInput,
				now,
				intentAt: isUpwardHistoryScroll(500, 0, false) ? now : travelling.nextIntentAt,
			}).shouldLoad,
		).toBe(true);
	});

	it("ignores programmatic echoes, unchanged positions, downward scrolls and pixel jitter", async () => {
		const { isUpwardHistoryScroll } = await import("./vlist-exact-scroll");
		expect(isUpwardHistoryScroll(1000, 0, true)).toBe(false);
		// writeScrollTop updates the live ref, so even a delayed echo after the
		// suppression window closes cannot renew an already-consumed intent.
		expect(isUpwardHistoryScroll(0, 0, false)).toBe(false);
		expect(isUpwardHistoryScroll(0, 300, false)).toBe(false);
		expect(isUpwardHistoryScroll(300, 299.5, false)).toBe(false);
		expect(isUpwardHistoryScroll(300, 299, false)).toBe(false);
	});

	it("recognizes a drag even while a different programmatic position is suppressed", async () => {
		const { isSuppressedScrollEcho, isUpwardHistoryScroll } = await import("./vlist-exact-scroll");
		expect(isUpwardHistoryScroll(1000, 0, isSuppressedScrollEcho(true, 1000, 0))).toBe(true);
	});

	it("preserves manual mode, the loading lock and the end-of-history guard", async () => {
		const { isUpwardHistoryScroll } = await import("./vlist-exact-scroll");
		const intentAt = isUpwardHistoryScroll(1000, 0, false) ? baseInput.now : null;
		for (const guard of [{ autoLoadEnabled: false }, { expanding: true }, { hasOlder: false }]) {
			expect(resolveOlderHistoryAutoLoad({ ...baseInput, intentAt, ...guard }).shouldLoad).toBe(
				false,
			);
		}
	});

	it("consumes intent once and does not re-arm from a prepend correction or an idle top", async () => {
		const { isUpwardHistoryScroll } = await import("./vlist-exact-scroll");
		const loaded = resolveOlderHistoryAutoLoad({ ...baseInput, intentAt: baseInput.now });
		expect(loaded).toEqual({ shouldLoad: true, nextIntentAt: null });
		for (const [previousTop, nextTop, isEcho] of [
			[0, 0, false],
			[300, 300, true],
			[300, 300, false],
		] as const) {
			const intentAt = isUpwardHistoryScroll(previousTop, nextTop, isEcho)
				? baseInput.now
				: loaded.nextIntentAt;
			expect(
				resolveOlderHistoryAutoLoad({ ...baseInput, intentAt, scrollTop: nextTop }).shouldLoad,
			).toBe(false);
		}
	});

	it("records scroll-frame intent before evaluating the auto-load gate", async () => {
		const source = await Bun.file(
			new URL("./PretextExactMessageList.tsx", import.meta.url).pathname,
		).text();
		const frame = source.slice(
			source.indexOf("const processScrollFrame = useCallback("),
			source.indexOf("const onScroll = useCallback("),
		);
		expect(frame).toContain("if (isUpwardHistoryScroll(previousTop, nextTop, isEcho))");
		const intentWrite = frame.indexOf("olderHistoryIntentAtRef.current = Date.now();");
		expect(intentWrite).toBeGreaterThan(-1);
		expect(intentWrite).toBeLessThan(frame.indexOf("maybeAutoLoadOlder("));
	});

	it("records list-local message reveals as programmatic scrolls too", async () => {
		const source = await Bun.file(
			new URL("./PretextExactMessageList.tsx", import.meta.url).pathname,
		).text();
		const reveal = source.slice(
			source.indexOf("const revealMounted = () =>"),
			source.indexOf("const revealByLayout = async"),
		);
		expect(reveal).toContain("writeScrollTop(jumpTargetScrollTop(node, element))");
		expect(reveal).not.toContain("element.scrollIntoView(");
	});
});

describe("isBottomLostToContentGrowth — a row growing beneath a pinned reader", () => {
	/**
	 * The shipped defect: a PENDING PERMISSION row is measured after paint (the real
	 * InlinePermission / AskUserQuestionBanner mounts, then its ResizeObserver reports
	 * again as the feedback textarea / target block / reflection notice settle). Between
	 * two reports a scroll frame saw a large distance-from-bottom with the reader never
	 * having touched anything, and unpinned auto-follow — permanently, because the pin
	 * effect is gated on `pinnedToBottom`, so every later message landed off-screen.
	 */
	it("keeps the pin when the bottom moved but scrollTop did not", async () => {
		const { isBottomLostToContentGrowth } = await import("./vlist-exact-scroll");
		// The permission form grew 120px below the viewport: same scrollTop, new bottom.
		expect(isBottomLostToContentGrowth(true, 4000, 4000)).toBe(true);
		// Sub-pixel settling of a programmatic write is not an upward gesture.
		expect(isBottomLostToContentGrowth(true, 4000, 3999.6)).toBe(true);
		// A shrinking viewport (composer grew, window resized) moves the bottom the same way.
		expect(isBottomLostToContentGrowth(true, 0, 0)).toBe(true);
	});

	it("releases the pin as soon as the reader actually travels upward", async () => {
		const { isBottomLostToContentGrowth } = await import("./vlist-exact-scroll");
		// Every gesture toward earlier content LOWERS scrollTop, which is the whole
		// discriminator — no per-gesture listener needed.
		expect(isBottomLostToContentGrowth(true, 4000, 3800)).toBe(false); // wheel / drag
		expect(isBottomLostToContentGrowth(true, 4000, 2000)).toBe(false); // PageUp
		expect(isBottomLostToContentGrowth(true, 4000, 3997)).toBe(false); // gentle 3px nudge
	});

	it("never re-pins a reader who had already left the bottom", async () => {
		const { isBottomLostToContentGrowth } = await import("./vlist-exact-scroll");
		// Reading history while output streams: growth below must not drag them back.
		expect(isBottomLostToContentGrowth(false, 1000, 1000)).toBe(false);
		expect(isBottomLostToContentGrowth(false, 1000, 1200)).toBe(false);
	});
});

describe("keyboard viewport resize preserves the existing bottom pin", () => {
	it("recognizes keyboard opening, animation steps and closing independently of scrollTop", async () => {
		const { isBottomLostToViewportResize } = await import("./vlist-exact-scroll");
		for (const [before, after] of [
			[700, 400],
			[400, 380],
			[380, 700],
		]) {
			expect(isBottomLostToViewportResize(true, before, after)).toBe(true);
		}
	});

	it("keeps a keyboard-adjusted upward position pinned, then honors the next real upward scroll", async () => {
		const { isBottomLostToContentGrowth, isBottomLostToViewportResize } = await import(
			"./vlist-exact-scroll"
		);
		// The focus/keyboard transition moved scrollTop upward: the old predicate
		// alone would permanently release the pin before the geometry effect ran.
		const staysPinned = (
			beforeTop: number,
			afterTop: number,
			beforeHeight: number,
			afterHeight: number,
		) =>
			isBottomLostToContentGrowth(true, beforeTop, afterTop) ||
			isBottomLostToViewportResize(true, beforeHeight, afterHeight);
		expect(isBottomLostToContentGrowth(true, 4000, 3800)).toBe(false);
		expect(staysPinned(4000, 3800, 700, 400)).toBe(true);
		// Once the viewport settles, even a gentle upward scroll must detach.
		expect(staysPinned(4300, 4297, 400, 400)).toBe(false);
	});

	it("does not re-pin history readers or suppress upward scrolling at a stable height", async () => {
		const { isBottomLostToViewportResize } = await import("./vlist-exact-scroll");
		expect(isBottomLostToViewportResize(false, 700, 400)).toBe(false);
		expect(isBottomLostToViewportResize(true, 400, 400)).toBe(false);
		expect(isBottomLostToViewportResize(true, 400, 400.5)).toBe(false);
		expect(isBottomLostToViewportResize(true, null, 400)).toBe(false);
	});

	it("checks live height before unpinning or inferring older-history intent", async () => {
		const source = await Bun.file(
			new URL("./PretextExactMessageList.tsx", import.meta.url).pathname,
		).text();
		const frame = source.slice(
			source.indexOf("const processScrollFrame = useCallback("),
			source.indexOf("const onScroll = useCallback("),
		);
		expect(frame).toContain("isBottomLostToViewportResize(");
		expect(frame).toContain("scrollViewportHeightRef.current");
		expect(frame).toContain("node.clientHeight");
		expect(frame).toContain("atBottom || grewBeneathReader || viewportResizedWhilePinned");
		expect(frame).toContain("if (!viewportResizedWhilePinned)");
		expect(frame).toContain("grewBeneathReader || viewportResizedWhilePinned");
		const touch = source.slice(
			source.indexOf("const onTouchMove = (event: TouchEvent) =>"),
			source.indexOf("const onTouchEnd = (event: TouchEvent) =>"),
		);
		expect(touch).toContain("detachFromBottom();");
	});
});

describe("processScrollFrame answers content growth in the same frame", () => {
	/**
	 * Deciding to stay pinned is not enough on its own: the VIEW must also be pulled
	 * back to the new bottom. Leaving that to the geometry-revision pin effect is not
	 * sufficient — that effect is keyed on `exactLayout.totalHeight`, which only moves
	 * once a reported height lands in `heightOverrides`. A report inside the 1px jitter
	 * guard, or one for a row that already left the dynamic path, grows the real DOM box
	 * without changing the layout, so the effect never runs and the view sits a form's
	 * height short of the bottom.
	 */
	it("re-glues to the bottom and resolves the window from the settled position", async () => {
		const source = await Bun.file(
			new URL("./PretextExactMessageList.tsx", import.meta.url).pathname,
		).text();
		const frame = source.slice(
			source.indexOf("const processScrollFrame = useCallback("),
			source.indexOf("const onScroll = useCallback("),
		);
		expect(frame).toContain("isBottomLostToContentGrowth(");
		// The re-glue SNAPS: what reaches it is a row settling its post-paint height,
		// not content arriving. It only stands down for an active chase so it cannot
		// cut a streaming glide short. (See the settle-vs-arrival group below.)
		expect(frame).toContain("(grewBeneathReader || viewportResizedWhilePinned) &&");
		expect(frame).toContain("smoothFollowerRef.current?.isActive() !== true");
		expect(frame).toContain("writeScrollTop(getScrollBottomTarget(node));");
		// The mounted window must come from where the viewport now is, not from the
		// pre-re-glue reading.
		expect(frame).toContain("const settledTop = scrollTopRef.current;");
		expect(frame).toContain("resolveVisibleWindow(layout, settledTop,");
	});

	/**
	 * The panel's affordances read the SAME value the pin does. Reporting the raw
	 * `atBottom` while staying pinned would flash the scroll-to-bottom button and count
	 * unread messages for a reader who is being followed (NarratorPanel:
	 * `showScrollToBottomButton = !isAtBottom || unreadCount > 0`).
	 */
	it("reports the effective pin to the panel, not the raw geometry reading", async () => {
		const source = await Bun.file(
			new URL("./PretextExactMessageList.tsx", import.meta.url).pathname,
		).text();
		const frame = source.slice(
			source.indexOf("const processScrollFrame = useCallback("),
			source.indexOf("const onScroll = useCallback("),
		);
		expect(frame).toContain("onAtBottomChange?.(effectiveAtBottom);");
		expect(frame).toContain("if (effectiveAtBottom) onUnreadCountChange?.(0);");
		expect(frame).not.toContain("onAtBottomChange?.(atBottom);");
	});
});

describe("the scroll container disables the browser's own anchoring", () => {
	it("sets overflow-anchor: none on the scroll viewport", async () => {
		// The list answers every geometry change with an explicit anchored write, so
		// the browser adjusting scrollTop for the same size changes would fight it —
		// most visibly while the streaming row grows each frame.
		const source = await Bun.file(
			new URL("./PretextExactMessageList.tsx", import.meta.url).pathname,
		).text();
		expect(source).toContain('overflowAnchor: "none"');
	});
});

describe("queued bottom snap", () => {
	for (const detach of [true, false]) {
		it(
			detach
				? "leaves the reader's scroll position alone after detaching"
				: "snaps to the latest bottom while still pinned",
			async () => {
				const { createPinnedBottomFrame, getScrollBottomTarget } = await import(
					"./vlist-exact-scroll"
				);
				const pinned = { current: true };
				const viewport = { scrollTop: 700, scrollHeight: 1000, clientHeight: 300 };
				const queued = createPinnedBottomFrame(pinned, () => {
					viewport.scrollTop = getScrollBottomTarget(viewport);
				});
				viewport.scrollHeight = 1200;
				if (detach) {
					pinned.current = false;
					viewport.scrollTop = 600;
				}
				queued();
				expect(viewport.scrollTop).toBe(detach ? 600 : 900);
			},
		);
	}
});

describe("smooth bottom-follow wiring (vlist-smooth-follow)", () => {
	async function shell() {
		return Bun.file(new URL("./PretextExactMessageList.tsx", import.meta.url).pathname).text();
	}

	/**
	 * ONE writer glides, and that is the whole point.
	 *
	 * "Content ARRIVED for a reader who is watching" is the only thing worth
	 * animating. The other bottom writers answer a document being ESTABLISHED or
	 * SETTLING — a fresh load, a narrator switch, a prepend re-pin, a row reporting
	 * its post-paint height, a footer resolving, a resize — and every one of those is
	 * a small delta, so routing them through the same gate made the list animate its
	 * own mount: opening a narrator visibly scrolled DOWN into place instead of
	 * opening at the bottom. That was a shipped regression, twice removed from
	 * anything a test on the pure gate could have caught.
	 */
	it("glides ONLY the stamped tail-growth correction", async () => {
		const source = await shell();
		// The one glide entry point: a bottom correction the coordinator stamped as
		// tail growth (streaming row / appended message / live patch at the tail).
		expect(source).toContain('anchorKind === "bottom" && smoothFollow === true');
		expect(source).toContain("getSmoothFollower().ensure();");
		// And it is the ONLY one. `ensure()` anywhere else is how the mount animation
		// came back.
		expect(source.match(/getSmoothFollower\(\)\.ensure\(\)/g)?.length).toBe(1);
	});

	it("the pin effect SNAPS, standing down only for an active chase", async () => {
		const source = await shell();
		const pinEffect = source.slice(
			source.indexOf("const scrollGeometryRevision ="),
			source.indexOf("// First-screen fill:"),
		);
		// Yields to a chase (an unconditional write would land at the bottom on the
		// next frame and cut every streaming glide short)…
		expect(pinEffect).toContain("if (smoothFollowerRef.current?.isActive() === true) return;");
		// …otherwise snaps, exactly as it did before any of this work.
		expect(pinEffect).toContain("writeScrollTop(getScrollBottomTarget(viewportRef.current));");
	});

	it("non-glide corrections still land instantly and kill any chase in flight", async () => {
		const source = await shell();
		const correction = sliceBracketedRegion(source, "const onScrollTopCorrection = useCallback(");
		if (correction === null) throw new Error("Missing scroll correction callback");
		// Anchored rebuilds / fold / LOD / removals keep their committed-geometry
		// semantics: same instant write as before, and no chase survives them.
		expect(correction).toContain("getSmoothFollower().cancel();");
		expect(correction).toMatch(
			/writeScrollTop\(\s*applyExactScrollCorrection\(correctionTop, anchorKind, footerHeightRef\.current\),?\s*\);/,
		);
	});

	it("the chase dies with the pin on EVERY reader-intent path", async () => {
		const source = await shell();
		// wheel-up detach.
		const detach = source.slice(
			source.indexOf("const detachFromBottom = useCallback("),
			source.indexOf("const detachFromBottom = useCallback(") + 400,
		);
		expect(detach).toContain("getSmoothFollower().cancel();");
		// Any non-echo upward movement caught by processScrollFrame.
		const frame = source.slice(
			source.indexOf("const processScrollFrame = useCallback("),
			source.indexOf("const onScroll = useCallback("),
		);
		expect(frame).toContain("if (!effectiveAtBottom) getSmoothFollower().cancel();");
		// Explicit jumps: scrollToBottom handle, user-marker jump, message reveal.
		const toBottom = source.slice(
			source.indexOf("const scrollToBottom = useCallback("),
			source.indexOf("const scrollToBottom = useCallback(") + 500,
		);
		expect(toBottom).toContain("getSmoothFollower().cancel();");
		const reveal = source.slice(
			source.indexOf("const scrollToMessageTarget = useCallback("),
			source.indexOf("const scrollToMessageTarget = useCallback(") + 900,
		);
		expect(reveal).toContain("getSmoothFollower().cancel();");
	});

	it("fold and LOD transitions land the chase BEFORE capturing geometry", async () => {
		const source = await shell();
		// Both plan their FLIP/morph against the predicted bottom while pinned; a
		// chase still gliding would move rows under the running animation.
		const foldCapture = source.slice(
			source.indexOf("const captureFoldBefore = useCallback("),
			source.indexOf("const captureFoldBefore = useCallback(") + 700,
		);
		expect(foldCapture).toContain("smoothFollowerRef.current?.snapToTarget();");
		const lodEmit = source.slice(
			source.indexOf("const emit = (dir: 1 | -1"),
			source.indexOf("const emit = (dir: 1 | -1") + 500,
		);
		expect(lodEmit).toContain("smoothFollowerRef.current?.snapToTarget();");
	});

	it("readCurrentView treats an active chase AS the bottom pin", async () => {
		// Without this the chase's own lag makes every streaming commit capture an
		// ITEM anchor, whose correction cancels the chase it should feed (thrash).
		const source = await shell();
		const view = sliceBracketedRegion(source, "const readCurrentView = useCallback(");
		if (view === null) throw new Error("Missing live view callback");
		expect(view).toContain("const view = readViewportView();");
		const viewportView = sliceBracketedRegion(source, "const readViewportView = useCallback(");
		if (viewportView === null) throw new Error("Missing visible viewport view callback");
		expect(viewportView).toContain("visibleViewportRef.current.read(");
		expect(viewportView).toContain("smoothFollowerRef.current?.isActive()");
	});

	it("the chase never outlives the shell", async () => {
		const source = await shell();
		expect(source).toContain("useEffect(() => () => smoothFollowerRef.current?.cancel(), []);");
	});
});

describe("anchored rebuild keeps the reader's position exactly", () => {
	async function layoutIndex(itemCount: number) {
		const { buildPretextLayoutIndex } = await import("@shared/pretext-layout");
		return buildPretextLayoutIndex({
			layoutRevision: "pin",
			documentRevision: "pin",
			lod: 5,
			widthBucket: "800",
			metrics: { topPadding: 16, itemGap: 12, bottomPadding: 16 },
			items: Array.from({ length: itemCount }, (_, index) => ({
				itemKey: `pin-${index}`,
				firstSeq: index,
				lastSeq: index,
				sourceMessageIds: [`pin-m${index}`],
				kind: "markdown",
				height: 20,
			})),
		});
	}

	it("restores a position sitting in the gap BETWEEN two items without jumping", async () => {
		const { capturePretextLayoutAnchor, restorePretextLayoutAnchor } = await import(
			"@shared/pretext-layout"
		);
		const before = await layoutIndex(8);
		const after = await layoutIndex(9); // a message landed / the row grew
		// Items are at 16, 48, 80 … with a 12px gap, so 40 sits in a gap.
		for (const scrollTop of [36, 40, 44, 68, 72]) {
			const anchor = capturePretextLayoutAnchor(before, scrollTop, 600, false);
			expect(restorePretextLayoutAnchor(anchor, after, 600)).toBeCloseTo(scrollTop, 5);
		}
	});

	it("still restores a position INSIDE an item exactly (unchanged behaviour)", async () => {
		const { capturePretextLayoutAnchor, restorePretextLayoutAnchor } = await import(
			"@shared/pretext-layout"
		);
		const before = await layoutIndex(8);
		const after = await layoutIndex(9);
		for (const scrollTop of [16, 20, 48, 60, 80]) {
			const anchor = capturePretextLayoutAnchor(before, scrollTop, 600, false);
			expect(restorePretextLayoutAnchor(anchor, after, 600)).toBeCloseTo(scrollTop, 5);
		}
	});

	it("keeps honouring an explicit focus point (LOD zoom)", async () => {
		const { capturePretextLayoutAnchor, restorePretextLayoutAnchor } = await import(
			"@shared/pretext-layout"
		);
		const index = await layoutIndex(8);
		// The content under the cursor must stay put, not jump to the viewport top.
		const anchor = capturePretextLayoutAnchor(index, 16, 600, false, { focusOffset: 84 });
		expect(anchor.kind).toBe("item");
		expect(restorePretextLayoutAnchor(anchor, index, 600)).toBeCloseTo(16, 5);
	});

	it("pins to the bottom by distance when the reader is at the bottom", async () => {
		const { capturePretextLayoutAnchor, restorePretextLayoutAnchor } = await import(
			"@shared/pretext-layout"
		);
		// Enough items that the content actually overflows the viewport, otherwise
		// there is no scroll range and every position is trivially 0.
		const viewportHeight = 300;
		const before = await layoutIndex(40);
		const after = await layoutIndex(44);
		expect(before.totalHeight).toBeGreaterThan(viewportHeight);
		const anchor = capturePretextLayoutAnchor(
			before,
			before.totalHeight - viewportHeight,
			viewportHeight,
			true,
		);
		expect(anchor.kind).toBe("bottom");
		// Still at the bottom of the GROWN document.
		expect(restorePretextLayoutAnchor(anchor, after, viewportHeight)).toBeCloseTo(
			after.totalHeight - viewportHeight,
			5,
		);
	});
});
