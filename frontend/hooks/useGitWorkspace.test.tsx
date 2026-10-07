import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { parseHTML } from "linkedom";
import type { Root } from "react-dom/client";
import type { GitWorkspace } from "../../shared/git-workspace";

// Query's browser timer policy is decided at module load. Install the DOM before
// importing the real QueryClient/hooks so these tests exercise actual scheduling.
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
const { useGitWorkspace } = await import("./useGit");

const nativeSetInterval = globalThis.setInterval;
const nativeClearInterval = globalThis.clearInterval;
const intervals = new Map<ReturnType<typeof setInterval>, { delay: number; tick: () => void }>();
let root: Root | undefined;
let client: InstanceType<typeof QueryClient>;
let container: HTMLElement;

function workspace(state: GitWorkspace["state"]): GitWorkspace {
	return {
		state,
		deviceId: "remote",
		cwd: "/repo",
		rootPath: state === "ready" ? "/repo" : null,
		workspaceKey: state === "ready" ? "remote:/repo" : null,
		repositoryKey: state === "ready" ? "remote:/repo" : null,
		capabilities: { read: state === "ready", write: state === "ready" },
	};
}
function Probe({ narratorId = "narrator" }: { narratorId?: string }) {
	const query = useGitWorkspace(narratorId);
	return (
		<output data-layout-ready={String(query.layoutReady)} data-branch={query.data?.branch}>
			{query.isError ? "error" : (query.data?.state ?? "pending")}
		</output>
	);
}
async function flush() {
	for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}
async function mount(narratorId = "narrator", refreshSummary = true) {
	root = createRoot(container);
	root.render(
		<QueryClientProvider client={client}>
			<Probe narratorId={narratorId} />
		</QueryClientProvider>,
	);
	await flush();
	// Authority-response scenarios explicitly invalidate fresh seeded summaries.
	// The cold-mount test disables this to assert no redundant discovery request.
	if (
		refreshSummary &&
		client.getQueryData<Record<string, unknown>>(["narrators", narratorId])?.gitSummary
	) {
		void client.invalidateQueries({ queryKey: ["gitWorkspace", narratorId] });
		await flush();
	}
}

beforeEach(() => {
	client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
	client.setQueryDefaults(["narrators"], { gcTime: Infinity });
	// Recovery scenarios represent an already loaded legacy detail without summary.
	client.setQueryData(["narrators", "narrator"], { id: "narrator" });
	container = document.createElement("div");
	document.body.appendChild(container);
	// Control only interval ticks; leave React and Query notifications on real timers.
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
	// React schedules passive unmount work; drain it before restoring the DOM.
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

function seedSummary(id: string, revision = 3, state: GitWorkspace["state"] = "ready") {
	client.setQueryData(["narrators", id], {
		id,
		cwd: "/repo",
		defaultDeviceId: "remote",
		workspaceRevision: revision,
		gitSummary: { revision, branch: `branch-${id}`, workspace: workspace(state) },
	});
}
function switchTo(id: string) {
	root?.render(
		<QueryClientProvider client={client}>
			<Probe narratorId={id} />
		</QueryClientProvider>,
	);
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("Git summary layout readiness", () => {
	test("cold detail discovery waits and its late summary never triggers a duplicate workspace GET", async () => {
		client.removeQueries({ queryKey: ["narrators", "narrator"], exact: true });
		const request = spyOn(api, "getGitWorkspace").mockResolvedValue(workspace("ready"));
		await mount("narrator", false);
		expect(request).not.toHaveBeenCalled();
		expect(container.querySelector("output")?.getAttribute("data-layout-ready")).toBe("false");
		seedSummary("narrator");
		await flush();
		expect(request).not.toHaveBeenCalled();
		expect(container.textContent).toBe("ready");
	});
	test("a failed cold detail read still enables authoritative workspace recovery", async () => {
		client.removeQueries({ queryKey: ["narrators", "narrator"], exact: true });
		const request = spyOn(api, "getGitWorkspace").mockResolvedValue(workspace("ready"));
		await mount("narrator", false);
		expect(request).not.toHaveBeenCalled();
		client
			.getQueryCache()
			.find({ queryKey: ["narrators", "narrator"], exact: true })
			?.setState({ status: "error", error: new Error("detail offline") });
		await flush();
		expect(request).toHaveBeenCalledTimes(1);
		expect(container.textContent).toBe("ready");
	});
	test("null summary after temporary detail discovery failure recovers without focus or remount", async () => {
		client.removeQueries({ queryKey: ["narrators", "narrator"], exact: true });
		const request = spyOn(api, "getGitWorkspace")
			.mockRejectedValueOnce(new ApiError("Temporary discovery failure", 503))
			.mockResolvedValue(workspace("ready"));
		await mount("narrator", false);
		expect(request).not.toHaveBeenCalled();
		client.setQueryData(["narrators", "narrator"], {
			id: "narrator",
			cwd: "/repo",
			defaultDeviceId: null,
			workspaceRevision: 0,
			gitSummary: null,
		});
		await flush();
		expect(request).toHaveBeenCalledTimes(1);
		expect(container.textContent).toBe("error");
		expect(intervals.size).toBe(1);
		[...intervals.values()][0]?.tick();
		await flush();
		expect(request).toHaveBeenCalledTimes(2);
		expect(container.textContent).toBe("ready");
		expect(intervals.size).toBe(0);
	});

	test("a genuinely unsupported detail summary is not retried automatically", async () => {
		seedSummary("narrator", 3, "unsupported");
		const request = spyOn(api, "getGitWorkspace");
		await mount("narrator", false);
		expect(container.textContent).toBe("unsupported");
		expect(request).not.toHaveBeenCalled();
		expect(intervals.size).toBe(0);
	});

	test("a fresh same-version summary seeds cold mount without a duplicate workspace GET", async () => {
		seedSummary("narrator");
		const request = spyOn(api, "getGitWorkspace").mockResolvedValue(workspace("ready"));
		await mount("narrator", false);
		expect(request).not.toHaveBeenCalled();
		expect(container.textContent).toBe("ready");
		expect(container.querySelector("output")?.getAttribute("data-branch")).toBe("branch-narrator");
		void client.invalidateQueries({ queryKey: ["gitWorkspace", "narrator"] });
		await flush();
		expect(request).toHaveBeenCalledTimes(1);
	});
	test("same-version detail shows branch immediately while the authoritative probe waits", async () => {
		seedSummary("narrator");
		const pending = deferred<GitWorkspace>();
		spyOn(api, "getGitWorkspace").mockReturnValue(pending.promise);
		await mount();
		expect(container.textContent).toBe("ready");
		expect(container.querySelector("output")?.getAttribute("data-branch")).toBe("branch-narrator");
		expect(container.querySelector("output")?.getAttribute("data-layout-ready")).toBe("true");
		pending.resolve(workspace("not_git"));
		await flush();
		expect(container.textContent).toBe("not_git");
		expect(container.querySelector("output")?.hasAttribute("data-branch")).toBe(false);
	});
	test.each([
		"remote",
		"local",
	])("%s summaries accept executor or realpath-normalized directories", async (deviceId) => {
		seedSummary("narrator");
		client.setQueryData<Record<string, unknown>>(["narrators", "narrator"], (old) => ({
			...old,
			cwd: "/host-or-symlink",
			defaultDeviceId: deviceId,
			gitSummary: {
				revision: 3,
				branch: "normalized",
				workspace: { ...workspace("ready"), deviceId },
			},
		}));
		spyOn(api, "getGitWorkspace").mockReturnValue(deferred<GitWorkspace>().promise);
		await mount();
		expect(container.querySelector("output")?.getAttribute("data-branch")).toBe("normalized");
	});
	test.each([
		"same",
		"different-root",
		"different-device",
		"explicit-null",
	])("branchless authoritative probe preserves summary labels only for the same worktree: %s", async (kind) => {
		seedSummary("narrator");
		const result = {
			...workspace("ready"),
			...(kind === "different-root" ? { workspaceKey: "remote:/other", rootPath: "/other" } : {}),
			...(kind === "different-device" ? { deviceId: "other" } : {}),
			...(kind === "explicit-null" ? { branch: null } : {}),
		};
		spyOn(api, "getGitWorkspace").mockResolvedValue(result);
		await mount();
		expect(container.textContent).toBe("ready");
		expect(container.querySelector("output")?.getAttribute("data-branch")).toBe(
			kind === "same" ? "branch-narrator" : null,
		);
	});
	test("execution context hydration at the same revision never replaces the query key", async () => {
		seedSummary("narrator");
		const pending = deferred<GitWorkspace>();
		const request = spyOn(api, "getGitWorkspace").mockReturnValue(pending.promise);
		await mount();
		const keys = client
			.getQueryCache()
			.findAll({ queryKey: ["gitWorkspace"] })
			.map((query) => query.queryHash);
		client.setQueryData(["workspaceContext", "narrator"], {
			revision: 3,
			contextKey: "loaded-context",
		});
		await flush();
		expect(
			client
				.getQueryCache()
				.findAll({ queryKey: ["gitWorkspace"] })
				.map((query) => query.queryHash),
		).toEqual(keys);
		expect(request).toHaveBeenCalledTimes(1);
		expect(container.textContent).toBe("ready");
	});
	test("a detail arriving after the pending probe supplies synchronous fallback", async () => {
		seedSummary("narrator", 0);
		client.setQueryData<Record<string, unknown>>(["narrators", "narrator"], (old) => ({
			...old,
			gitSummary: null,
		}));
		const request = spyOn(api, "getGitWorkspace").mockReturnValue(deferred<GitWorkspace>().promise);
		await mount();
		expect(container.querySelector("output")?.getAttribute("data-layout-ready")).toBe("false");
		seedSummary("narrator", 0);
		await flush();
		expect(container.textContent).toBe("ready");
		expect(request).toHaveBeenCalledTimes(1);
	});
	test("switching narrators ignores late responses from the previous panel", async () => {
		seedSummary("first");
		seedSummary("second");
		const first = deferred<GitWorkspace>();
		const second = deferred<GitWorkspace>();
		spyOn(api, "getGitWorkspace").mockImplementation((id) =>
			id === "first" ? first.promise : second.promise,
		);
		await mount("first");
		switchTo("second");
		await flush();
		expect(container.querySelector("output")?.getAttribute("data-branch")).toBe("branch-second");
		first.resolve({ ...workspace("ready"), branch: "late-first" });
		await flush();
		expect(container.querySelector("output")?.getAttribute("data-branch")).toBe("branch-second");
	});
	test("device change cannot borrow the previous summary", async () => {
		seedSummary("narrator");
		spyOn(api, "getGitWorkspace").mockReturnValue(deferred<GitWorkspace>().promise);
		await mount();
		client.setQueryData<Record<string, unknown>>(["narrators", "narrator"], (old) => ({
			...old,
			defaultDeviceId: "changed",
		}));
		await flush();
		expect(container.textContent).toBe("pending");
		expect(container.querySelector("output")?.getAttribute("data-layout-ready")).toBe("false");
	});
	test.each([
		"revision",
		"cwd",
	])("%s switch carries the previous workspace until the new context is probed", async (change) => {
		seedSummary("narrator");
		const probe = deferred<GitWorkspace>();
		const request = spyOn(api, "getGitWorkspace").mockReturnValue(probe.promise);
		await mount("narrator", false);
		if (change === "revision")
			client.setQueryData(["workspaceContext", "narrator"], { revision: 4, contextKey: "new" });
		else
			client.setQueryData<Record<string, unknown>>(["narrators", "narrator"], (old) => ({
				...old,
				cwd: "changed",
				workspaceRevision: 4,
			}));
		await flush();
		// The switch window must not collapse the panel layout (NarratorPanel
		// skeleton), and the carried branch is presentation-only…
		expect(container.querySelector("output")?.getAttribute("data-layout-ready")).toBe("true");
		expect(container.textContent).toBe("ready");
		expect(container.querySelector("output")?.getAttribute("data-branch")).toBe("branch-narrator");
		// …but the new context is still probed, and its answer replaces the carryover.
		expect(request).toHaveBeenCalledTimes(1);
		probe.resolve({ ...workspace("ready"), branch: "after-switch" });
		await flush();
		expect(container.querySelector("output")?.getAttribute("data-branch")).toBe("after-switch");
	});
	test("a fresh detail summary upgrades the carried workspace before the probe lands", async () => {
		seedSummary("narrator");
		const probe = deferred<GitWorkspace>();
		spyOn(api, "getGitWorkspace").mockReturnValue(probe.promise);
		await mount("narrator", false);
		client.setQueryData(["workspaceContext", "narrator"], { revision: 4, contextKey: "new" });
		await flush();
		expect(container.querySelector("output")?.getAttribute("data-branch")).toBe("branch-narrator");
		// The narrators detail refetch lands with a summary for the new revision.
		client.setQueryData(["narrators", "narrator"], {
			id: "narrator",
			cwd: "/repo",
			defaultDeviceId: "remote",
			workspaceRevision: 4,
			gitSummary: { revision: 4, branch: "branch-new", workspace: workspace("ready") },
		});
		await flush();
		expect(container.querySelector("output")?.getAttribute("data-branch")).toBe("branch-new");
		probe.resolve({ ...workspace("ready"), branch: "probed" });
		await flush();
		expect(container.querySelector("output")?.getAttribute("data-branch")).toBe("probed");
	});
	test("switching narrators never carries the previous narrator's workspace", async () => {
		seedSummary("first");
		client.setQueryData(["narrators", "second"], { id: "second" });
		spyOn(api, "getGitWorkspace").mockReturnValue(deferred<GitWorkspace>().promise);
		await mount("first");
		expect(container.textContent).toBe("ready");
		switchTo("second");
		await flush();
		expect(container.textContent).toBe("pending");
		expect(container.querySelector("output")?.getAttribute("data-layout-ready")).toBe("false");
		expect(container.querySelector("output")?.hasAttribute("data-branch")).toBe(false);
	});
	test("list-only detail waits for layout but a non-Git summary does not reserve a row", async () => {
		client.setQueryData(["narrators", "narrator"], { id: "narrator" });
		spyOn(api, "getGitWorkspace").mockReturnValue(deferred<GitWorkspace>().promise);
		await mount();
		expect(container.querySelector("output")?.getAttribute("data-layout-ready")).toBe("false");
		seedSummary("narrator", 0, "not_git");
		await flush();
		expect(container.textContent).toBe("not_git");
		expect(container.querySelector("output")?.getAttribute("data-layout-ready")).toBe("true");
	});
	test("permission events discard summary sources before resetting pending workspace reads", async () => {
		seedSummary("narrator");
		spyOn(api, "getGitWorkspace").mockReturnValue(deferred<GitWorkspace>().promise);
		await mount();
		for (const listener of accessListeners) listener();
		await flush();
		expect(
			client.getQueryData<Record<string, unknown>>(["narrators", "narrator"])?.gitSummary,
		).toBeNull();
		expect(container.textContent).toBe("pending");
	});
	test("a known denial blocks later detail summaries until an authoritative read succeeds", async () => {
		seedSummary("narrator");
		const request = spyOn(api, "getGitWorkspace").mockRejectedValue(new ApiError("denied", 403));
		await mount();
		seedSummary("narrator");
		const recovery = deferred<GitWorkspace>();
		request.mockReturnValue(recovery.promise);
		void client.resetQueries({ queryKey: ["gitWorkspace"] });
		await flush();
		expect(container.textContent).toBe("pending");
		expect(container.querySelector("output")?.hasAttribute("data-branch")).toBe(false);
		// An identical result still represents a new authority check, not the old seed.
		recovery.resolve({ ...workspace("ready"), branch: "branch-narrator" });
		await flush();
		expect(container.querySelector("output")?.getAttribute("data-branch")).toBe("branch-narrator");
	});
	test("authoritative denial cannot reuse a ready summary", async () => {
		seedSummary("narrator");
		spyOn(api, "getGitWorkspace").mockRejectedValue(new ApiError("denied", 403));
		await mount();
		expect(container.textContent).toBe("error");
		expect(container.querySelector("output")?.hasAttribute("data-branch")).toBe(false);
	});
});

describe("unavailable Git workspace recovery", () => {
	test.each([
		"device_offline",
		"missing_directory",
		"not_git",
		"git_unavailable",
	] as const)("re-probes %s automatically and stops polling once ready", async (state) => {
		const request = spyOn(api, "getGitWorkspace")
			.mockResolvedValueOnce(workspace(state))
			.mockResolvedValue(workspace("ready"));
		await mount();
		expect(container.textContent).toBe(state);
		expect(request).toHaveBeenCalledTimes(1);
		expect(intervals.size).toBe(1);
		const [timer] = [...intervals.values()];
		expect(timer?.delay).toBe(30_000);
		timer?.tick();
		await flush();
		expect(request).toHaveBeenCalledTimes(2);
		expect(container.textContent).toBe("ready");
		expect(intervals.size).toBe(0);
	});
	test.each([
		new Error("network offline"),
		new ApiError("unavailable", 503),
	])("recovers an initial transport failure without manual invalidation: %s", async (error) => {
		const request = spyOn(api, "getGitWorkspace")
			.mockRejectedValueOnce(error)
			.mockResolvedValue(workspace("ready"));
		await mount();
		expect(container.textContent).toBe("error");
		expect(intervals.size).toBe(1);
		[...intervals.values()][0]?.tick();
		await flush();
		expect(request).toHaveBeenCalledTimes(2);
		expect(container.textContent).toBe("ready");
		expect(intervals.size).toBe(0);
	});
	test.each([
		"ready",
		"access_denied",
		"unsupported",
	] as const)("does not poll %s workspaces", async (state) => {
		spyOn(api, "getGitWorkspace").mockResolvedValue(workspace(state));
		await mount();
		expect(container.textContent).toBe(state);
		expect(intervals.size).toBe(0);
	});
	test.each([401, 403, 404])("does not retry HTTP %s denials", async (status) => {
		spyOn(api, "getGitWorkspace").mockRejectedValue(new ApiError("denied", status));
		await mount();
		expect(container.textContent).toBe("error");
		expect(intervals.size).toBe(0);
	});
	test("releases the recovery interval on unmount", async () => {
		spyOn(api, "getGitWorkspace").mockResolvedValue(workspace("device_offline"));
		await mount();
		expect(intervals.size).toBe(1);
		root?.unmount();
		root = undefined;
		expect(intervals.size).toBe(0);
	});
	test("does not probe without a narrator", async () => {
		const request = spyOn(api, "getGitWorkspace");
		await mount("");
		expect(request).not.toHaveBeenCalled();
		expect(intervals.size).toBe(0);
	});
});
