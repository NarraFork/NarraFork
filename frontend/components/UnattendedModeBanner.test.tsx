import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { UNATTENDED_CHANGED_WS_TYPE } from "@shared/unattended";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { UnattendedStatus } from "../lib/api/unattended";

const originalApi = { ...(await import("../lib/api")) };
const originalAuth = { ...(await import("../hooks/useAuth")) };
const originalI18n = { ...(await import("react-i18next")) };
let admin = false;
let cancels = 0;
let cancelError: Error | null = null;
let status: UnattendedStatus;
let onStatusChanged: () => void;

mock.module("../lib/narrator-ws-manager", () => ({
	narratorWSManager: {
		addListener: ({ types }: { types: string[] }, listener: () => void) => {
			expect(types).toEqual([UNATTENDED_CHANGED_WS_TYPE]);
			onStatusChanged = listener;
			return {};
		},
		removeListener: () => {},
		onConnectionChange: () => () => {},
	},
}));

function fixture(overrides: Partial<UnattendedStatus> = {}): UnattendedStatus {
	return {
		enabled: true,
		phase: "quiet",
		shutdownAt: new Date(Date.now() + 90_000).toISOString(),
		blocked: false,
		options: { powerOff: true, quietSeconds: 30, armDelaySeconds: 0 },
		blockers: {
			narrators: 0,
			compacting: 0,
			queuedDeliveries: false,
			backgroundTasks: false,
			dueScheduledTasks: false,
			maintenance: false,
			unknown: false,
		},
		...overrides,
	};
}

mock.module("../hooks/useAuth", () => ({
	...originalAuth,
	useCurrentUser: () => ({ data: { sub: "u1", role: admin ? "admin" : "user" } }),
}));
mock.module("react-i18next", () => ({
	...originalI18n,
	useTranslation: () => ({
		t: (key: string, args?: object) => (args ? `${key} ${JSON.stringify(args)}` : key),
	}),
}));
mock.module("../lib/api", () => ({
	...originalApi,
	api: {
		...originalApi.api,
		getUnattendedStatus: async () => status,
		cancelUnattendedMode: async () => {
			cancels++;
			if (cancelError) throw cancelError;
			status = fixture({ enabled: false, phase: "off", shutdownAt: null });
			return { success: true, status };
		},
	},
}));

const { UnattendedModeBanner } = await import("./UnattendedModeBanner");

let root: Root | null = null;
let container: HTMLElement;
let client: QueryClient;
const globals = new Map<string, PropertyDescriptor | undefined>();

function install(key: string, value: unknown) {
	globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
	Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
}

beforeEach(() => {
	admin = false;
	cancels = 0;
	cancelError = null;
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
					<UnattendedModeBanner />
				</QueryClientProvider>
			</MantineProvider>,
		),
	);
	await flush();
}

function banner() {
	return container.querySelector(".nf-top-banner") as HTMLElement | null;
}

describe("UnattendedModeBanner", () => {
	test("renders nothing while the mode is off", async () => {
		status = fixture({ enabled: false, phase: "off", shutdownAt: null });
		await render();
		expect(banner()).toBeNull();
		// Mantine injects a <style> node, so assert on our own text, not the container's.
		expect(container.textContent).not.toContain("unattendedBannerOn");
		expect(container.querySelector("button")).toBeNull();
	});

	test("updates on remote arm, countdown and cancel without waiting for a poll", async () => {
		status = fixture({ enabled: false, phase: "off", shutdownAt: null });
		await render();
		expect(banner()).toBeNull();

		status = fixture({ phase: "waiting", shutdownAt: null });
		await act(async () => onStatusChanged());
		await flush();
		expect(container.textContent).toContain("unattendedBannerWaiting");

		status = fixture();
		await act(async () => onStatusChanged());
		await flush();
		expect(container.textContent).toContain("unattendedBannerCountdown");

		status = fixture({ enabled: false, phase: "off", shutdownAt: null });
		await act(async () => onStatusChanged());
		await flush();
		expect(banner()).toBeNull();
	});

	test("shows the countdown in a fixed second-row banner for ordinary users", async () => {
		await render();
		expect(container.textContent).toContain("unattendedBannerOn");
		expect(container.textContent).toContain("unattendedBannerCountdown");
		const element = banner();
		expect(element).not.toBeNull();
		expect(element?.getAttribute("style") ?? "").toContain("64px");
		expect(element?.getAttribute("style") ?? "").toContain("fixed");
	});

	test("the first countdown uses the current time after the banner has been disarmed", async () => {
		admin = true;
		let now = Date.parse("2026-11-21T17:13:10.489Z");
		const clock = spyOn(Date, "now").mockImplementation(() => now);
		try {
			status = fixture({ enabled: false, phase: "off", shutdownAt: null });
			await render();
			expect(banner()).toBeNull();

			now += 101_000;
			status = fixture({
				armedAt: new Date(now).toISOString(),
				shutdownAt: new Date(now + 70_000).toISOString(),
				options: { powerOff: false, quietSeconds: 10, armDelaySeconds: 70 },
			});
			await act(async () => onStatusChanged());
			await flush();
			expect(banner()?.textContent).toContain('"remaining":"1:10"');
		} finally {
			clock.mockRestore();
		}
	});

	test("every signed-in user gets the kill switch, and it cancels the mode", async () => {
		await render();
		const button = [...container.querySelectorAll("button")].find(
			(entry) => entry.textContent === "unattendedBannerDisable",
		) as HTMLButtonElement | undefined;
		expect(button).toBeDefined();
		await act(async () => button?.click());
		await flush();
		expect(cancels).toBe(1);
		expect(banner()).toBeNull();
		expect(container.textContent).not.toContain("unattendedBannerOn");
	});

	test("explains what it is waiting for instead of counting down", async () => {
		status = fixture({
			phase: "waiting",
			shutdownAt: null,
			blocked: true,
			blockers: {
				narrators: 2,
				compacting: 0,
				queuedDeliveries: true,
				backgroundTasks: false,
				dueScheduledTasks: false,
				maintenance: false,
				unknown: false,
			},
		});
		await render();
		expect(container.textContent).toContain("unattendedBlockedNarrators");
		expect(container.textContent).toContain('"count":2');
	});

	test("after the shutdown began there is no cancel button left", async () => {
		status = fixture({ phase: "shutting_down", shutdownAt: null });
		await render();
		expect(container.textContent).toContain("unattendedBannerClosing");
		expect(
			[...container.querySelectorAll("button")].some(
				(entry) => entry.textContent === "unattendedBannerDisable",
			),
		).toBe(false);
	});

	test("a refused cancellation explains that it is too late", async () => {
		cancelError = new Error("conflict");
		await render();
		const button = [...container.querySelectorAll("button")].find(
			(entry) => entry.textContent === "unattendedBannerDisable",
		) as HTMLButtonElement | undefined;
		await act(async () => button?.click());
		await flush();
		expect(cancels).toBe(1);
		expect(container.textContent).toContain("conflict");
		expect(banner()).not.toBeNull();
	});
});
