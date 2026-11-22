import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { parseHTML } from "linkedom";
import type { Root } from "react-dom/client";
import type { GitWorkspace, GitWorkspaceSummary } from "../../shared/git-workspace";

const globalKeys = ["window", "document", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originals = globalKeys.map(
	(key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
);
const { window } = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
	window,
	document: window.document,
	navigator: window.navigator,
	IS_REACT_ACT_ENVIRONMENT: false,
});
mock.module("./useNarrator", () => ({
	useNarrator: (id: string) =>
		useQuery<Record<string, unknown>>({
			queryKey: ["narrators", id],
			queryFn: async () => ({}),
			enabled: false,
		}),
}));
mock.module("./useWorkspaceContext", () => ({
	useWorkspaceContext: (id: string) =>
		useQuery<{ revision: number; contextKey: string }>({
			queryKey: ["workspaceContext", id],
			queryFn: async () => ({ revision: 0, contextKey: "" }),
			enabled: false,
		}),
}));
const accessListeners = new Set<() => void>();
mock.module("../lib/narrator-ws-manager", () => ({
	narratorWSManager: {
		connected: false,
		send: () => true,
		onConnectionChange: () => () => {},
		addListener: (_filter: unknown, listener: () => void) => {
			accessListeners.add(listener);
			return listener;
		},
		removeListener: (listener: () => void) => accessListeners.delete(listener),
	},
}));
const { QueryClient, QueryClientProvider, useQuery } = await import("@tanstack/react-query");
const { createRoot } = await import("react-dom/client");
const { api, ApiError } = await import("../lib/api");
const { useGitWorkspace, gitWorkspaceTarget, readWorkspace } = await import("./useGit");
const nativeSetInterval = globalThis.setInterval;
const nativeClearInterval = globalThis.clearInterval;
const intervals = new Map<ReturnType<typeof setInterval>, { delay: number; tick: () => void }>();
let root: Root | undefined;
let client: InstanceType<typeof QueryClient>;
let container: HTMLElement;
let latest: ReturnType<typeof useGitWorkspace>;
function workspace(state: GitWorkspace["state"] = "ready", branch?: string): GitWorkspace {
	return {
		state,
		branch,
		deviceId: "remote",
		cwd: "/repo",
		rootPath: state === "ready" ? "/repo" : null,
		workspaceKey: state === "ready" ? "remote:/repo" : null,
		repositoryKey: state === "ready" ? "remote:/repo" : null,
		capabilities: { read: state === "ready", write: state === "ready" },
	};
}
function Probe({ narratorId }: { narratorId: string }) {
	latest = useGitWorkspace(narratorId);
	return (
		<output
			data-layout-ready={String(latest.layoutReady)}
			data-branch={latest.data?.branch}
			data-authorized={String(!!gitWorkspaceTarget(narratorId, latest.data))}
		>
			{latest.isError ? "error" : (latest.data?.state ?? "pending")}
		</output>
	);
}
async function flush() {
	for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}
function render(id: string) {
	root?.render(
		<QueryClientProvider client={client}>
			<Probe narratorId={id} />
		</QueryClientProvider>,
	);
}
async function mount(id = "narrator") {
	root = createRoot(container);
	render(id);
	await flush();
}
function detail(id: string, revision = 3, state?: GitWorkspace["state"]) {
	client.setQueryData(["narrators", id], {
		id,
		cwd: "/repo",
		defaultDeviceId: "remote",
		workspaceRevision: revision,
		...(state
			? { gitSummary: { revision, branch: `branch-${id}`, workspace: workspace(state) } }
			: {}),
	});
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
const branch = () => container.querySelector("output")?.getAttribute("data-branch");
beforeEach(() => {
	client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
	client.setQueryDefaults(["narrators"], { gcTime: Infinity });
	detail("narrator", 0);
	spyOn(api, "getNarratorGitSummary").mockResolvedValue(null);
	container = document.createElement("div");
	document.body.appendChild(container);
	spyOn(globalThis, "setInterval").mockImplementation(((
		callback: (...args: unknown[]) => void,
		delay = 0,
		...args: unknown[]
	) => {
		const timer = nativeSetInterval(() => {}, delay);
		intervals.set(timer, { delay, tick: () => callback(...args) });
		return timer;
	}) as typeof setInterval);
	spyOn(globalThis, "clearInterval").mockImplementation(((
		timer: ReturnType<typeof setInterval> | undefined,
	) => {
		if (timer !== undefined) intervals.delete(timer);
		nativeClearInterval(timer);
	}) as typeof clearInterval);
});
afterEach(async () => {
	root?.unmount();
	root = undefined;
	client.clear();
	await flush();
	container.remove();
	for (const timer of intervals.keys()) nativeClearInterval(timer);
	intervals.clear();
	mock.restore();
});
afterAll(() => {
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});

describe("non-blocking Git summaries and operation authority", () => {
	test("cold detail and slow Git never determine chat layout readiness", async () => {
		client.removeQueries({ queryKey: ["narrators", "narrator"] });
		const request = spyOn(api, "getGitWorkspace").mockReturnValue(deferred<GitWorkspace>().promise);
		await mount();
		expect(request).not.toHaveBeenCalled();
		expect(container.querySelector("output")?.getAttribute("data-layout-ready")).toBe("true");
		detail("narrator");
		await flush();
		expect(request).toHaveBeenCalledTimes(1);
		expect(container.textContent).toBe("pending");
	});
	test("summary endpoint paints a branch while the separate authoritative read waits", async () => {
		detail("narrator");
		const summary = deferred<GitWorkspaceSummary | null>();
		spyOn(api, "getNarratorGitSummary").mockReturnValue(summary.promise);
		const authority = deferred<GitWorkspace>();
		spyOn(api, "getGitWorkspace").mockReturnValue(authority.promise);
		await mount();
		summary.resolve({ revision: 3, workspace: workspace(), branch: "summary" });
		await flush();
		expect(branch()).toBe("summary");
		expect(gitWorkspaceTarget("narrator", latest.data)).toBeNull();
		authority.resolve(workspace("ready", "authorized"));
		await flush();
		expect(branch()).toBe("authorized");
		const target = gitWorkspaceTarget("narrator", latest.data);
		expect(typeof target !== "string" && target?.canWrite).toBe(true);
	});
	test("legacy summaries are display hints, never seeds for operation queries", async () => {
		detail("narrator", 3, "ready");
		const probe = spyOn(api, "getGitWorkspace").mockReturnValue(deferred<GitWorkspace>().promise);
		await mount();
		expect(branch()).toBe("branch-narrator");
		expect(probe).toHaveBeenCalledTimes(1);
		expect(gitWorkspaceTarget("narrator", latest.data)).toBeNull();
	});
	test("unsupported summary is not automatically probed", async () => {
		detail("narrator", 3, "unsupported");
		const request = spyOn(api, "getGitWorkspace");
		await mount();
		expect(container.textContent).toBe("unsupported");
		expect(request).not.toHaveBeenCalled();
	});
	test("failed detail can still recover through the authoritative workspace read", async () => {
		client.removeQueries({ queryKey: ["narrators", "narrator"] });
		const request = spyOn(api, "getGitWorkspace").mockResolvedValue(workspace());
		await mount();
		client
			.getQueryCache()
			.find({ queryKey: ["narrators", "narrator"], exact: true })
			?.setState({ status: "error", error: new Error("offline") });
		await flush();
		expect(request).toHaveBeenCalledTimes(1);
		expect(container.textContent).toBe("ready");
	});
	test.each([
		"same",
		"different-root",
		"different-device",
		"explicit-null",
	])("branchless authority preserves a label only for its exact worktree: %s", async (kind) => {
		detail("narrator", 3, "ready");
		spyOn(api, "getGitWorkspace").mockResolvedValue({
			...workspace(),
			...(kind === "different-root" ? { workspaceKey: "remote:/other", rootPath: "/other" } : {}),
			...(kind === "different-device" ? { deviceId: "other" } : {}),
			...(kind === "explicit-null" ? { branch: null } : {}),
		});
		await mount();
		expect(branch()).toBe(kind === "same" ? "branch-narrator" : null);
	});
	test("executionContext hydration at the same revision does not replace query keys", async () => {
		detail("narrator");
		const request = spyOn(api, "getGitWorkspace").mockReturnValue(deferred<GitWorkspace>().promise);
		await mount();
		const keys = client
			.getQueryCache()
			.findAll({ queryKey: ["gitWorkspace"] })
			.map((q) => q.queryHash);
		client.setQueryData(["workspaceContext", "narrator"], { revision: 3, contextKey: "hydrated" });
		await flush();
		expect(
			client
				.getQueryCache()
				.findAll({ queryKey: ["gitWorkspace"] })
				.map((q) => q.queryHash),
		).toEqual(keys);
		expect(request).toHaveBeenCalledTimes(1);
	});
	test.each([
		"revision",
		"cwd",
		"device",
	])("%s switch clears old branch instead of carrying facts", async (kind) => {
		detail("narrator", 3, "ready");
		spyOn(api, "getGitWorkspace").mockReturnValue(deferred<GitWorkspace>().promise);
		await mount();
		client.setQueryData<Record<string, unknown>>(["narrators", "narrator"], (old) => ({
			...old,
			...(kind === "revision"
				? { workspaceRevision: 4 }
				: kind === "cwd"
					? { cwd: "/other" }
					: { defaultDeviceId: "other" }),
		}));
		await flush();
		expect(branch()).toBeNull();
		expect(container.textContent).toBe("pending");
		expect(latest.layoutReady).toBe(true);
	});
	test("late metadata that only completes the scope keeps the authorized workspace visible", async () => {
		// Metadata without device yet: scope [3, "/repo", null].
		client.setQueryData(["narrators", "narrator"], {
			id: "narrator",
			cwd: "/repo",
			workspaceRevision: 3,
		});
		const reprobe = deferred<GitWorkspace>();
		spyOn(api, "getGitWorkspace")
			.mockResolvedValueOnce(workspace("ready", "authorized"))
			.mockReturnValue(reprobe.promise);
		await mount();
		expect(branch()).toBe("authorized");
		expect(gitWorkspaceTarget("narrator", latest.data)).not.toBeNull();
		// The device arrives at the same revision: a completion, not a switch.
		client.setQueryData<Record<string, unknown>>(["narrators", "narrator"], (old) => ({
			...old,
			defaultDeviceId: "remote",
		}));
		await flush();
		expect(api.getGitWorkspace).toHaveBeenCalledTimes(2);
		expect(container.textContent).toBe("ready");
		expect(branch()).toBe("authorized");
		reprobe.resolve(workspace("ready", "reprobed"));
		await flush();
		expect(branch()).toBe("reprobed");
	});
	test("a refusal is never carried into a completed scope", async () => {
		client.setQueryData(["narrators", "narrator"], {
			id: "narrator",
			cwd: "/repo",
			workspaceRevision: 3,
		});
		spyOn(api, "getGitWorkspace")
			.mockResolvedValueOnce(workspace("access_denied"))
			.mockReturnValue(deferred<GitWorkspace>().promise);
		await mount();
		expect(latest.accessDenied).toBe(true);
		client.setQueryData<Record<string, unknown>>(["narrators", "narrator"], (old) => ({
			...old,
			defaultDeviceId: "remote",
		}));
		await flush();
		expect(latest.data).toBeUndefined();
		expect(latest.accessDenied).toBe(true);
	});

	test("another narrator never inherits the old branch and late response", async () => {
		detail("first", 3, "ready");
		detail("second");
		const first = deferred<GitWorkspace>();
		spyOn(api, "getGitWorkspace").mockImplementation((id) =>
			id === "first" ? first.promise : deferred<GitWorkspace>().promise,
		);
		await mount("first");
		render("second");
		await flush();
		first.resolve(workspace("ready", "late-first"));
		await flush();
		expect(branch()).toBeNull();
		expect(container.textContent).toBe("pending");
	});
	test.each([
		401, 403,
	])("HTTP %s clears branch/counts and does not use the ready summary", async (status) => {
		detail("narrator", 3, "ready");
		spyOn(api, "getGitWorkspace").mockRejectedValue(new ApiError("denied", status));
		await mount();
		expect(container.textContent).toBe("error");
		expect(branch()).toBeNull();
		expect(latest.displayCounts).toBeUndefined();
	});
	test.each([
		"GIT_COMMIT_NOT_FOUND",
		"GIT_COMMIT_FILE_NOT_FOUND",
	])("preview %s preserves authorized workspace facts", async (code) => {
		spyOn(api, "getGitWorkspace").mockResolvedValue(workspace("ready", "valid-branch"));
		await mount();
		latest.rememberCounts({ totalFiles: 7, totalFilesExact: true, truncated: false });
		render("narrator");
		await flush();
		expect(latest.displayCounts?.totalFiles).toBe(7);
		const target = gitWorkspaceTarget("narrator", latest.data);
		expect(target).not.toBeNull();
		const authorizationState = latest.authorizationState;
		const failure = new ApiError("Missing preview resource", 404, { code });
		await expect(
			readWorkspace(
				client,
				target,
				async () => {
					throw failure;
				},
				true,
			),
		).rejects.toBe(failure);
		await flush();
		expect(latest.authorizationState).toBe(authorizationState);
		expect(branch()).toBe("valid-branch");
		expect(latest.displayCounts?.totalFiles).toBe(7);
		expect(gitWorkspaceTarget("narrator", latest.data)).toEqual(target);
	});
	test("a background 404 retires old authority and scrubs cached private metadata without reporting denial", async () => {
		const request = spyOn(api, "getGitWorkspace").mockResolvedValue(
			workspace("ready", "private-before-404"),
		);
		await mount();
		latest.rememberCounts({ totalFiles: 7, totalFilesExact: true, truncated: false });
		request.mockRejectedValueOnce(new ApiError("Not found", 404));
		await latest.refetch();
		await flush();
		expect(latest.accessDenied).toBe(false);
		expect(latest.data).toBeUndefined();
		expect(latest.authoritativeData).toBeUndefined();
		expect(latest.displayCounts).toBeUndefined();
		expect(latest.authorizationState).toBe("refresh_required");
		for (const [, cached] of client.getQueriesData<GitWorkspace>({
			queryKey: ["gitWorkspace", "narrator"],
		})) {
			expect(cached?.branch).toBeUndefined();
			expect(cached?.rootPath).toBeNull();
			expect(cached?.cwd).toBe("");
		}
		request.mockResolvedValue(workspace("ready", "recovered"));
		await latest.refetch();
		await flush();
		expect(latest.data?.branch).toBe("recovered");
	});

	test("summary permission denial rejects a late authority response", async () => {
		detail("narrator", 3, "ready");
		const authority = deferred<GitWorkspace>();
		spyOn(api, "getGitWorkspace").mockReturnValue(authority.promise);
		spyOn(api, "getNarratorGitSummary").mockRejectedValue(new ApiError("denied", 403));
		await mount();
		authority.resolve(workspace("ready", "private-late"));
		await flush();
		expect(branch()).toBeNull();
	});
	test("access WS event clears seeds and rejects both old in-flight responses", async () => {
		detail("narrator", 3, "ready");
		const old = deferred<GitWorkspace>();
		const next = deferred<GitWorkspace>();
		spyOn(api, "getGitWorkspace").mockReturnValueOnce(old.promise).mockReturnValue(next.promise);
		const oldSummary = deferred<GitWorkspaceSummary | null>();
		spyOn(api, "getNarratorGitSummary")
			.mockReturnValueOnce(oldSummary.promise)
			.mockReturnValue(deferred<GitWorkspaceSummary | null>().promise);
		await mount();
		for (const listener of accessListeners) listener();
		await flush();
		old.resolve(workspace("ready", "private"));
		oldSummary.resolve({ revision: 3, branch: "private", workspace: workspace() });
		await flush();
		expect(branch()).toBeNull();
	});
});

describe("bounded presentation snapshot cache", () => {
	test("hot revisit reuses same-scope branch and small counts while refreshing in background", async () => {
		detail("first");
		detail("second");
		const probe = spyOn(api, "getGitWorkspace").mockResolvedValue(workspace("ready", "remembered"));
		await mount("first");
		latest.rememberCounts({ totalFiles: 10, linesAdded: 12, linesRemoved: 3 });
		render("second");
		await flush();
		client.removeQueries({ queryKey: ["gitWorkspace", "first"] });
		client.removeQueries({ queryKey: ["gitSummary", "first"] });
		probe.mockReturnValue(deferred<GitWorkspace>().promise);
		render("first");
		await flush();
		expect(branch()).toBe("remembered");
		expect(latest.displayCounts).toEqual({ totalFiles: 10 });
		expect(gitWorkspaceTarget("first", latest.data)).toBeNull();
	});
	test("a lightweight status replaces remembered line counts and retains lower-bound metadata", async () => {
		detail("first");
		detail("second");
		const probe = spyOn(api, "getGitWorkspace").mockResolvedValue(workspace("ready", "remembered"));
		await mount("first");
		latest.rememberCounts({ totalFiles: 10, linesAdded: 12, linesRemoved: 3 });
		latest.rememberCounts({ totalFiles: 8, totalFilesExact: false });
		render("second");
		await flush();
		client.removeQueries({ queryKey: ["gitWorkspace", "first"] });
		client.removeQueries({ queryKey: ["gitSummary", "first"] });
		probe.mockReturnValue(deferred<GitWorkspace>().promise);
		render("first");
		await flush();
		expect(latest.displayCounts?.totalFiles).toBe(8);
		expect(latest.displayCounts?.totalFilesExact).toBe(false);
		expect(latest.displayCounts?.linesAdded).toBeUndefined();
		expect(latest.displayCounts?.linesRemoved).toBeUndefined();
	});
	test("TTL removes a ten-minute-old snapshot", async () => {
		detail("first");
		detail("second");
		const request = spyOn(api, "getGitWorkspace").mockResolvedValue(workspace("ready", "old"));
		await mount("first");
		render("second");
		await flush();
		client.removeQueries({ queryKey: ["gitWorkspace", "first"] });
		client.removeQueries({ queryKey: ["gitSummary", "first"] });
		const now = Date.now();
		spyOn(Date, "now").mockReturnValue(now + 10 * 60_000 + 1);
		request.mockReturnValue(deferred<GitWorkspace>().promise);
		render("first");
		await flush();
		expect(branch()).toBeNull();
	});
	test("cache retains at most sixteen narrators", async () => {
		const request = spyOn(api, "getGitWorkspace").mockImplementation(async (id) =>
			workspace("ready", id),
		);
		for (let i = 0; i < 17; i++) detail(`n${i}`);
		await mount("n0");
		for (let i = 1; i < 17; i++) {
			render(`n${i}`);
			await flush();
		}
		client.removeQueries({ queryKey: ["gitWorkspace"] });
		client.removeQueries({ queryKey: ["gitSummary"] });
		request.mockReturnValue(deferred<GitWorkspace>().promise);
		render("n0");
		await flush();
		expect(branch()).toBeNull();
		render("n15");
		await flush();
		expect(branch()).toBe("n15");
	});
	test("QueryClient principal changes clear presentation facts", async () => {
		client.setQueryData(["auth", "me"], { id: "user-a" });
		detail("first");
		detail("second");
		const request = spyOn(api, "getGitWorkspace").mockResolvedValue(
			workspace("ready", "private-a"),
		);
		await mount("first");
		render("second");
		await flush();
		client.removeQueries({ queryKey: ["gitWorkspace"] });
		client.removeQueries({ queryKey: ["gitSummary"] });
		client.setQueryData(["auth", "me"], { id: "user-b" });
		request.mockReturnValue(deferred<GitWorkspace>().promise);
		render("first");
		await flush();
		expect(branch()).toBeNull();
	});
});

describe("unavailable workspace recovery", () => {
	test.each([
		"device_offline",
		"missing_directory",
		"not_git",
		"git_unavailable",
	] as const)("re-probes %s without remount and stops once ready", async (state) => {
		const request = spyOn(api, "getGitWorkspace")
			.mockResolvedValueOnce(workspace(state))
			.mockResolvedValue(workspace());
		await mount();
		expect(container.textContent).toBe(state);
		expect(intervals.size).toBe(1);
		expect([...intervals.values()][0]?.delay).toBe(30_000);
		[...intervals.values()][0]?.tick();
		await flush();
		expect(request).toHaveBeenCalledTimes(2);
		expect(container.textContent).toBe("ready");
		expect(intervals.size).toBe(0);
	});
	test.each([
		new Error("offline"),
		new ApiError("offline", 503),
	])("recovers transport errors", async (error) => {
		const request = spyOn(api, "getGitWorkspace")
			.mockRejectedValueOnce(error)
			.mockResolvedValue(workspace());
		await mount();
		expect(container.textContent).toBe("error");
		[...intervals.values()][0]?.tick();
		await flush();
		expect(request).toHaveBeenCalledTimes(2);
		expect(container.textContent).toBe("ready");
	});
	test.each([401, 403, 404])("does not poll HTTP %s", async (status) => {
		spyOn(api, "getGitWorkspace").mockRejectedValue(new ApiError("denied", status));
		await mount();
		expect(intervals.size).toBe(0);
	});
	test.each([
		"ready",
		"unsupported",
		"access_denied",
	] as const)("does not poll %s", async (state) => {
		spyOn(api, "getGitWorkspace").mockResolvedValue(workspace(state));
		await mount();
		expect(intervals.size).toBe(0);
	});
	test("unmount releases recovery intervals", async () => {
		spyOn(api, "getGitWorkspace").mockResolvedValue(workspace("device_offline"));
		await mount();
		expect(intervals.size).toBe(1);
		root?.unmount();
		root = undefined;
		expect(intervals.size).toBe(0);
	});
	test("missing narrator never starts discovery", async () => {
		const request = spyOn(api, "getGitWorkspace");
		await mount("");
		expect(request).not.toHaveBeenCalled();
		expect(latest.layoutReady).toBe(true);
	});
});
