import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import type { ProviderQuotaSnapshot } from "@shared/provider-quota";
import { createInstance, type i18n } from "i18next";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import en from "../../../locales/en/narrator.json";
import zh from "../../../locales/zh-CN/narrator.json";
import { customApiQuotaDisplayFor } from "./custom-api-usage-source";
import { buildProviderQuotaView } from "./provider-quota-view";
import { QuotaPanelIndicator, useQuotaNow } from "./QuotaPanelIndicator";
import { formatQuotaBadgeText } from "./quota-panel-view";

let root: Root;
let host: HTMLElement;
let instance: i18n;
const originals = new Map<string, PropertyDescriptor | undefined>();
const NOW = Date.parse("2026-01-01T00:00:00Z");
beforeEach(async () => {
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	const globals = {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		Event: window.Event,
		getComputedStyle: () => ({ getPropertyValue: () => "", direction: "ltr" }),
		requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
		cancelAnimationFrame: (id: number) => clearTimeout(id),
		matchMedia: () => ({
			matches: false,
			addEventListener() {},
			removeEventListener() {},
			addListener() {},
			removeListener() {},
		}),
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	for (const [key, value] of Object.entries(globals)) {
		originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	Object.assign(window, {
		matchMedia: globals.matchMedia,
		requestAnimationFrame: globals.requestAnimationFrame,
		cancelAnimationFrame: globals.cancelAnimationFrame,
	});
	instance = createInstance();
	await instance.use(initReactI18next).init({
		lng: "en",
		resources: { en: { narrator: en }, "zh-CN": { narrator: zh } },
		defaultNS: "narrator",
		interpolation: { escapeValue: false },
	});
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(async () => root.unmount());
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	host.remove();
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	originals.clear();
});
function snapshot(overrides: Partial<ProviderQuotaSnapshot> = {}): ProviderQuotaSnapshot {
	return {
		providerId: "p",
		targetId: "custom-api/p",
		generation: "A",
		sourceId: "unregistered.third-party:general-quota",
		status: "supported",
		data: {
			amounts: [{ id: "wallet", label: "Wallet", unit: "credits", remaining: 42.5 }],
			windows: [
				{
					id: "requests",
					label: "Requests",
					unit: "requests",
					used: 25,
					limit: 100,
					remaining: 75,
					resetAt: new Date(NOW + 60_000).toISOString(),
				},
			],
			planName: "Third-party plan",
		},
		fetchedAt: NOW,
		attemptedAt: NOW,
		stale: false,
		error: null,
		version: 1,
		...overrides,
	};
}
async function render(data: ProviderQuotaSnapshot | null, isAdmin = false) {
	await act(async () =>
		root.render(
			<I18nextProvider i18n={instance}>
				<MantineProvider env="test" withCssVariables={false} withGlobalClasses={false}>
					<QuotaPanelIndicator
						view={buildProviderQuotaView(data, instance.t, isAdmin, false, NOW)}
						now={NOW}
						transitionDuration={0}
					/>
				</MantineProvider>
			</I18nextProvider>,
		),
	);
}
function trigger() {
	const button = host.querySelector("button");
	if (!button) throw new Error("expected generic quota indicator");
	return button;
}
async function openPanel() {
	await act(async () => {
		trigger().dispatchEvent(new window.Event("click", { bubbles: true }));
	});
	return document.body.textContent ?? "";
}

test.each([
	"en",
	"zh-CN",
])("third-party amounts/windows render through the production generic panel (%s)", async (locale) => {
	await instance.changeLanguage(locale);
	await render(snapshot());
	expect(trigger().getAttribute("aria-label")).toContain("credits 42.5");
	expect(trigger().querySelectorAll("[data-quota-bar]").length).toBe(1);
	const text = await openPanel();
	expect(text).toContain("Third-party plan");
	expect(text).toContain("credits 42.5");
	expect(text).toContain(instance.t("quotaPanel.usedOfLimit", { used: "25", limit: "100" }));
	expect(document.querySelector("iframe")).toBeNull();
});

test("stale successful values remain visible and dimmed after source failure", async () => {
	await render(snapshot({ status: "error", stale: true, error: "timeout" }));
	expect(trigger().querySelector("[data-quota-bars]")?.getAttribute("style")).toContain(
		"opacity:0.55",
	);
	expect(trigger().getAttribute("aria-label")).toContain(instance.t("quotaPanel.staleHint"));
	const text = await openPanel();
	expect(text).toContain("credits 42.5");
	expect(text).toContain(instance.t("quotaPanel.staleHint"));
});

test("unavailable sources render nothing; unknown and true zero remain distinct", async () => {
	await render(
		snapshot({ status: "unavailable", data: null, sourceId: null, error: "unavailable" }),
	);
	expect(host.innerHTML).toBe("");
	await render(
		snapshot({ data: { amounts: [{ id: "wallet", unit: "USD", remaining: null }], windows: [] } }),
	);
	expect(trigger().textContent).toBe(instance.t("providerQuota.unknown"));
	expect(trigger().textContent).not.toMatch(/USD 0|Unlimited/);
	await render(
		snapshot({ data: { amounts: [{ id: "wallet", unit: "USD", remaining: 0 }], windows: [] } }),
	);
	expect(trigger().textContent).toBe("USD 0");
});

test.each([
	["admin", "en"],
	["user", "en"],
	["admin", "zh-CN"],
	["user", "zh-CN"],
])("uninstalling clears an open cached panel and reinstalling restores quota (%s, %s)", async (role, locale) => {
	await instance.changeLanguage(locale);
	const old = snapshot();
	const unavailableStates: Partial<ProviderQuotaSnapshot>[] = [
		{ status: "unavailable", sourceId: null, error: "unavailable" },
		{ status: "supported", error: "unavailable" },
		{ status: "error", error: "unavailable" },
	];
	for (const state of unavailableStates) {
		await render(old, role === "admin");
		if (trigger().getAttribute("aria-expanded") !== "true") await openPanel();
		expect(document.body.textContent).toContain("Third-party plan");
		expect(document.body.textContent).toContain("credits 42.5");
		await render({ ...old, ...state, stale: true, version: 2 }, role === "admin");
		expect(host.innerHTML).toBe("");
		expect(document.body.textContent).toBe("");
		expect(document.querySelector("button")).toBeNull();
		const restored = snapshot({
			data: {
				amounts: [{ id: "wallet", unit: "credits", remaining: 0 }],
				windows: [],
				planName: "Reinstalled plan",
			},
			version: 3,
		});
		await render(restored, role === "admin");
		expect(trigger().getAttribute("aria-label")).toContain("credits 0");
		expect(trigger().getAttribute("aria-label")).toContain("Reinstalled plan");
		expect(document.body.textContent).not.toContain("Third-party plan");
		expect(document.body.textContent).not.toContain("credits 42.5");
	}
	expect(old.data?.amounts[0]?.remaining).toBe(42.5);
});

test("account replacement hides an already open old panel before the new snapshot arrives", async () => {
	const old = snapshot();
	await render(old);
	await openPanel();
	const display = customApiQuotaDisplayFor({ providerId: "p", generation: "B", snapshot: old });
	await render(display.quotaSnapshot);
	expect(host.querySelector("button")).toBeNull();
	expect(document.body.textContent).not.toContain("Third-party plan");
});

test("quota expiry updates idle consumers on one clock and releases the last subscription", async () => {
	let tick: (() => void) | undefined;
	const time = spyOn(Date, "now").mockReturnValue(NOW);
	const interval = spyOn(globalThis, "setInterval").mockImplementation((callback) => {
		tick = callback as () => void;
		return 123 as unknown as ReturnType<typeof setInterval>;
	});
	const clear = spyOn(globalThis, "clearInterval").mockImplementation(() => {});
	const data = snapshot();
	if (!data.data) throw new Error("Missing quota fixture");
	data.data.expiresAt = new Date(NOW + 1_000).toISOString();
	function Consumer() {
		const now = useQuotaNow(true);
		const view = buildProviderQuotaView(data, instance.t, false, false, now);
		if (!view) throw new Error("Missing quota view");
		return <span>{formatQuotaBadgeText(view, instance.t)}</span>;
	}
	try {
		await act(async () =>
			root.render(
				<>
					<Consumer key="a" />
					<Consumer key="b" />
				</>,
			),
		);
		expect(interval).toHaveBeenCalledTimes(1);
		expect(host.textContent).not.toContain(instance.t("providerQuota.expired"));
		time.mockReturnValue(NOW + 30_000);
		if (!tick) throw new Error("Quota clock was not subscribed");
		await act(async () => tick?.());
		expect([...host.querySelectorAll("span")].map((span) => span.textContent)).toEqual([
			instance.t("providerQuota.expired"),
			instance.t("providerQuota.expired"),
		]);
		await act(async () => root.render(<Consumer key="a" />));
		expect(clear).not.toHaveBeenCalled();
		await act(async () => root.render(null));
		expect(clear).toHaveBeenCalledTimes(1);
	} finally {
		await act(async () => root.render(null));
		clear.mockRestore();
		interval.mockRestore();
		time.mockRestore();
	}
});
