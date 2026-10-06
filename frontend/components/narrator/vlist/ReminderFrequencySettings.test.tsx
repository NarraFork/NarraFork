import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { api } from "@frontend/lib/api";
import { MantineProvider, Popover } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import type { RenderExtra } from "./render-registry";
import { injectInjectionBubbleChrome } from "./vlist-injection-header";

const i18n = i18next.createInstance();
await i18n.init({
	lng: "en",
	resources: { en: { narrator: {}, common: {} } },
	react: { useSuspense: false },
});
let root: Root;
let qc: QueryClient;
const globals = new Map<string, PropertyDescriptor | undefined>();
/** Undoes the shared-prototype geometry stubs installed in beforeEach. */
let restoreGeometry: (() => void) | undefined;
let makeEvent: (name: string) => Event;
let setValue: (input: HTMLInputElement, value: string) => void;
let settings = { agent: { tasksReminderInterval: 15, silentToolCallThreshold: 50 } };
let getSettings: ReturnType<typeof spyOn<typeof api, "getSettings">>;
let updateSettings: ReturnType<typeof spyOn<typeof api, "updateSettings">>;
let updateReflection: ReturnType<typeof spyOn<typeof api, "updateNarratorReflectionOverrides">>;
let navigations = 0;
let rowClicks = 0;

beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	makeEvent = (name) =>
		new (window as unknown as { Event: typeof Event }).Event(name, {
			bubbles: true,
			cancelable: true,
		});
	setValue = (input, value) => {
		Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(
			input,
			value,
		);
	};
	Object.defineProperties(window.HTMLInputElement.prototype, {
		attachEvent: { value() {}, configurable: true },
		detachEvent: { value() {}, configurable: true },
		setSelectionRange: { value() {}, configurable: true },
	});
	// linkedom shares ONE HTMLElement.prototype across every parseHTML window, so these
	// stubs are process-global. Leaving them installed hands this file's fake rects to
	// later test FILES — including the ones asserting that no geometry is read at all,
	// which then fail on a stub they never installed.
	const geometryProto = window.HTMLElement.prototype;
	const previousGeometry = new Map(
		["getBoundingClientRect", "getClientRects"].map((key) => [
			key,
			Object.getOwnPropertyDescriptor(geometryProto, key),
		]),
	);
	restoreGeometry = () => {
		for (const [key, descriptor] of previousGeometry) {
			if (descriptor) Object.defineProperty(geometryProto, key, descriptor);
			else Reflect.deleteProperty(geometryProto, key);
		}
	};
	Object.defineProperties(geometryProto, {
		getBoundingClientRect: {
			value: () => ({ x: 0, y: 0, top: 0, left: 0, right: 20, bottom: 20, width: 20, height: 20 }),
			configurable: true,
		},
		getClientRects: { value: () => [], configurable: true },
	});
	const computedStyle = () =>
		new Proxy({}, { get: (_target, key) => (key === "getPropertyValue" ? () => "" : "") });
	const matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
	const values: Record<string, unknown> = {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		HTMLInputElement: window.HTMLInputElement,
		HTMLAnchorElement: window.HTMLAnchorElement,
		Element: window.Element,
		Node: window.Node,
		Document: window.Document,
		ShadowRoot: class {},
		getComputedStyle: computedStyle,
		matchMedia,
		ResizeObserver: class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
		requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0),
		cancelAnimationFrame: (id: Timer) => clearTimeout(id),
		localStorage: { getItem: () => null },
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	for (const [key, value] of Object.entries(values)) {
		globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
	}
	Object.assign(window, { getComputedStyle: computedStyle, matchMedia });
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	qc = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
	});
	qc.setQueryData(["auth", "me"], { id: "admin", role: "admin" });
	qc.setQueryData(["narrators", "owner"], { id: "owner", tasksReminderIntervalOverride: 30 });
	settings = { agent: { tasksReminderInterval: 15, silentToolCallThreshold: 50 } };
	getSettings = spyOn(api, "getSettings").mockImplementation(async () => settings);
	updateSettings = spyOn(api, "updateSettings").mockImplementation(async (data) => {
		settings = { agent: { ...settings.agent, ...(data.agent as typeof settings.agent) } };
		return settings;
	});
	updateReflection = spyOn(api, "updateNarratorReflectionOverrides").mockResolvedValue({
		ok: true,
	});
	navigations = 0;
	rowClicks = 0;
});

afterEach(async () => {
	await act(async () => root.unmount());
	qc.clear();
	getSettings.mockRestore();
	updateSettings.mockRestore();
	updateReflection.mockRestore();
	for (const [key, descriptor] of globals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	globals.clear();
	restoreGeometry?.();
	restoreGeometry = undefined;
});

async function render(source: string, narratorId: string | undefined = "owner") {
	const extra: RenderExtra = {
		source,
		target: { kind: "spec", uri: "spec://tasks.json" },
	};
	injectInjectionBubbleChrome(
		"injection-bubble",
		extra,
		undefined,
		{ onOpenSpec: () => navigations++ },
		narratorId,
	);
	await act(async () => {
		root.render(
			<I18nextProvider i18n={i18n}>
				<QueryClientProvider client={qc}>
					<MantineProvider
						env="test"
						theme={{
							components: {
								Popover: Popover.extend({ defaultProps: { transitionProps: { duration: 0 } } }),
							},
						}}
					>
						{/* biome-ignore lint/a11y/noStaticElementInteractions: simulates the list's delegated selection surface. */}
						<div role="presentation" onClick={() => rowClicks++}>
							{extra.header as React.ReactNode}
						</div>
					</MantineProvider>
				</QueryClientProvider>
			</I18nextProvider>,
		);
	});
}

async function click(element: Element | null) {
	if (!element) throw new Error("missing button");
	await act(async () => element.dispatchEvent(makeEvent("click")));
	await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}
function button(label: string) {
	return (
		[...document.querySelectorAll("button")].find((node) => node.textContent === label) ?? null
	);
}
async function open() {
	await click(document.querySelector('[aria-label="sidecar.frequency.title"]'));
}
function input() {
	const node = document.querySelector("input");
	if (!node) throw new Error("missing input");
	return node;
}
async function type(value: string) {
	const node = input();
	await act(async () => {
		node.dispatchEvent(makeEvent("focusin"));
		setValue(node, value);
		node.dispatchEvent(makeEvent("input"));
		node.dispatchEvent(makeEvent("keyup"));
	});
}

describe("reminder frequency quick settings", () => {
	test("only the two reminder sources have a settings button", async () => {
		for (const source of ["living_work_spec", "silent_progress", "behavior_fence", "spec_update"]) {
			await render(source);
			expect(!!document.querySelector('[aria-label="sidecar.frequency.title"]')).toBe(
				source === "living_work_spec" || source === "silent_progress",
			);
		}
		expect(getSettings).not.toHaveBeenCalled();
	});

	test("has no dead settings control without an owning session", async () => {
		await render("living_work_spec", "");
		expect(document.querySelector('[aria-label="sidecar.frequency.title"]')).toBeNull();
	});

	test("settings failures leave saving disabled and expose the error", async () => {
		getSettings.mockRejectedValueOnce(new Error("settings unavailable"));
		await render("living_work_spec");
		await open();
		expect(button("save")?.hasAttribute("disabled")).toBe(true);
		expect(document.querySelector('[role="alert"]')?.textContent).toBe("settings unavailable");
		expect(updateReflection).not.toHaveBeenCalled();
	});

	test("Escape closes the popover without triggering card navigation", async () => {
		await render("living_work_spec");
		await open();
		await act(async () => input().dispatchEvent(makeEvent("focusin")));
		const event = makeEvent("keydown");
		Object.defineProperty(event, "key", { value: "Escape" });
		await act(async () => input().dispatchEvent(event));
		expect(document.querySelector("input")).toBeNull();
		expect(navigations).toBe(0);
		expect(updateReflection).not.toHaveBeenCalled();
	});

	test("loads the session override and saves only to the owning session", async () => {
		await render("living_work_spec");
		expect(getSettings).not.toHaveBeenCalled();
		await open();
		expect(input().value).toBe("30");
		expect(document.body.textContent).toContain("sidecar.frequency.saveScope");
		await type("40");
		expect(updateReflection).not.toHaveBeenCalled();
		await click(button("sidecar.frequency.saveSession"));
		expect(updateReflection).toHaveBeenCalledWith("owner", { tasksReminderIntervalOverride: 40 });
		expect(updateSettings).not.toHaveBeenCalled();
		expect(navigations).toBe(0);
		expect(rowClicks).toBe(0);
	});

	test("restores the task digest's inherited default", async () => {
		await render("living_work_spec");
		await open();
		await click(button("override_followDefault"));
		expect(updateReflection).toHaveBeenCalledWith("owner", { tasksReminderIntervalOverride: null });
	});

	test("sets the draft as the global default before clearing the session override", async () => {
		updateReflection.mockImplementation(async () => {
			expect(settings.agent.tasksReminderInterval).toBe(40);
			return { ok: true };
		});
		await render("living_work_spec");
		await open();
		await type("40");
		await click(button("save"));
		expect(updateSettings.mock.calls[0]?.[0]).toEqual({ agent: { tasksReminderInterval: 40 } });
		expect(updateReflection).toHaveBeenCalledWith("owner", { tasksReminderIntervalOverride: null });
		expect(qc.getQueryData<typeof settings>(["settings"])?.agent.tasksReminderInterval).toBe(40);
	});

	test("Enter uses the primary Save action and updates the global default", async () => {
		await render("living_work_spec");
		await open();
		await type("40");
		const event = makeEvent("keydown");
		Object.defineProperty(event, "key", { value: "Enter" });
		await act(async () => input().dispatchEvent(event));
		expect(updateSettings.mock.calls[0]?.[0]).toEqual({ agent: { tasksReminderInterval: 40 } });
		expect(updateReflection).toHaveBeenCalledWith("owner", { tasksReminderIntervalOverride: null });
	});

	test("does not clear the session override when saving the default fails", async () => {
		updateSettings.mockRejectedValueOnce(new Error("default save failed"));
		await render("living_work_spec");
		await open();
		await type("40");
		await click(button("save"));
		expect(updateReflection).not.toHaveBeenCalled();
		expect(input().value).toBe("40");
		expect(document.querySelector('[role="alert"]')?.textContent).toBe("default save failed");
		await click(button("save"));
		expect(updateReflection).toHaveBeenCalledWith("owner", { tasksReminderIntervalOverride: null });
	});

	test("non-admins can save a session interval but cannot set a global default", async () => {
		qc.setQueryData(["auth", "me"], { id: "member", role: "user" });
		await render("living_work_spec");
		await open();
		expect(button("save")?.hasAttribute("disabled")).toBe(true);
		await type("25");
		await click(button("sidecar.frequency.saveSession"));
		expect(updateReflection).toHaveBeenCalledWith("owner", { tasksReminderIntervalOverride: 25 });
		expect(updateSettings).not.toHaveBeenCalled();
	});

	test("updates only the global progress threshold and synchronizes the cache", async () => {
		await render("silent_progress");
		await open();
		expect(input().value).toBe("50");
		expect(document.body.textContent).toContain("sidecar.frequency.globalScope");
		await type("20");
		await click(button("save"));
		expect(updateSettings.mock.calls[0]?.[0]).toEqual({ agent: { silentToolCallThreshold: 20 } });
		expect(updateReflection).not.toHaveBeenCalled();
		expect(qc.getQueryData<typeof settings>(["settings"])).toEqual({
			agent: { tasksReminderInterval: 15, silentToolCallThreshold: 20 },
		});
	});

	test("rejects invalid task intervals and accepts -1 to disable", async () => {
		await render("living_work_spec");
		await open();
		for (const value of ["", "0", "4"]) {
			await type(value);
			expect(button("save")?.hasAttribute("disabled")).toBe(true);
			expect(button("sidecar.frequency.saveSession")?.hasAttribute("disabled")).toBe(true);
		}
		await type("-1");
		await click(button("sidecar.frequency.saveSession"));
		expect(updateReflection).toHaveBeenCalledWith("owner", { tasksReminderIntervalOverride: -1 });
	});

	test("non-admins can inspect but cannot modify the global threshold", async () => {
		qc.setQueryData(["auth", "me"], { id: "member", role: "user" });
		await render("silent_progress");
		await open();
		expect(input().disabled).toBe(true);
		expect(button("save")?.hasAttribute("disabled")).toBe(true);
		expect(document.body.textContent).toContain("sidecar.frequency.adminOnly");
		expect(updateSettings).not.toHaveBeenCalled();
	});

	test("failed saves retain the draft and show an error for retry", async () => {
		updateSettings.mockRejectedValueOnce(new Error("save failed"));
		await render("silent_progress");
		await open();
		await type("25");
		await click(button("save"));
		expect(input().value).toBe("25");
		expect(document.querySelector('[role="alert"]')?.textContent).toBe("save failed");
		await click(button("save"));
		expect(updateSettings).toHaveBeenCalledTimes(2);
	});
});
