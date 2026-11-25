import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import type { CommunicationCandidates } from "@shared/narrator-communication";
import type { PersistedRecentTab } from "@shared/recent-tabs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { api } from "../lib/api";
import { clearToken, confirmAuthUser, getAuthSnapshot, setToken } from "../lib/api/client";
import { narratorWSManager } from "../lib/narrator-ws-manager";
import {
	getRecentTabsScope,
	recentTabsFlatQueryKey,
	recentTabsSectionQueryKey,
} from "../lib/recent-tabs-owner";
import { useNarratorMentionCandidates } from "./useNarratorMentionCandidates";
import type { RecentTabsInfiniteData } from "./useRecentTabs";

let root: Root;
let client: QueryClient;
let search: ReturnType<typeof spyOn<typeof api, "searchCommunicationCandidates">>;
let result: ReturnType<typeof useNarratorMentionCandidates>;
let onAccess: (event: Record<string, unknown>) => void;
const originals = new Map<string, PropertyDescriptor | undefined>();
function Probe({ query = "", source = "source" }: { query?: string; source?: string }) {
	result = useNarratorMentionCandidates(source, query);
	return null;
}
function recent(id: string): PersistedRecentTab {
	return { type: "narrator", id, title: id, folderId: "collapsed", lastVisitedAt: 1 };
}
function scope() {
	const current = getRecentTabsScope();
	if (!current) throw Error("Missing test scope");
	return current;
}
function workKey() {
	return recentTabsSectionQueryKey(scope(), "work");
}
function seed(...items: PersistedRecentTab[]) {
	client.setQueryData<RecentTabsInfiniteData>(workKey(), {
		pages: [{ items, revision: 1, hasMore: true, nextCursor: "next-page" }],
		pageParams: [undefined],
	});
}
const candidateIds = () => result.candidates.map(({ id }) => id);
const signIn = (token: string, user: string) => confirmAuthUser(setToken(token), user);
const eligible = (id: string): CommunicationCandidates => ({
	items: [
		{
			id,
			title: "Server title",
			status: "idle",
			isRecent: true,
			lastActivityAt: null,
			canConnect: true,
		},
	],
	hasMore: false,
});

beforeEach(() => {
	const { window } = parseHTML("<html><body></body></html>");
	const storage = new Map<string, string>();
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		localStorage: {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => storage.set(key, value),
			removeItem: (key: string) => storage.delete(key),
		},
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
	signIn("credential-a", "user-a");
	client.setQueryData(["auth", "me"], { id: "user-a" });
	root = createRoot(document.body.appendChild(document.createElement("div")));
	spyOn(api, "me").mockImplementation(() => new Promise(() => {}));
	spyOn(narratorWSManager, "addListener").mockImplementation((_options, callback) => {
		onAccess = callback;
		return { _id: 1 };
	});
	spyOn(narratorWSManager, "removeListener").mockImplementation(() => {});
	spyOn(narratorWSManager, "getConnectionAuthGeneration").mockImplementation(
		() => getAuthSnapshot().generation,
	);
	search = spyOn(api, "searchCommunicationCandidates").mockRejectedValue(new Error("offline"));
});
afterEach(async () => {
	await act(async () => root.unmount());
	client.clear();
	clearToken();
	mock.restore();
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	originals.clear();
});
async function render(query = "", source = "source") {
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<Probe query={query} source={source} />
			</QueryClientProvider>,
		),
	);
}

test("reads loaded and collapsed folder pages only, even when remote fails", async () => {
	seed(recent("local"), recent("other"));
	const pages = spyOn(api, "getRecentTabsPage");
	await render("loc");
	expect(candidateIds()).toEqual(["local"]);
	expect(result.error).toBe(true);
	expect(pages).not.toHaveBeenCalled();
});

test("a local title wins over a stale remote result; subtitle and status updates don't invalidate candidates", async () => {
	seed({ ...recent("target"), title: "Previous label" });
	search.mockResolvedValue({
		items: [
			{
				id: "target",
				title: "Previous label",
				handle: "stable-handle",
				status: "idle",
				isRecent: true,
				lastActivityAt: null,
				canConnect: true,
			},
		],
		hasMore: false,
	});
	const pages = spyOn(api, "getRecentTabsPage");
	await render();
	await act(async () =>
		seed({
			...recent("target"),
			title: "Fresh label",
			subtitle: "unindexed-directory",
			status: "working",
		}),
	);
	expect(result.candidates).toMatchObject([
		{ title: "Fresh label", status: "working", handle: "stable-handle" },
	]);
	await render("Fresh");
	expect(candidateIds()).toEqual(["target"]);
	await render("unindexed-directory");
	expect(candidateIds()).toEqual([]);
	expect(pages).not.toHaveBeenCalled();
});

test("A → B → A and a same-account token replacement never reuse old pages, even with a stale auth/me cache", async () => {
	seed(recent("only-a"));
	await render();
	expect(candidateIds()).toEqual(["only-a"]);
	const oldScope = scope();
	await act(async () => {
		setToken("credential-b");
		client.setQueryData(["auth", "me"], { id: "user-a" });
	});
	expect(getRecentTabsScope()).toBeNull();
	expect(candidateIds()).toEqual([]);
	await act(async () => {
		confirmAuthUser(getAuthSnapshot().generation, "user-b");
		client.setQueryData(recentTabsFlatQueryKey(scope()), [recent("only-b")]);
	});
	expect(candidateIds()).toEqual(["only-b"]);
	await act(async () => signIn("credential-a", "user-a"));
	expect(candidateIds()).toEqual([]);
	expect(scope().authGeneration).toBeGreaterThan(oldScope.authGeneration);
	await act(async () => seed(recent("new-a")));
	expect(candidateIds()).toEqual(["new-a"]);
	await act(async () => signIn("credential-a-rotated", "user-a"));
	expect(candidateIds()).toEqual([]);
	expect(workKey()).toEqual([
		"user-preferences",
		"recent-tabs",
		"user-a",
		scope().authGeneration,
		scope().accessGeneration,
		"work",
	]);
});

test("access changes immediately hide local pages and cancel old remote search; fresh pages restore local candidates", async () => {
	seed(recent("revoked"));
	let finish!: (value: CommunicationCandidates) => void;
	search.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	await render();
	expect(candidateIds()).toEqual(["revoked"]);
	const previousScope = scope();
	const signal = search.mock.calls[0][2]?.signal;
	await act(async () => onAccess({ type: "narrator_access_changed", narratorId: "revoked" }));
	expect(scope().authGeneration).toBe(previousScope.authGeneration);
	expect(scope().accessGeneration).toBeGreaterThan(previousScope.accessGeneration);
	expect(candidateIds()).toEqual([]);
	expect(signal?.aborted).toBe(true);
	await act(async () =>
		finish({
			items: [
				{
					id: "revoked",
					title: "Revoked",
					status: "idle",
					isRecent: true,
					lastActivityAt: null,
					canConnect: true,
				},
			],
			hasMore: false,
		}),
	);
	expect(candidateIds()).toEqual([]);
	await act(async () => seed(recent("still-visible")));
	expect(candidateIds()).toEqual(["still-visible"]);
});

test("only a selection checks an unknown candidate, and an eligible search hit is reusable", async () => {
	seed(recent("local"));
	search.mockImplementation(async (_source, _query, options) =>
		eligible(options?.targetId ?? "remote"),
	);
	await render();
	expect(result.candidates.find(({ id }) => id === "local")?.canConnect).toBeUndefined();
	expect(search).toHaveBeenCalledTimes(1);
	const activate = mock();
	await act(async () => result.verifyCandidate("remote", activate));
	expect(activate).toHaveBeenLastCalledWith(
		expect.objectContaining({ id: "remote", canConnect: true }),
	);
	expect(search).toHaveBeenCalledTimes(1);
	await act(async () => result.verifyCandidate("local", activate));
	expect(search).toHaveBeenCalledTimes(2);
	expect(search.mock.calls[1]).toEqual([
		"source",
		"",
		{ targetId: "local", signal: expect.any(AbortSignal) },
	]);
	expect(activate).toHaveBeenLastCalledWith(
		expect.objectContaining({ id: "local", title: "local", canConnect: true }),
	);
});

test.each([
	"account round trip",
	"access revoked",
	"changed source",
	"changed query",
] as const)("a late exact result cannot activate across %s", async (boundary) => {
	seed(recent("target"));
	const pending = Promise.withResolvers<CommunicationCandidates>();
	search.mockImplementation(async (_source, _query, options) =>
		options?.targetId ? pending.promise : { items: [], hasMore: false },
	);
	await render();
	const activate = mock();
	await act(async () => result.verifyCandidate("target", activate));
	expect(result.verification).toEqual({ targetId: "target", status: "checking" });
	const signal = search.mock.calls[1][2]?.signal;
	if (boundary === "account round trip") {
		await act(async () => {
			signIn("credential-b", "user-b");
			signIn("credential-a", "user-a");
			seed(recent("target"));
		});
	} else if (boundary === "access revoked") {
		await act(async () => onAccess({ type: "narrator_access_changed", narratorId: "target" }));
		await act(async () => seed(recent("target"))); // Still readable, not known writable.
	} else if (boundary === "changed source") await render("", "another-source");
	else await render("tar");
	expect(signal?.aborted).toBe(true);
	await act(async () => pending.resolve(eligible("target")));
	expect(activate).not.toHaveBeenCalled();
	expect(result.verification).toBeUndefined();
	expect(result.candidates.find(({ id }) => id === "target")?.canConnect).toBeUndefined();
});
