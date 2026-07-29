/**
 * Regression guards for {@link ChunkedMessageList}'s chunk window: HOW MUCH of it
 * loads when a narrator page opens, and WHERE the control that extends it sits.
 *
 * Two separate bugs, merged into one file because they share every bit of
 * scaffolding and — more importantly — because they are two halves of the same
 * design rule: viewport differences must be a *number* fed through one shared
 * code path, never a second code path.
 *
 * ## Group 1 — initial load volume
 *
 * User report: "opening a narrator on mobile loads a lot of old messages and is
 * very laggy", reproduced on an iPhone-class viewport at 4x CPU throttling
 * against a 76.8k-message narrator:
 *
 *   request 1  chunk-manifest?limitChunks=10        10 tuples,   ~1KB
 *   request 2  chunks?direction=older&count=1       20 messages, ~345KB
 *   request 3  chunks?...&direction=newer&count=3   60 messages, ~750KB   <-- this
 *
 * Request 3 was not the initial snapshot. The initial load is deliberately
 * `INITIAL_CONTENT_CHUNKS = 1`, but the list then mounted a band of
 * `centre ± 3` chunks and called `ensureLoaded(centre, 3)` to fill it, which
 * fetched three more chunks before the user touched anything. On a 390px-wide
 * viewport at most one chunk is visible, so those 60 messages were parsed,
 * rendered and measured on the main thread during first paint for nothing.
 *
 * `chunk-scroll-utils.test.ts` pins the radius *numbers*; numbers alone cannot
 * prove the list actually asks for less. This group asserts the observable
 * contract — the `count` the component requests — because that is what the
 * server work, the transfer size and the render cost are all proportional to.
 *
 * ## Group 2 — manual "load older messages" control placement
 *
 * Mobile and desktop rendered the control through two different paths. Mobile
 * put it in a `flexShrink: 0` Box that was a *flex sibling* of the scroll
 * container, so it was pinned to the top of the panel forever — visible while
 * reading the newest messages, floating over the list, and never scrolling away.
 * Desktop rendered it inside the scroller above the first chunk, which is the
 * behaviour users expect: reachable only once you scroll to the very top.
 *
 * `ManualOlderHistoryLoad.test.tsx` could not catch this because it renders the
 * component standalone and only asserts its two visibility branches. Position is
 * a property of the *list*, so it has to be pinned here, and pinned as a real
 * ancestor relationship rather than a source-text pattern — an equivalent
 * refactor (portal, wrapper component, different prop name) must keep passing
 * while any move back out of the scroller must fail.
 *
 * linkedom has no layout engine (all rects are zero, `clientHeight` is
 * undefined), so that contract is expressed in the terms that survive it:
 * ancestry and sibling order, which is exactly what the bug got wrong.
 *
 * ## Isolation
 *
 * Everything structural is the real component: the scroller Box, the content
 * div, the `showManualOlderHistoryLoad` condition and the sibling order. Only
 * the list's *inputs* are controlled, and deliberately without `mock.module`:
 * `api` methods are swapped per-test and restored in `afterEach`, and the
 * preference is served from the stubbed api. Bun's `mock.module` is process-wide
 * and survives `mock.restore()`, so replacing a module every other narrator test
 * also imports (`./useNarratorChunks`, `./MessageRenderer`) races with those
 * files' own assertions — observed as an intermittent failure in
 * `useNarratorChunks.test.ts` when the two ran together. DOM globals go through
 * `savedGlobals`/`restoreGlobals` so they are put back for the next file.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import type {
	ChunkManifest,
	ChunkManifestTuple,
	ChunkRangeResult,
	TreeMessage,
} from "../../lib/api";
import { api } from "../../lib/api";
import { narratorWSManager } from "../../lib/narrator-ws-manager";
import narratorLocale from "../../locales/en/narrator.json";
import { ChunkedMessageList } from "./ChunkedMessageList";
import { DESKTOP_CHUNK_BAND_RADIUS, MOBILE_CHUNK_BAND_RADIUS } from "./chunk-scroll-utils";
import { clearNarratorChunksCache } from "./narrator-chunks-cache";
import type { PermissionCallbacks } from "./narrator-panel-types";

/**
 * Narrator id, deliberately unique to this file.
 *
 * `narratorWSManager` is a process-wide singleton and the list writes catch-up
 * cursors into it keyed by narrator id. `useNarratorChunks.test.ts` isolates
 * itself by clearing exactly `"n1"`/`"n2"` around each of its tests, so reusing
 * one of those ids here made this file's committed cursor land in the same slot
 * — observed as an intermittent failure of that file's
 * "does not stage N1 activity anchors for N2" case (a child anchor arriving with
 * `narratorId: undefined`). Own a private key and clear it in afterEach.
 */
const NARRATOR_ID = "chunked-list-chunk-window";

const LOAD_OLDER_LABEL = narratorLocale.loadOlderMessages;

/**
 * `Node.DOCUMENT_POSITION_FOLLOWING`. Spelled out because linkedom implements
 * `compareDocumentPosition()` but does not publish the DOM `DOCUMENT_POSITION_*`
 * constants on its `Node`, so reading them off the global silently yields
 * `undefined` and makes the mask match everything.
 */
const DOCUMENT_POSITION_FOLLOWING = 4;

/** Server-side chunking granularity (`CHUNK_SIZE` in narrator-messages.ts). */
const CHUNK_SIZE = 20;
/** Chunks the manifest advertises: comfortably more than any band under test. */
const MANIFEST_CHUNKS = 10;
const TOTAL_MESSAGES = MANIFEST_CHUNKS * CHUNK_SIZE;
/**
 * Absolute ceiling on messages a mobile open may request, independent of the
 * band constants.
 *
 * Deliberately NOT derived from `MOBILE_CHUNK_BAND_RADIUS`: a bound expressed in
 * terms of the constant it is guarding moves with it, so widening the band back
 * to the desktop radius would keep such an assertion green. The measured
 * pre-fix volume was 80 messages (1 + 3 chunks); 60 is the largest total that
 * still corresponds to "a phone loads a few screens, not a band it cannot show".
 */
const MAX_MOBILE_OPEN_MESSAGES = 60;

const testI18n = i18next.createInstance();
await testI18n.use(initReactI18next).init({
	lng: "en",
	fallbackLng: "en",
	defaultNS: "narrator",
	ns: ["narrator"],
	resources: { en: { narrator: narratorLocale } },
	interpolation: { escapeValue: false },
	react: { useSuspense: false },
});

class TestResizeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}

/** Restored in afterEach — these are properties, not modules, so they cannot leak. */
const realApi = {
	getChunkManifest: api.getChunkManifest,
	getNarratorChunks: api.getNarratorChunks,
	getUserPreferences: api.getUserPreferences,
};

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let queryClient: QueryClient | undefined;
/** The node ChunkedMessageList passes to its `scrollRef` — i.e. the real scroller. */
let scrollerNode: HTMLElement | null = null;
/** The node it passes to `contentRef` — the in-scroller content wrapper. */
let contentNode: HTMLElement | null = null;

interface ChunkRequest {
	fromSeq?: number;
	direction?: "older" | "newer";
	count?: number;
}
/** Every `/chunks` request the component issued, in order. */
let chunkRequests: ChunkRequest[] = [];

function stubMessage(seq: number): TreeMessage {
	return {
		id: `m${seq}`,
		narratorId: NARRATOR_ID,
		role: "user",
		parentToolUseId: null,
		contentJson: [],
		contentText: `m${seq}`,
		toolCalls: [],
		children: [],
		createdAt: "2026-07-18T00:00:00.000Z",
		seq,
	} as unknown as TreeMessage;
}

/** Manifest tuples for a tail-anchored window of `MANIFEST_CHUNKS` chunks. */
function manifestTuples(): ChunkManifestTuple[] {
	const tuples: ChunkManifestTuple[] = [];
	for (let i = 0; i < MANIFEST_CHUNKS; i++) {
		const firstSeq = i * CHUNK_SIZE + 1;
		tuples.push([`m${firstSeq}`, firstSeq, firstSeq + CHUNK_SIZE - 1, CHUNK_SIZE]);
	}
	return tuples;
}

interface Fixture {
	/**
	 * Whether the served manifest/range claim history exists *beyond* the window.
	 *
	 * The only intentional fixture difference between the two groups: it is the
	 * trigger for the manual older-history control, so the placement group needs
	 * it on, and the "history exhausted" case needs it off. The volume group does
	 * not care and leaves it at the default.
	 */
	hasOlder?: boolean;
}

/**
 * Swap the three `api` methods the list calls. Serves a realistic tail-anchored
 * `MANIFEST_CHUNKS` x `CHUNK_SIZE` history and records every `/chunks` request.
 *
 * Always recording is intentional: the request log is what the volume group
 * asserts on, and having it present for the placement group too costs nothing
 * and keeps a single stub implementation.
 */
function installApiStubs({ hasOlder = false }: Fixture = {}) {
	chunkRequests = [];
	api.getUserPreferences = (async () => ({
		// The manual control only exists when the *persisted* preference is false;
		// the component distinguishes "fetched false" from "still loading" on
		// purpose. Both groups need it: it also stops auto-load from issuing extra
		// requests behind the volume assertions.
		autoLoadOlderMessages: false,
	})) as unknown as typeof api.getUserPreferences;
	api.getChunkManifest = (async (): Promise<ChunkManifest> => ({
		unchanged: false,
		messageVersion: 1,
		total: TOTAL_MESSAGES,
		windowFirstIndex: 0,
		hasOlderChunks: hasOlder,
		chunks: manifestTuples(),
	})) as unknown as typeof api.getChunkManifest;
	api.getNarratorChunks = (async (_id: string, opts?: ChunkRequest): Promise<ChunkRangeResult> => {
		chunkRequests.push({ ...opts });
		// Serve exactly what was asked for, anchored the way the server does, so the
		// component's own bookkeeping (and therefore its follow-up requests) is real.
		const count = opts?.count ?? 1;
		const wanted = count * CHUNK_SIZE;
		let startSeq: number;
		if (opts?.direction === "newer") {
			startSeq = opts?.fromSeq ?? 1;
		} else {
			startSeq = Math.max(1, TOTAL_MESSAGES - wanted + 1);
		}
		const messages: TreeMessage[] = [];
		for (let seq = startSeq; seq < startSeq + wanted && seq <= TOTAL_MESSAGES; seq++) {
			messages.push(stubMessage(seq));
		}
		return {
			messages,
			minSeq: messages[0]?.seq ?? 0,
			maxSeq: messages[messages.length - 1]?.seq ?? 0,
			hasOlder,
			hasNewer: false,
			messageVersion: 1,
		} as unknown as ChunkRangeResult;
	}) as unknown as typeof api.getNarratorChunks;
}

/**
 * Keys this file publishes on `globalThis`, and their pre-existing descriptors.
 *
 * The realm must not outlive the file: `parseHTML()` mints a fresh `Event` class
 * per call, and a leaked one fails a later file's `dispatchEvent(new Event(…))`
 * instance check. Bun runs every file in one process, so restoring is this file's
 * own responsibility.
 */
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();

function installDom() {
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	const matchMedia = (query: string) => ({
		matches: false,
		media: query,
		onchange: null,
		addListener() {},
		removeListener() {},
		addEventListener() {},
		removeEventListener() {},
		dispatchEvent: () => false,
	});
	const requestAnimationFrame = (callback: FrameRequestCallback) =>
		setTimeout(() => callback(Date.now()), 0) as unknown as number;
	const cancelAnimationFrame = (handle: number) => clearTimeout(handle);
	// The list reads a reading-width preference through `useLocalPref`, which hits
	// `localStorage` during render — Bun's global has none, and linkedom does not
	// ship one, so without this the very first render throws.
	const store = new Map<string, string>();
	const localStorage = {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => void store.set(key, value),
		removeItem: (key: string) => void store.delete(key),
		clear: () => store.clear(),
		key: (index: number) => Array.from(store.keys())[index] ?? null,
		get length() {
			return store.size;
		},
	};
	const globals = {
		window,
		document: window.document,
		navigator: window.navigator,
		Event: window.Event,
		MouseEvent: window.MouseEvent ?? window.Event,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		Text: window.Text,
		// linkedom ships MutationObserver but neither observer the list needs.
		MutationObserver: window.MutationObserver,
		ResizeObserver: TestResizeObserver,
		matchMedia,
		requestAnimationFrame,
		cancelAnimationFrame,
		getComputedStyle: () => ({ getPropertyValue: () => "" }),
		localStorage,
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	for (const [key, value] of Object.entries(globals)) {
		const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
		if (!savedGlobals.has(key)) savedGlobals.set(key, descriptor);
		if (descriptor && !descriptor.configurable) {
			if ("writable" in descriptor && descriptor.writable) Reflect.set(globalThis, key, value);
			continue;
		}
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
}

function restoreGlobals() {
	for (const [key, descriptor] of savedGlobals) {
		const current = Object.getOwnPropertyDescriptor(globalThis, key);
		if (current && !current.configurable) continue;
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	savedGlobals.clear();
}

const PERM_CB: PermissionCallbacks = {
	pendingPermission: null,
	pendingPermissions: [],
	onPermissionDecision: () => {},
	onQuestionSubmit: () => {},
	onQuestionReflect: () => {},
	onQuestionDeny: () => {},
};

/**
 * Reset the two process-wide singletons the list writes into, so each test opens
 * a genuinely cold narrator.
 *
 * `narrator-chunks-cache` is a module-level snapshot store keyed by narrator id.
 * `useNarratorChunks` restores from it on mount to make revisits instant, which
 * means a surviving snapshot makes the NEXT test skip its initial `older` request
 * and start from the restored window instead. That is not hypothetical: with only
 * the WS-manager cleared, "no single mobile request exceeds a few chunks" saw
 * `[{direction:"newer",count:1}]` in a whole-file run but
 * `[{direction:"older",count:1},{direction:"newer",count:3}]` when run alone —
 * i.e. the assertion silently stopped observing the request it exists to guard.
 * `useNarratorChunks.test.ts` calls `clearNarratorChunksCache()` in its own hooks
 * for the same reason.
 *
 * `narratorWSManager` is a process-wide singleton the list writes catch-up
 * cursors into, also keyed by narrator id — cleared here so nothing lands in
 * another file's slot (see NARRATOR_ID).
 */
function resetSharedNarratorState() {
	clearNarratorChunksCache();
	narratorWSManager.clearCatchUpState(NARRATOR_ID);
}

/**
 * Drain microtasks + timers so nothing this file started can land in a LATER
 * file's turn, and so any follow-up request the component intends to make has
 * already been issued by the time an assertion runs.
 *
 * `narratorWSManager.subscribe()` defers its work to a microtask and the list's
 * manifest/range loads are promise chains that write catch-up anchors into that
 * singleton on completion — unmounting does not cancel either. Mirrors the
 * `settle()` helper in `useNarratorChunks.test.ts`, which exists for the same
 * reason.
 */
async function settle() {
	for (let turn = 0; turn < 6; turn++) {
		for (let i = 0; i < 6; i++) await Promise.resolve();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

/**
 * Render the list at a given viewport. `isMobileViewport` is the flag the old
 * code branched on, so every assertion here can be run at both values.
 *
 * `scrollRef`/`contentRef` are always wired up: the placement group asserts
 * against those nodes, and handing them over for the volume group too keeps one
 * render helper instead of two near-identical ones.
 */
async function renderList(options: { isMobileViewport: boolean }): Promise<void> {
	await act(async () => {
		root?.render(
			createElement(
				MantineProvider,
				null,
				createElement(
					I18nextProvider,
					{ i18n: testI18n },
					createElement(
						QueryClientProvider,
						{ client: queryClient as QueryClient },
						createElement(ChunkedMessageList, {
							narratorId: NARRATOR_ID,
							permCb: PERM_CB,
							isMobileViewport: options.isMobileViewport,
							scrollRef: (node: HTMLDivElement | null) => {
								scrollerNode = node;
							},
							contentRef: {
								get current() {
									return contentNode as HTMLDivElement | null;
								},
								set current(node: HTMLDivElement | null) {
									contentNode = node;
								},
							} as React.RefObject<HTMLDivElement | null>,
						}) as ReactNode,
					),
				),
			),
		);
	});
	// The initial manifest + range are promise chains and the band top-up runs from
	// a commit effect afterwards, so let all of that settle before asserting.
	await act(async () => {
		await settle();
	});
}

/**
 * Tear the tree down and start over on a fresh root and fixture, so a second
 * render inside one test is measured as a genuine "open" rather than an update.
 */
async function remount(fixture: Fixture = {}): Promise<void> {
	await act(async () => root?.unmount());
	container?.remove();
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	scrollerNode = null;
	contentNode = null;
	resetSharedNarratorState();
	installApiStubs(fixture);
}

/** The rendered "load older" button, wherever it ended up in the tree. */
function loadOlderButton(): HTMLElement | null {
	const buttons = Array.from(container?.querySelectorAll<HTMLElement>("button") ?? []);
	return buttons.find((button) => button.textContent?.includes(LOAD_OLDER_LABEL)) ?? null;
}

function ancestorsOf(node: HTMLElement): HTMLElement[] {
	const chain: HTMLElement[] = [];
	let current = node.parentElement;
	while (current) {
		chain.push(current);
		current = current.parentElement;
	}
	return chain;
}

/**
 * The scroll container, identified the way a browser would: the element that
 * declares `overflow-y: auto`. Cross-checked against the node the component
 * hands to `scrollRef` so a future refactor cannot quietly point this test at
 * some other scrollable wrapper.
 */
function scrollContainer(): HTMLElement {
	const scrollers = Array.from(container?.querySelectorAll<HTMLElement>("div") ?? []).filter(
		(node) => node.style.overflowY === "auto",
	);
	expect(scrollers).toHaveLength(1);
	const scroller = scrollers[0];
	expect(scroller).toBe(scrollerNode as HTMLElement);
	return scroller;
}

/** A rendered message row, used as "the first content block" landmark. */
function firstContentBlock(): HTMLElement | null {
	return container?.querySelector<HTMLElement>("[data-message-id], [id^='msg-']") ?? null;
}

/** Total messages the component asked the server for, across all /chunks calls. */
function requestedMessageCount(): number {
	return chunkRequests.reduce((total, req) => total + (req.count ?? 1) * CHUNK_SIZE, 0);
}

beforeEach(() => {
	installDom();
	installApiStubs();
	resetSharedNarratorState();
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
	});
	scrollerNode = null;
	contentNode = null;
});

afterEach(async () => {
	if (root) await act(async () => root?.unmount());
	// Let the unmounted tree's pending async work finish while this file's DOM
	// globals and api stubs are still installed, THEN restore them.
	await act(async () => {
		await settle();
	});
	container?.remove();
	queryClient?.clear();
	root = undefined;
	container = undefined;
	queryClient = undefined;
	Object.assign(api, realApi);
	// Leave no trace in the process-wide singletons (see resetSharedNarratorState).
	resetSharedNarratorState();
});

afterAll(() => {
	mock.restore();
	restoreGlobals();
});

describe("ChunkedMessageList initial load volume", () => {
	/**
	 * The core contract. Before the fix this totalled 80 messages (1 + 3 chunks);
	 * the mobile band can only justify `radius*2+1` chunks.
	 */
	test("a mobile open never requests more than a few screens of history", async () => {
		await renderList({ isMobileViewport: true });

		expect(chunkRequests.length).toBeGreaterThan(0);
		// Absolute bound (see MAX_MOBILE_OPEN_MESSAGES): pre-fix this was 80.
		expect(requestedMessageCount()).toBeLessThanOrEqual(MAX_MOBILE_OPEN_MESSAGES);
		// And strictly less than the desktop band, so "mobile == desktop" fails here
		// even if someone raises the ceiling above.
		expect(requestedMessageCount()).toBeLessThan((DESKTOP_CHUNK_BAND_RADIUS * 2 + 1) * CHUNK_SIZE);
	});

	/**
	 * The exact request that regressed. No single `/chunks` call may ask for more
	 * chunks than the mobile band contains — that request was `count=3` while only
	 * one chunk could be on screen.
	 */
	test("no single mobile request exceeds a few chunks", async () => {
		await renderList({ isMobileViewport: true });

		// Absolute, for the same reason as MAX_MOBILE_OPEN_MESSAGES: the regressed
		// request was `count=3`, so the bound must not be derived from the radius —
		// and it has to EXCLUDE 3, or the exact regression stays green. (Deriving it
		// as MAX_MOBILE_OPEN_MESSAGES / CHUNK_SIZE yields 3 and does exactly that:
		// verified by setting MOBILE_CHUNK_BAND_RADIUS = 3, which reproduces the
		// `count=3` request while this case still passed.) 2 is the most a legitimate
		// mobile band-fill can ask for: the band spans 3 chunks at radius 1 and the
		// initial `count=1` load already covers one of them.
		const MAX_CHUNKS_PER_MOBILE_REQUEST = 2;
		for (const req of chunkRequests) {
			expect(req.count ?? 1).toBeLessThanOrEqual(MAX_CHUNKS_PER_MOBILE_REQUEST);
		}
		// The band-derived view of the same fact, kept so a radius change that
		// contradicts the mounted window is also caught.
		for (const req of chunkRequests) {
			expect(req.count ?? 1).toBeLessThanOrEqual(MOBILE_CHUNK_BAND_RADIUS * 2 + 1);
		}
	});

	/**
	 * The fix must not be a mobile-only code path bolted alongside a desktop one —
	 * that shape is what broke the manual "load older" control. Desktop keeps its
	 * wider prefetch through the SAME path, which is only observable as a larger
	 * request volume from the same component with a different viewport flag.
	 */
	test("desktop still prefetches a wider band than mobile", async () => {
		await renderList({ isMobileViewport: false });
		const desktopMessages = requestedMessageCount();

		await remount();

		await renderList({ isMobileViewport: true });
		const mobileMessages = requestedMessageCount();

		expect(mobileMessages).toBeLessThan(desktopMessages);
	});

	/**
	 * Reducing the band must not break reaching older history: the tail chunk still
	 * has to be loaded on open (it is the landing spot for realtime messages and
	 * the catch-up cursor seed), so the list is never empty after the fix.
	 */
	test("the newest history is still loaded on open", async () => {
		await renderList({ isMobileViewport: true });

		expect(chunkRequests.length).toBeGreaterThan(0);
		const renderedMessages = container?.querySelectorAll("[data-message-id]").length ?? 0;
		expect(renderedMessages).toBeGreaterThan(0);
	});
});

describe("ChunkedMessageList manual older-history control placement", () => {
	test.each([
		["mobile", true],
		["desktop", false],
	] as const)("on %s the control scrolls with the history instead of floating above it", async (_viewport, isMobileViewport) => {
		installApiStubs({ hasOlder: true });
		await renderList({ isMobileViewport });

		const button = loadOlderButton();
		expect(button).not.toBeNull();
		const scroller = scrollContainer();

		// The contract. A control outside the scroller cannot scroll out of view,
		// which is precisely what users reported: permanently visible at the top.
		expect(scroller.contains(button)).toBe(true);
		expect(ancestorsOf(button as HTMLElement)).toContain(scroller);

		// ...and inside the scroller it must sit in the *scrolled content*, not in
		// some sticky/absolute layer the scroller merely happens to contain.
		expect(contentNode).not.toBeNull();
		expect((contentNode as HTMLElement).contains(button)).toBe(true);

		// Above the first message, so "scroll to the very top" is what reveals it.
		const firstBlock = firstContentBlock();
		expect(firstBlock).not.toBeNull();
		expect(
			(button as HTMLElement).compareDocumentPosition(firstBlock as HTMLElement) &
				DOCUMENT_POSITION_FOLLOWING,
		).toBeGreaterThan(0);
	});

	// The mobile bug's exact shape — the control rendered as a flex SIBLING of the
	// scroller — needs no case of its own: siblings are disjoint subtrees, so the
	// `scroller.contains(button)` assertion above already excludes every sibling of
	// the scroller and of its wrapper.

	/**
	 * Both viewports must resolve to the SAME position, which is the invariant the
	 * two-path implementation violated. Comparing the ancestor chains catches a
	 * reintroduced branch even if both paths were individually "inside a scroller".
	 */
	test("mobile and desktop place the control identically", async () => {
		installApiStubs({ hasOlder: true });
		await renderList({ isMobileViewport: true });
		const mobileChain = ancestorsOf(loadOlderButton() as HTMLElement).map((node) => node.tagName);
		const mobileDepthToScroller = ancestorsOf(loadOlderButton() as HTMLElement).indexOf(
			scrollContainer(),
		);

		await remount({ hasOlder: true });

		await renderList({ isMobileViewport: false });
		const desktopChain = ancestorsOf(loadOlderButton() as HTMLElement).map((node) => node.tagName);
		const desktopDepthToScroller = ancestorsOf(loadOlderButton() as HTMLElement).indexOf(
			scrollContainer(),
		);

		expect(mobileChain).toEqual(desktopChain);
		expect(mobileDepthToScroller).toBe(desktopDepthToScroller);
		expect(mobileDepthToScroller).toBeGreaterThan(-1);
	});

	/**
	 * The user-visible consequence, expressed structurally.
	 *
	 * linkedom implements no layout engine — every `getBoundingClientRect()` is
	 * all-zero and `clientHeight`/`scrollHeight` are `undefined` — so "the button
	 * is above the visible area after scrolling" cannot be *measured* here; a rect
	 * assertion would pass identically for the buggy markup and prove nothing.
	 * What makes the button scroll away is that its offset parent is the scrolled
	 * content: a scroller whose `scrollTop` can advance past it. So assert the two
	 * facts that a browser turns into the observable behaviour — the scroll offset
	 * applies to an ancestor of the button, and the button is positioned in normal
	 * flow rather than pinned by `position: sticky`/`fixed`.
	 */
	test("scrolling the container moves the control out of view", async () => {
		installApiStubs({ hasOlder: true });
		await renderList({ isMobileViewport: true });

		const button = loadOlderButton() as HTMLElement;
		const scroller = scrollContainer();

		// The scroll offset that hides it belongs to an ancestor of the button.
		scroller.scrollTop = 500;
		expect(scroller.scrollTop).toBe(500);
		expect(scroller.contains(button)).toBe(true);

		// A sticky/fixed control would survive that offset, so neither the button
		// nor anything between it and the scroller may opt out of normal flow.
		const upToScroller = ancestorsOf(button);
		const boundary = upToScroller.indexOf(scroller);
		expect(boundary).toBeGreaterThan(-1);
		for (const node of [button, ...upToScroller.slice(0, boundary)]) {
			expect(["", "static", "relative"]).toContain(node.style.position ?? "");
		}
	});

	test("no control is rendered once history is exhausted", async () => {
		installApiStubs({ hasOlder: false });
		await renderList({ isMobileViewport: true });
		expect(loadOlderButton()).toBeNull();
		// The scroller itself must still be there, so the assertion above is really
		// about the control and not about a list that failed to render at all.
		expect(scrollContainer()).toBeDefined();
	});
});
