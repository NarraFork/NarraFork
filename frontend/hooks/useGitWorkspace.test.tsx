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
mock.module("./useNarrator", () => ({ useNarrator: () => ({ data: undefined }) }));
mock.module("../lib/narrator-ws-manager", () => ({
	narratorWSManager: { addListener: () => ({}), removeListener: () => {} },
}));
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
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
	return <output>{query.isError ? "error" : (query.data?.state ?? "pending")}</output>;
}
async function flush() {
	for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}
async function mount(narratorId = "narrator") {
	root = createRoot(container);
	root.render(
		<QueryClientProvider client={client}>
			<Probe narratorId={narratorId} />
		</QueryClientProvider>,
	);
	await flush();
}

beforeEach(() => {
	client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
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
