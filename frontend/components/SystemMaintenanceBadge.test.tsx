import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { act, type PropsWithChildren } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SystemLifecycleNotice } from "../lib/api/system-lifecycle";
import { systemLifecycleNoticeQueryKey } from "../lib/api/system-lifecycle";

const originalApi = { ...(await import("../lib/api")) };
const originalAuth = { ...(await import("../hooks/useAuth")) };
const originalI18n = { ...(await import("react-i18next")) };
const originalMantine = { ...(await import("@mantine/core")) };
// Only the floating-positioning shell is replaced: Linkedom has no layout engine.
// The actual buttons, query updates and administrator action run unchanged.
const TestPopover = Object.assign(({ children }: PropsWithChildren) => <div>{children}</div>, {
	Target: ({ children }: PropsWithChildren) => <>{children}</>,
	Dropdown: ({ children }: PropsWithChildren) => <div>{children}</div>,
});
mock.module("@mantine/core", () => ({ ...originalMantine, Popover: TestPopover }));
const { MantineProvider } = await import("@mantine/core");
let role: "admin" | "user" | null = "admin";
let notice: SystemLifecycleNotice;
let calls = 0;
let cancellations = 0;
let failure: Error | null = null;
let noticeFailure: Error | null = null;
mock.module("../hooks/useAuth", () => ({
	...originalAuth,
	useCurrentUser: () => ({ data: role ? { role } : undefined }),
}));
mock.module("react-i18next", () => ({
	...originalI18n,
	useTranslation: () => ({ t: (key: string) => key }),
}));
mock.module("../lib/api", () => ({
	...originalApi,
	api: {
		...originalApi.api,
		getSystemLifecycleNotice: async () => {
			calls++;
			if (noticeFailure) throw noticeFailure;
			return notice;
		},
		cancelSystemRecovery: async () => {
			cancellations++;
			if (failure) throw failure;
			notice = { phase: "idle", shutdownRequested: false };
			return { success: true, status: { ...notice, coordination: {} } };
		},
	},
}));
const { SystemMaintenanceBadge } = await import("./SystemMaintenanceBadge");
const globals = new Map<string, PropertyDescriptor | undefined>();
let root: Root | null = null;
let container: HTMLElement;
let client: QueryClient;
function install(key: string, value: unknown) {
	globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
	Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
beforeEach(() => {
	role = "admin";
	notice = { phase: "prepared", shutdownRequested: false };
	calls = 0;
	cancellations = 0;
	failure = null;
	noticeFailure = null;
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		IS_REACT_ACT_ENVIRONMENT: true,
		requestAnimationFrame: (callback: (time: number) => void) =>
			setTimeout(() => callback(Date.now()), 0),
		cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
		matchMedia: () => ({
			matches: false,
			addEventListener() {},
			removeEventListener() {},
			addListener() {},
			removeListener() {},
		}),
	}))
		install(key, value);
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
async function flush() {
	await act(async () => {
		await Bun.sleep(20);
	});
}
async function render() {
	root = createRoot(container);
	await act(async () =>
		root?.render(
			<MantineProvider>
				<QueryClientProvider client={client}>
					<SystemMaintenanceBadge />
				</QueryClientProvider>
			</MantineProvider>,
		),
	);
	await flush();
}

describe("global maintenance indication", () => {
	test.each(["idle", "failed"] as const)("no warning for inactive state %s", async (phase) => {
		notice.phase = phase;
		await render();
		expect(container.querySelector("button")).toBeNull();
	});
	test("ordinary users see the pause explanation but cannot cancel preparation", async () => {
		role = "user";
		await render();
		expect(container.textContent).toContain("systemMaintenancePaused");
		expect(container.textContent).toContain("systemMaintenancePausedDescription");
		expect(container.textContent).toContain("systemMaintenanceContactAdmin");
		expect(container.textContent).not.toContain("systemMaintenanceResume");
		expect(cancellations).toBe(0);
	});

	test("administrator can resume from the header and update the settings card cache", async () => {
		await render();
		const button = [...container.querySelectorAll("button")].find(
			(node) => node.textContent === "systemMaintenanceResume",
		);
		expect(button).toBeDefined();
		await act(async () => button?.click());
		await flush();
		expect(cancellations).toBe(1);
		expect(container.querySelector("button")).toBeNull();
		expect(client.getQueryData(["system-lifecycle"])).toMatchObject({ phase: "idle" });
	});

	test("preparing and shutdown have distinct labels and closing cannot be cancelled", async () => {
		notice.phase = "preparing";
		await render();
		expect(container.textContent).toContain("systemMaintenancePreparing");
		await act(async () =>
			client.setQueryData(systemLifecycleNoticeQueryKey, {
				phase: "shutting_down",
				shutdownRequested: true,
			}),
		);
		await flush();
		expect(container.textContent).toContain("systemMaintenanceClosing");
		expect(container.textContent).toContain("systemShutdownManualStart");
		expect(container.textContent).not.toContain("systemMaintenanceResume");
	});

	test("failed cancellation stays visible without hiding the pause marker", async () => {
		failure = new Error("Preparation is already closing");
		await render();
		const button = [...container.querySelectorAll("button")].find(
			(node) => node.textContent === "systemMaintenanceResume",
		);
		await act(async () => button?.click());
		await flush();
		expect(container.textContent).toContain("Preparation is already closing");
		expect(container.textContent).toContain("systemMaintenancePaused");
	});

	test("transient status errors retain the last known maintenance marker", async () => {
		await render();
		noticeFailure = new Error("network offline");
		await act(async () => {
			await client.invalidateQueries({ queryKey: systemLifecycleNoticeQueryKey });
		});
		expect(container.textContent).toContain("systemMaintenancePaused");
	});

	test("unauthenticated surfaces do not fetch or show instance maintenance", async () => {
		role = null;
		await render();
		expect(calls).toBe(0);
		expect(container.querySelector("button")).toBeNull();
		expect(container.textContent).not.toContain("systemMaintenancePaused");
	});
});
