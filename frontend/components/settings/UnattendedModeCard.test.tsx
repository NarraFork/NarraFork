import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { UnattendedStatus } from "../../lib/api/unattended";

const originalApi = { ...(await import("../../lib/api")) };
const originalAuth = { ...(await import("../../hooks/useAuth")) };
const originalI18n = { ...(await import("react-i18next")) };
const originalConfirm = { ...(await import("../common/confirm-dialog-context")) };
let admin = true;
let accepted = true;
let confirmations = 0;
let statusCalls = 0;
let patches: Array<Record<string, unknown>> = [];
let patchError: Error | null = null;
let statusError: Error | null = null;

function fixture(overrides: Partial<UnattendedStatus> = {}): UnattendedStatus {
	return {
		enabled: false,
		phase: "off",
		shutdownAt: null,
		blocked: false,
		options: { powerOff: true, quietSeconds: 120, armDelaySeconds: 70, powerOffCommand: null },
		blockers: {
			narrators: 0,
			compacting: 0,
			queuedDeliveries: false,
			backgroundTasks: false,
			dueScheduledTasks: false,
			maintenance: false,
			unknown: false,
		},
		powerOffPlan: { supported: true, command: ["/usr/bin/systemctl", "poweroff"] },
		lastError: undefined,
		...overrides,
	};
}

let status: UnattendedStatus = fixture();

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
mock.module("../../lib/api", () => ({
	...originalApi,
	api: {
		...originalApi.api,
		getUnattendedStatus: async () => {
			statusCalls++;
			if (statusError) throw statusError;
			return status;
		},
		setUnattendedMode: async (patch: Record<string, unknown>) => {
			patches.push(patch);
			if (patchError) throw patchError;
			status =
				patch.enabled === true
					? fixture({
							...status,
							enabled: true,
							phase: "waiting",
							options: {
								powerOff: Boolean(patch.powerOff ?? status.options.powerOff),
								quietSeconds: Number(patch.quietSeconds ?? status.options.quietSeconds),
								armDelaySeconds: Number(patch.armDelaySeconds ?? status.options.armDelaySeconds),
								powerOffCommand: (patch.powerOffCommand as string | null) ?? null,
							},
						})
					: fixture();
			return { success: true, status };
		},
	},
}));

const { UnattendedModeCard } = await import("./UnattendedModeCard");

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
	patches = [];
	patchError = null;
	statusError = null;
	status = fixture();
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
					<UnattendedModeCard />
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

describe("UnattendedModeCard", () => {
	test("non-administrators cannot see the card or request the status", async () => {
		admin = false;
		await render();
		expect(container.textContent).not.toContain("unattendedTitle");
		expect(container.querySelector("button")).toBeNull();
		expect(statusCalls).toBe(0);
	});

	test("enabling asks for confirmation and does nothing when declined", async () => {
		accepted = false;
		await render();
		expect(container.textContent).toContain("unattendedRestartDisarms");
		await click("unattendedEnableAction");
		expect(confirmations).toBe(1);
		expect(patches).toHaveLength(0);
	});

	test("enabling sends the displayed options", async () => {
		await render();
		await click("unattendedEnableAction");
		expect(confirmations).toBe(1);
		expect(patches).toEqual([
			{
				enabled: true,
				powerOff: true,
				quietSeconds: 120,
				armDelaySeconds: 70,
				powerOffCommand: null,
			},
		]);
		expect(container.textContent).toContain("unattendedPhase_waiting");
	});

	test("an armed mode shows its blockers, command and a way out", async () => {
		status = fixture({
			enabled: true,
			phase: "quiet",
			shutdownAt: "2026-01-01T00:02:00.000Z",
			blocked: true,
			options: { powerOff: true, quietSeconds: 30, armDelaySeconds: 0, powerOffCommand: null },
			blockers: {
				narrators: 2,
				compacting: 1,
				queuedDeliveries: true,
				backgroundTasks: true,
				dueScheduledTasks: false,
				maintenance: false,
				unknown: false,
			},
		});
		await render();
		expect(container.textContent).toContain("unattendedStatusCounts");
		expect(container.textContent).toContain('"narrators":2');
		expect(container.textContent).toContain("unattendedPowerOffCommandHint");
		expect(container.textContent).toContain("/usr/bin/systemctl poweroff");
		await click("unattendedDisable");
		expect(patches).toEqual([{ enabled: false }]);
		expect(container.textContent).toContain("unattendedPhase_off");
	});

	test("an unsupported platform is called out", async () => {
		status = fixture({
			enabled: true,
			phase: "waiting",
			powerOffPlan: { supported: false, command: null, note: "unsupported-platform" },
		});
		await render();
		expect(container.textContent).toContain("unattendedUnsupportedPlatform");
	});

	test("a failing patch surfaces the error", async () => {
		patchError = new Error("already shutting down");
		await render();
		await click("unattendedEnableAction");
		expect(container.textContent).toContain("already shutting down");
	});
});
