import { afterEach, expect, mock, test } from "bun:test";
import { QueryObserver, timeoutManager } from "@tanstack/react-query";

const timers = new Map<number, { callback: () => void; delay: number }>();
let timerId = 0;
timeoutManager.setTimeoutProvider({
	setTimeout(callback, delay) {
		const id = ++timerId;
		timers.set(id, { callback, delay });
		return id;
	},
	clearTimeout(id) {
		if (id !== undefined) timers.delete(id);
	},
	setInterval() {
		throw new Error("No interval expected");
	},
	clearInterval() {},
});
let phase: "committed_pending" | "unconfirmed" | "installed" = "committed_pending";
const receiptIds: string[] = [];
const current = {
	version: 1,
	revision: 1,
	deviceId: "B",
	cwd: "/b",
	pathFlavor: "posix",
	contextKey: "b",
	capabilities: { switchDirectory: true },
};
const result = {
	kind: "select",
	binding: {
		id: "binding-b",
		narratorId: "audit-n",
		deviceId: "B",
		bindingRevision: 1,
		context: current,
		updatedAt: "2026-10-12",
	},
	selection: { current },
};
class FakeApiError extends Error {}
mock.module("../lib/api", () => ({
	ApiError: FakeApiError,
	api: {
		selectNarratorDeviceWorkspace: async () => {
			if (phase === "unconfirmed") throw new Error("Reply lost");
		},
		getNarratorDeviceWorkspaceRequest: async (_id: string, requestId: string) => {
			receiptIds.push(requestId);
			if (phase === "unconfirmed") throw new Error("Receipt read unavailable");
			return {
				requestId,
				kind: "select",
				installState: phase === "installed" ? "installed" : "pending",
				result,
			};
		},
		getWorkspaceContext: async () => current,
		getWorkspaceSelectionStatus: async () => ({ installed: true, revision: current.revision }),
	},
}));
mock.module("../lib/narrator-ws-manager", () => ({ narratorWSManager: {} }));
mock.module("../lib/i18n", () => ({ default: { language: "en", t: (key: string) => key } }));
mock.module("@mantine/notifications", () => ({ notifications: { show() {} } }));
const { queryClient } = await import("../lib/query-client");
const { executeDeviceWorkspaceIntent, transitionKey, isDeviceWorkspaceTransition } = await import(
	"./useWorkspaceContext"
);
afterEach(() => {
	queryClient.clear();
	timers.clear();
});

for (const withObserver of [true, false]) {
	test.each([
		"committed_pending",
		"unconfirmed",
	] as const)(`unresolved %s retains original request after production GC (observer=${withObserver})`, async (value) => {
		phase = value;
		queryClient.setQueryData(["auth", "me"], { id: "actor" });
		const key = transitionKey("audit-n");
		const observer = withObserver
			? new QueryObserver(queryClient, { queryKey: key, queryFn: () => false, enabled: false })
			: undefined;
		const unsubscribe = observer?.subscribe(() => {});
		await expect(
			executeDeviceWorkspaceIntent(queryClient, {
				narratorId: "audit-n",
				kind: "select",
				request: {
					deviceId: "B",
					requestId: "original-r",
					expectedSelectionRevision: 0,
					expectedBindingRevision: 1,
				},
			}),
		).rejects.toThrow();
		const before = queryClient.getQueryData<unknown>(key);
		if (!isDeviceWorkspaceTransition(before)) throw new Error("Missing original transition");
		expect(before.phase).toBe(value);
		expect(before.intent.request.requestId).toBe("original-r");
		unsubscribe?.();
		const productionGc = queryClient.getDefaultOptions().queries?.gcTime;
		expect(productionGc).toBe(120_000);
		const due = [...timers.values()].filter((timer) => timer.delay === productionGc);
		for (const timer of due) timer.callback();
		expect(queryClient.getQueryData<unknown>(key)).toEqual(before);
		// Reopen: recover the retained original intent, not a newly minted request.
		const retained = queryClient.getQueryData<unknown>(key);
		if (!isDeviceWorkspaceTransition(retained)) throw new Error("Missing recovery intent");
		phase = "installed";
		await executeDeviceWorkspaceIntent(queryClient, retained.intent, true);
		expect(receiptIds.at(-1)).toBe("original-r");
		expect(queryClient.getQueryData<unknown>(key)).toBe(false);
		for (const timer of [...timers.values()].filter((timer) => timer.delay === productionGc)) {
			timer.callback();
		}
		expect(queryClient.getQueryData<unknown>(key)).toBeUndefined();
	});
}
