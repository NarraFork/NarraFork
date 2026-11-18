/**
 * What a client watches from what its views show (`level-loader.ts`): a subtree whole when it
 * fits, by levels where it is too large, what an opened block too large shows, and nothing under
 * a closed one; the root comes with its parent's level.
 */
import { describe, expect, test } from "bun:test";
import { buildFoldTree, type FoldView } from "@shared/outline-fold";
import {
	type LiveCloseCode,
	type LiveWatchWire,
	liveWatchKey,
	OUTLINE_LIVE_LIMITS,
} from "@shared/outline-live-protocol";
import { LevelLoader, LOADER_BATCH } from "./level-loader";
import { LiveClient, type LiveTransport } from "./live-client";
import { liveFoldSource } from "./live-fold";
import { Store } from "./store";

/** page → big (too large) → a, b; page → small → s1; a → a1 (loaded by `s:a` only). */
function setup(options: {
	set: string[];
	asked?: string[];
	refused?: Record<string, LiveCloseCode>;
	view?: FoldView;
	root?: string;
}) {
	const scope = { roots: new Set<string>(), levels: new Set<string>() };
	for (const k of options.set) {
		if (k.startsWith("s:")) scope.roots.add(k.slice(2));
		else scope.levels.add(k.slice(2));
	}
	const store = new Store("page", scope);
	const put = (id: string, parentId: string | null, orderKey: string) =>
		store.put({ id, parentId, orderKey, task: null, deleted: false, sid: id });
	put("page", null, "a0");
	put("big", "page", "a0");
	put("small", "page", "a1");
	put("a", "big", "a0");
	put("b", "big", "a1");
	if (scope.roots.has("small")) put("s1", "small", "a0");
	if (scope.roots.has("a")) put("a1", "a", "a0");
	const refused = new Map(Object.entries(options.refused ?? {}));
	const client = {
		visible: store,
		pageId: "page",
		ready: true,
		status: "live",
		watchRefused: refused,
		watching: (key: string) =>
			options.set.includes(key) ? "set" : (options.asked ?? []).includes(key) ? "asked" : null,
		get watchSet() {
			return options.set.map((k) =>
				k.startsWith("s:") ? { s: k.slice(2) } : { l: k.slice(2) || null },
			);
		},
		textOf: () => "",
		on: () => () => {},
		watch: () => {},
		forgetMadeHere: () => {},
	} as unknown as LiveClient;
	const tree = buildFoldTree(
		liveFoldSource(client, { marks: new Map(), questionsKnown: true }),
		{ rootId: options.root ?? "page" },
		options.view,
	);
	const loader = new LevelLoader(client);
	loader.add({ foldTrees: () => [tree] });
	const keys = () => [...(loader.wanted()?.keys() ?? [])].sort();
	return { loader, keys, client };
}

describe("what the views need watched", () => {
	test("a root watched whole needs nothing more", () => {
		const { keys } = setup({ set: ["s:page"] });
		expect(keys()).toEqual(["s:page"]);
	});

	test("a block focused inside the root's subtree keeps the root's watch", () => {
		const { keys } = setup({ set: ["s:page"], root: "big" });
		expect(keys()).toEqual(["s:page"]);
	});

	test("a root too large: its level, its parent's level, each child whole", () => {
		const { keys } = setup({
			set: ["l:", "l:page"],
			refused: { "s:page": "too_large" },
		});
		expect(keys()).toEqual(["l:", "l:page", "s:big", "s:small"].sort());
	});

	test("a child too large and open (a fact): its level and its children whole", () => {
		const { keys } = setup({
			set: ["l:", "l:page", "l:big", "s:small"],
			refused: { "s:page": "too_large", "s:big": "too_large" },
		});
		expect(keys()).toEqual(["l:", "l:big", "l:page", "s:a", "s:b", "s:small"].sort());
	});

	test("closed by the reader: only its level (what it showed is let go)", () => {
		const { keys, loader, client } = setup({
			set: ["l:", "l:page", "l:big", "s:small", "s:a", "s:b"],
			refused: { "s:page": "too_large", "s:big": "too_large" },
			view: { expanded: new Set(), collapsed: new Set(["big"]) },
		});
		expect(keys()).toEqual(["l:", "l:big", "l:page", "s:small"].sort());
		let change: unknown = null;
		(client as unknown as { watch: (c: unknown) => void }).watch = (c) => {
			change = c;
		};
		loader.run();
		expect(change).toEqual({ add: [], remove: [{ s: "a" }, { s: "b" }] });
	});

	test("a level stays while the whole subtree is on its way; refused otherwise, not asked again", () => {
		const loading = setup({
			set: ["l:", "l:page", "l:big", "s:small"],
			asked: ["s:big"],
			refused: { "s:page": "too_large" },
		});
		expect(loading.keys()).toEqual(["l:", "l:big", "l:page", "s:big", "s:small"].sort());
		const full = setup({
			set: ["l:", "l:page"],
			refused: { "s:page": "too_large", "s:small": "user_limit" },
		});
		let change: { add: Array<{ s?: string; l?: string | null }> } | null = null;
		(full.client as unknown as { watch: (c: unknown) => void }).watch = (c) => {
			change = c as never;
		};
		full.loader.run();
		const added = (
			(change as { add: Array<{ s?: string; l?: string | null }> } | null)?.add ?? []
		).map((w) => liveWatchKey(w as never));
		// Refused for the person's share: its level (far smaller) is asked for instead.
		expect(added).toEqual(["s:big", "l:small"]);
		expect([...full.loader.notLoaded]).toEqual([]);
		// Refused by the server's limits: not by its level either; it is listed.
		const limited = setup({
			set: ["l:", "l:page"],
			refused: { "s:page": "too_large", "s:small": "unavailable" },
		});
		let next: { add: Array<{ s?: string; l?: string | null }> } | null = null;
		(limited.client as unknown as { watch: (c: unknown) => void }).watch = (c) => {
			next = c as never;
		};
		limited.loader.run();
		expect(
			((next as { add: Array<{ s?: string; l?: string | null }> } | null)?.add ?? []).map((w) =>
				liveWatchKey(w as never),
			),
		).toEqual(["s:big"]);
		expect([...limited.loader.notLoaded]).toEqual([["small", "unavailable"]]);
	});
});

describe("wide levels", () => {
	/** A real client (not connected) watching `page` and `big` by levels, `big` open. */
	function wide(n: number, watchedWhole: number, view?: FoldView) {
		const transport = {
			connected: false,
			send: () => true,
			onFrame: () => () => {},
			onConnectionChange: () => () => {},
			allocateHandle: () => 1,
			releaseHandle: () => {},
		} as unknown as LiveTransport;
		const watch: LiveWatchWire[] = [{ l: null }, { l: "page" }, { l: "big" }];
		for (let i = 0; i < watchedWhole; i++) watch.push({ s: `k${i}` });
		const client = new LiveClient(transport, "page", "edit", { space: "sp", watch });
		const put = (id: string, parentId: string | null, orderKey: string) =>
			client.visible.put({ id, parentId, orderKey, task: null, deleted: false, sid: id });
		put("page", null, "a0");
		put("big", "page", "a0");
		for (let i = 0; i < n; i++) put(`k${i}`, "big", `b${String(i).padStart(5, "0")}`);
		client.watchRefused.set("s:page", "too_large");
		client.watchRefused.set("s:big", "too_large");
		const tree = buildFoldTree(
			liveFoldSource(client, { marks: new Map(), questionsKnown: true }),
			{ rootId: "page" },
			view,
		);
		const loader = new LevelLoader(client);
		loader.add({ foldTrees: () => [tree] });
		return { loader, client };
	}

	test("what a level of 1,900 children wants is worked out in a few ms (the watch set is indexed)", () => {
		const { loader } = wide(1900, 1000);
		loader.wanted();
		const t0 = performance.now();
		for (let i = 0; i < 5; i++) loader.wanted();
		const ms = (performance.now() - t0) / 5;
		console.log(`wanted() over 1,900 children: ${ms.toFixed(2)} ms`);
		// (Was ~68 ms with a scan of the set per block; a generous bound for slow machines.)
		expect(ms).toBeLessThan(25);
	});

	test("a block made here and folded away before its watch was asked is no longer known-empty", () => {
		const made = (c: LiveClient) => (c as unknown as { madeHere: Set<string> }).madeHere;
		const live = (c: LiveClient) => {
			(c as unknown as { ready: boolean }).ready = true;
			(c as unknown as { status: string }).status = "live";
			(c as unknown as { watch: () => void }).watch = () => {};
		};
		// Shown: kept (its watch is about to be asked).
		const shown = wide(3, 0);
		live(shown.client);
		made(shown.client).add("k1");
		shown.loader.run();
		expect(shown.client.childrenKnown("k1")).toBe(true);
		// Folded away (its parent closed) with no watch asked: unknown.
		const hidden = wide(3, 0, { expanded: new Set(), collapsed: new Set(["big"]) });
		live(hidden.client);
		made(hidden.client).add("k1");
		hidden.loader.run();
		expect(hidden.client.childrenKnown("k1")).toBe(false);
		// Not in any tree yet (a view not projected since): kept.
		const fresh = wide(3, 0);
		live(fresh.client);
		made(fresh.client).add("new");
		fresh.loader.run();
		expect(fresh.client.childrenKnown("new")).toBe(true);
	});

	test("new watches are asked for a batch at a time", () => {
		const { loader, client } = wide(300, 0);
		let change: { add: unknown[] } | null = null;
		(client as unknown as { watch: (c: unknown) => void }).watch = (c) => {
			change = c as never;
		};
		(client as unknown as { ready: boolean }).ready = true;
		(client as unknown as { status: string }).status = "live";
		loader.run();
		expect((change as { add: unknown[] } | null)?.add.length).toBe(LOADER_BATCH);
	});

	test("the watch set never grows past the budget: the children past it are listed, not asked for", () => {
		const { loader } = wide(1100, 0);
		const notLoaded = new Map();
		const want = loader.wanted(notLoaded);
		expect(want?.size).toBe(OUTLINE_LIVE_LIMITS.watchBudget);
		// The root's levels and the open block's level come first; then children in order.
		expect(want?.has("l:big")).toBe(true);
		expect(want?.has("s:k0")).toBe(true);
		expect(want?.has("s:k1099")).toBe(false);
		expect(notLoaded.size).toBe(1100 - (OUTLINE_LIVE_LIMITS.watchBudget - 3));
		expect(notLoaded.get("k1099")).toBe("watch_cap");
	});

	test("watches held and asked for count first: new ones take only the room left", () => {
		const budget = OUTLINE_LIVE_LIMITS.watchBudget;
		// The three levels and 500 children held, 6 more asked for: 3 left.
		const { loader, client } = wide(700, 500);
		const asked = Array.from({ length: 6 }, (_, i) => ({ s: `k${500 + i}` }));
		(client as unknown as { watchAsked: Map<string, unknown> }).watchAsked = new Map(
			asked.map((w) => [liveWatchKey(w), w]),
		);
		const notLoaded = new Map();
		const want = loader.wanted(notLoaded);
		expect(want?.size).toBe(budget);
		const fresh = [...(want?.keys() ?? [])].filter((k) => client.watching(k) === null);
		expect(fresh).toEqual(["s:k506", "s:k507", "s:k508"]);
		expect(notLoaded.get("k509")).toBe("watch_cap");
	});

	test("a refusal for room is forgotten when the block is closed, or when watches are let go", () => {
		// `a` was refused for the person's share; the reader closes `big`: forgotten.
		const closed = setup({
			set: ["l:", "l:page", "l:big", "s:small", "s:b"],
			refused: { "s:page": "too_large", "s:big": "too_large", "s:a": "user_limit" },
			view: { expanded: new Set(), collapsed: new Set(["big"]) },
		});
		closed.loader.run();
		expect(closed.client.watchRefused.has("s:a")).toBe(false);
		const shown = setup({
			set: ["l:", "l:page", "l:big", "s:a", "s:b", "s:x"],
			refused: { "s:page": "too_large", "s:big": "too_large", "s:small": "user_limit" },
		});
		// Still shown, nothing let go: kept (not asked again).
		const kept = setup({
			set: ["l:", "l:page", "l:big", "s:a", "s:b"],
			refused: { "s:page": "too_large", "s:big": "too_large", "s:small": "user_limit" },
		});
		kept.loader.run();
		expect(kept.client.watchRefused.get("s:small")).toBe("user_limit");
		// `s:x` is no longer wanted: let go, so the refusal is forgotten (room may be there).
		shown.loader.run();
		expect(shown.client.watchRefused.has("s:small")).toBe(false);
	});
});
