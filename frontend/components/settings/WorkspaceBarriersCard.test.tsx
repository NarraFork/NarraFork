import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { WorkspaceBarrier, WorkspaceBarrierObservationResult } from "../../lib/api/types";

const originalApi = { ...(await import("../../lib/api")) };
const originalI18n = { ...(await import("react-i18next")) };
const originalConfirm = { ...(await import("../common/confirm-dialog-context")) };
const originalNotifications = { ...(await import("@mantine/notifications")) };
const pageCalls: (string | undefined)[] = [];
const recoverCalls: unknown[] = [];
let pages: { items: WorkspaceBarrier[]; nextCursor: string | null }[] = [];
let observe: (
	scopeId: string,
	leaseId?: string | null,
	signal?: AbortSignal,
) => Promise<WorkspaceBarrierObservationResult>;
mock.module("../../lib/api", () => ({
	...originalApi,
	api: {
		...originalApi.api,
		getWorkspaceBarriers: async (cursor?: string) => {
			pageCalls.push(cursor);
			return pages[cursor ? 1 : 0];
		},
		observeWorkspaceBarrier: (...args: Parameters<typeof observe>) => observe(...args),
		recoverWorkspaceBarrier: async (...args: unknown[]) => {
			recoverCalls.push(args);
			return { recovered: "root_verified", settledEffectCount: 0 };
		},
	},
}));
mock.module("react-i18next", () => ({
	...originalI18n,
	useTranslation: () => ({
		t: (key: string, args?: object) => (args ? `${key} ${JSON.stringify(args)}` : key),
	}),
}));
mock.module("../common/confirm-dialog-context", () => ({
	...originalConfirm,
	useConfirmDialog: () => async () => true,
}));
mock.module("@mantine/notifications", () => ({
	...originalNotifications,
	notifications: { ...originalNotifications.notifications, show: () => "test" },
}));
const { WorkspaceBarriersCard } = await import("./WorkspaceBarriersCard");

let root: Root | null = null;
let container: HTMLElement;
let client: QueryClient;
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
function install(key: string, value: unknown) {
	if (!savedGlobals.has(key))
		savedGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
	Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
}
beforeEach(() => {
	pageCalls.length = 0;
	recoverCalls.length = 0;
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	install("window", window);
	install("document", window.document);
	install("navigator", window.navigator);
	install("HTMLElement", window.HTMLElement);
	install("Element", window.Element);
	install("Node", window.Node);
	install("IS_REACT_ACT_ENVIRONMENT", true);
	install("requestAnimationFrame", (callback: (time: number) => void) =>
		setTimeout(() => callback(Date.now()), 0),
	);
	install("cancelAnimationFrame", (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
	install("matchMedia", () => ({
		matches: false,
		addEventListener() {},
		removeEventListener() {},
		addListener() {},
		removeListener() {},
	}));
	client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
	});
	container = window.document.createElement("div") as unknown as HTMLElement;
	window.document.body.appendChild(container);
});
afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	container.remove();
	client.clear();
	for (const [key, descriptor] of savedGlobals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	savedGlobals.clear();
});
afterAll(() => mock.restore());

function barrier(overrides: Partial<WorkspaceBarrier> = {}): WorkspaceBarrier {
	return {
		scope: {
			id: "scope-a",
			deviceId: "local",
			canonicalRoot: "/workspace",
			pathFlavor: "posix",
			status: "needs_verification",
			activeLeaseId: null,
			activeMutationCount: 0,
			updatedAt: "2026-09-20T00:00:00Z",
		},
		leaseId: null,
		kind: "unverified_root",
		local: true,
		ranges: [{ kind: "subtree", canonicalPath: "/workspace" }],
		executionEnded: true,
		blockedReason: null,
		operations: [],
		effects: [],
		...overrides,
	};
}
async function flush() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 5));
	});
}
async function render() {
	root = createRoot(container);
	await act(async () =>
		root?.render(
			<MantineProvider>
				<QueryClientProvider client={client}>
					<WorkspaceBarriersCard />
				</QueryClientProvider>
			</MantineProvider>,
		),
	);
	await flush();
}
function button(text: string): HTMLButtonElement {
	const result = [...container.querySelectorAll("button")].find(
		(entry) => entry.textContent === text,
	);
	if (!result) throw new Error(`Missing button ${text}: ${container.textContent}`);
	return result;
}
async function click(text: string) {
	await act(async () => {
		button(text).dispatchEvent(new window.Event("click", { bubbles: true }));
	});
	await flush();
}

describe("workspace barrier confirmation UI", () => {
	test("loads the next cursor page and displays actual ranges, owner state and blocking reason", async () => {
		pages = [
			{ items: [], nextCursor: "scope:0" },
			{
				items: [
					barrier({
						leaseId: "lease-a",
						kind: "quarantined",
						ranges: [{ kind: "file", canonicalPath: "/workspace/only-a.txt" }],
						executionEnded: false,
						blockedReason: "Owner is still executing",
					}),
				],
				nextCursor: null,
			},
		];
		await render();
		await click("workspaceBarriersLoadMore");
		expect(pageCalls).toEqual([undefined, "scope:0"]);
		expect(container.textContent).toContain("/workspace/only-a.txt");
		expect(container.textContent).toContain("workspaceBarriersExecutionUnknown");
		expect(container.textContent).toContain("Owner is still executing");
		expect(button("workspaceBarriersObserve").disabled).toBe(true);
		expect(button("workspaceBarriersRecoverAction").disabled).toBe(true);
	});

	test("even first root verification requires preview and submits its exact token", async () => {
		const item = barrier();
		pages = [{ items: [item], nextCursor: null }];
		observe = async () => ({
			scope: item.scope,
			leaseId: null,
			observations: [],
			rangeObservations: [],
			confirmationToken: "a".repeat(64),
		});
		await render();
		expect(button("workspaceBarriersRecoverAction").disabled).toBe(true);
		await click("workspaceBarriersObserve");
		expect(container.textContent).toContain("a".repeat(64));
		expect(button("workspaceBarriersRecoverAction").disabled).toBe(false);
		await click("workspaceBarriersRecoverAction");
		expect(recoverCalls).toEqual([
			[
				"scope-a",
				{
					leaseId: undefined,
					confirmationToken: "a".repeat(64),
					acknowledgements: [],
					acknowledgeInspected: false,
				},
			],
		]);
	});

	test("cancels observation with the exact lease ID and leaves recovery disabled", async () => {
		const item = barrier({ leaseId: "lease-a", kind: "quarantined" });
		pages = [{ items: [item], nextCursor: null }];
		let receivedLease: string | null | undefined;
		let receivedSignal: AbortSignal | undefined;
		observe = async (_scopeId, leaseId, signal) => {
			receivedLease = leaseId;
			receivedSignal = signal;
			return new Promise((_resolve, reject) =>
				signal?.addEventListener("abort", () => reject(signal.reason), { once: true }),
			);
		};
		await render();
		await click("workspaceBarriersObserve");
		expect(receivedLease).toBe("lease-a");
		await click("workspaceBarriersCancel");
		expect(receivedSignal?.aborted).toBe(true);
		expect(button("workspaceBarriersRecoverAction").disabled).toBe(true);
		expect(recoverCalls).toHaveLength(0);
	});
});
