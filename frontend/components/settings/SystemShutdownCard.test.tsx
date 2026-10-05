import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SystemLifecycleNotice, SystemLifecycleStatus } from "../../lib/api/system-lifecycle";

const originalApi = { ...(await import("../../lib/api")) };
const originalAuth = { ...(await import("../../hooks/useAuth")) };
const originalI18n = { ...(await import("react-i18next")) };
const originalConfirm = { ...(await import("../common/confirm-dialog-context")) };
let admin = true;
let accepted = true;
let confirmations = 0;
let statusCalls = 0;
let status: SystemLifecycleStatus;
let actionError: string | null = null;
let prepareGate: Promise<void> | null = null;
let statusError: Error | null = null;
let shutdownPhase: SystemLifecycleStatus["phase"] = "shutting_down";
const actions: string[] = [];
mock.module("../../hooks/useAuth", () => ({
	...originalAuth,
	useCurrentUser: () => ({ data: { role: admin ? "admin" : "user" } }),
}));
mock.module("react-i18next", () => ({
	...originalI18n,
	useTranslation: () => ({
		t: (key: string, args?: object) => (args ? `${key} ${JSON.stringify(args)}` : key),
	}),
}));
mock.module("../common/confirm-dialog-context", () => ({
	...originalConfirm,
	useConfirmDialog: () => async () => {
		confirmations++;
		return accepted;
	},
}));
async function perform(kind: string) {
	actions.push(kind);
	if (prepareGate && kind === "prepare") await prepareGate;
	if (actionError) throw new Error(actionError);
	status = {
		...status,
		phase: kind === "prepare" ? "prepared" : kind === "cancel" ? "idle" : shutdownPhase,
		shutdownRequested: kind === "shutdown",
	};
	return { success: true, status };
}
mock.module("../../lib/api", () => ({
	...originalApi,
	api: {
		...originalApi.api,
		getSystemLifecycleStatus: async () => {
			statusCalls++;
			if (statusError) throw statusError;
			return status;
		},
		prepareSystemRecovery: () => perform("prepare"),
		shutdownSystem: () => perform("shutdown"),
		cancelSystemRecovery: () => perform("cancel"),
	},
}));
const { SystemShutdownCard } = await import("./SystemShutdownCard");
let root: Root | null = null;
let container: HTMLElement;
let client: QueryClient;
const globals = new Map<string, PropertyDescriptor | undefined>();
function install(key: string, value: unknown) {
	globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
	Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
}
beforeEach(() => {
	admin = true;
	accepted = true;
	confirmations = 0;
	statusCalls = 0;
	actions.length = 0;
	actionError = null;
	prepareGate = null;
	statusError = null;
	shutdownPhase = "shutting_down";
	status = {
		phase: "idle",
		shutdownRequested: false,
		coordination: {
			phase: "idle",
			scheduled: false,
			pendingBackgroundBashCount: 2,
			pendingOrdinaryExecutionCount: 3,
			resumableExecutionCount: 4,
			pausedToolCount: 5,
			blockers: ["busy"],
		},
	};
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
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	container = window.document.createElement("div") as unknown as HTMLElement;
	window.document.body.appendChild(container);
});
afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	container.remove();
	client.clear();
	for (const [key, descriptor] of globals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	globals.clear();
});
afterAll(() => mock.restore());
async function flush(ms = 15) {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, ms));
	});
}
async function render() {
	root = createRoot(container);
	await act(async () =>
		root?.render(
			<MantineProvider>
				<QueryClientProvider client={client}>
					<SystemShutdownCard />
				</QueryClientProvider>
			</MantineProvider>,
		),
	);
	await flush();
}
function button(key: string) {
	const value = [...container.querySelectorAll("button")].find(
		(entry) => entry.textContent === key,
	);
	if (!value) throw new Error(`Missing button ${key}: ${container.textContent}`);
	return value;
}
async function click(key: string) {
	await act(async () => button(key).click());
	await flush();
}

describe("SystemShutdownCard", () => {
	test("non-admins cannot see the card or request lifecycle status", async () => {
		admin = false;
		await render();
		expect(container.textContent).not.toContain("systemShutdownTitle");
		expect(container.querySelector("button")).toBeNull();
		expect(statusCalls).toBe(0);
	});
	test("prepare freezes work without shutdown and cancellation resumes it", async () => {
		await render();
		expect(container.textContent).toContain(
			'"bash":2,"executions":3,"resumable":4,"paused":5,"blockers":1',
		);
		await click("systemRecoveryPrepare");
		expect(actions).toEqual(["prepare"]);
		expect(container.textContent).toContain("systemRecoveryPrepared");
		expect(client.getQueryData<SystemLifecycleNotice>(["system-lifecycle-notice"])).toEqual({
			phase: "prepared",
			shutdownRequested: false,
		});
		expect(button("systemRecoveryPrepare").disabled).toBe(true);
		await click("systemRecoveryCancel");
		expect(actions).toEqual(["prepare", "cancel"]);
		expect(button("systemRecoveryPrepare").disabled).toBe(false);
	});
	test("declining the dangerous confirmation does not call shutdown", async () => {
		accepted = false;
		await render();
		await click("systemShutdownAction");
		expect(confirmations).toBe(1);
		expect(actions).toEqual([]);
	});
	test("shutdown can be requested directly and terminal status stops polling", async () => {
		await render();
		await click("systemShutdownAction");
		expect(actions).toEqual(["shutdown"]);
		expect(confirmations).toBe(1);
		expect(container.textContent).toContain("systemShutdownManualStart");
		expect(button("systemShutdownAction").disabled).toBe(true);
		const calls = statusCalls;
		await flush(2150);
		expect(statusCalls).toBe(calls);
	});
	test("queued shutdown displays preparation progress and permits cancellation", async () => {
		status = { ...status, phase: "preparing", shutdownRequested: true };
		await render();
		expect(container.textContent).toContain("systemShutdownQueued");
		expect(container.textContent).not.toContain("systemShutdownManualStart");
		expect(button("systemShutdownAction").disabled).toBe(true);
		await click("systemRecoveryCancel");
		expect(actions).toEqual(["cancel"]);
	});
	test("a preparing shutdown response retains manual-start guidance when the next status fetch loses connection", async () => {
		shutdownPhase = "preparing";
		status.error = "Preparation remains blocked";
		await render();
		await click("systemShutdownAction");
		expect(container.textContent).toContain("systemShutdownQueued");
		expect(container.textContent).not.toContain("systemShutdownManualStart");
		statusError = new TypeError("Failed to fetch");
		await act(async () => {
			await client.invalidateQueries({ queryKey: ["system-lifecycle"] });
		});
		await flush();
		expect(container.textContent).toContain("systemShutdownDisconnected");
		expect(container.textContent).toContain("systemShutdownQueued");
		expect(container.textContent).toContain("Preparation remains blocked");
		expect(container.textContent).not.toContain("systemShutdownManualStart");
		expect(button("systemRecoveryCancel").disabled).toBe(true);
		const calls = statusCalls;
		await act(async () => {
			await client.invalidateQueries({ queryKey: ["system-lifecycle"] });
		});
		await flush(2150);
		expect(statusCalls).toBe(calls);
	});
	test("an HTTP service error after shutdown is visible and is not misreported as disconnected", async () => {
		shutdownPhase = "preparing";
		await render();
		await click("systemShutdownAction");
		statusError = new originalApi.ApiError("Lifecycle service unavailable", 503);
		await act(async () => {
			await client.invalidateQueries({ queryKey: ["system-lifecycle"] });
		});
		await flush();
		expect(container.textContent).toContain("Lifecycle service unavailable");
		expect(container.textContent).toContain("systemShutdownQueued");
		expect(container.textContent).not.toContain("systemShutdownDisconnected");
	});
	test("a connection error without a shutdown request keeps ordinary error handling", async () => {
		await render();
		statusError = new TypeError("Network offline");
		await act(async () => {
			await client.invalidateQueries({ queryKey: ["system-lifecycle"] });
		});
		await flush();
		expect(container.textContent).toContain("Network offline");
		expect(container.textContent).not.toContain("systemShutdownDisconnected");
	});
	test("pending requests prevent duplicate actions and conflict errors remain visible", async () => {
		let resolve: (() => void) | undefined;
		prepareGate = new Promise<void>((done) => {
			resolve = done;
		});
		actionError = "Recovery is already in progress";
		await render();
		await click("systemRecoveryPrepare");
		expect(button("systemShutdownAction").disabled).toBe(true);
		await act(async () => resolve?.());
		await flush();
		expect(container.textContent).toContain(actionError);
		expect(button("systemRecoveryPrepare").disabled).toBe(false);
	});
	test("failed preparation exposes its error and a cancellation entry", async () => {
		status = { ...status, phase: "failed", error: "Unrecoverable tool" };
		await render();
		expect(container.textContent).toContain("Unrecoverable tool");
		expect(button("systemRecoveryCancel").disabled).toBe(false);
	});
});
