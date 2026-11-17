/**
 * What a client watches from what its views show (`level-loader.ts`): a subtree whole when it
 * fits, by levels where it is too large, what an opened block too large shows, and nothing under
 * a closed one; the root comes with its parent's level.
 */
import { describe, expect, test } from "bun:test";
import { buildFoldTree, type FoldView } from "@shared/outline-fold";
import { type LiveCloseCode, liveWatchKey } from "@shared/outline-live-protocol";
import { LevelLoader } from "./level-loader";
import type { LiveClient } from "./live-client";
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
			refused: { "s:page": "too_large", "s:small": "user_limit", "l:small": "user_limit" },
		});
		let change: { add: Array<{ s?: string; l?: string | null }> } | null = null;
		(full.client as unknown as { watch: (c: unknown) => void }).watch = (c) => {
			change = c as never;
		};
		full.loader.run();
		const added = (
			(change as { add: Array<{ s?: string; l?: string | null }> } | null)?.add ?? []
		).map((w) => liveWatchKey(w as never));
		expect(added).toEqual(["s:big"]);
	});
});
