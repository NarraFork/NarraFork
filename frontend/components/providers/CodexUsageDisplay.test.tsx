import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import i18next, { type i18n } from "i18next";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import type { CodexUsageData } from "../../lib/api/types";
import settingsLocale from "../../locales/en/settings.json";
import { CodexUsageDisplay } from "./CodexUsageDisplay";

let root: Root;
let container: HTMLDivElement;
let testI18n: i18n;

function installDom() {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	const matchMedia = (query: string) => ({
		matches: false,
		media: query,
		onchange: null,
		addListener() {},
		removeListener() {},
		addEventListener() {},
		removeEventListener() {},
		dispatchEvent: () => false,
	});
	Object.assign(globalThis, {
		window,
		document: window.document,
		navigator: window.navigator,
		Event: window.Event,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		Text: window.Text,
		matchMedia,
		getComputedStyle: () => ({ getPropertyValue: () => "" }),
		// Mantine Tooltip transitions drive animation frames; the fake DOM has none.
		requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
		cancelAnimationFrame: (id: number) => clearTimeout(id),
		IS_REACT_ACT_ENVIRONMENT: true,
	});
}

async function renderUsage(usage?: CodexUsageData) {
	await act(async () => {
		root.render(
			<I18nextProvider i18n={testI18n}>
				<MantineProvider>
					<CodexUsageDisplay usage={usage} />
				</MantineProvider>
			</I18nextProvider>,
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

function usage(overrides: Partial<CodexUsageData> = {}): CodexUsageData {
	return {
		plan_type: "team",
		queriedAt: "2026-04-01T00:00:00.000Z",
		...overrides,
	};
}

beforeEach(async () => {
	installDom();
	testI18n = i18next.createInstance();
	await testI18n.use(initReactI18next).init({
		lng: "en",
		fallbackLng: "en",
		defaultNS: "settings",
		resources: { en: { settings: settingsLocale } },
		interpolation: { escapeValue: false },
		react: { useSuspense: false },
	});
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
});

describe("CodexUsageDisplay", () => {
	test("renders monthly and unknown windows with their real percentages", async () => {
		await renderUsage(
			usage({
				primary_window: {
					used_percent: 45,
					remaining_percent: 55,
					reset_at: 1_900_000_000,
					reset_after_seconds: 2_600_000,
					limit_window_seconds: 2_592_000,
					window_type: "monthly",
				},
				secondary_window: {
					used_percent: 58,
					remaining_percent: 42,
					reset_at: 1_900_000_100,
					reset_after_seconds: 100,
					window_type: "unknown",
				},
			}),
		);

		expect(container.textContent).toContain("Monthly Window");
		expect(container.textContent).toContain("Unknown Window");
		expect(container.textContent).toContain("55.0%");
		expect(container.textContent).toContain("42.0%");
		const progressbars = [...container.querySelectorAll('[role="progressbar"]')];
		expect(progressbars).toHaveLength(2);
		expect(progressbars[0]?.getAttribute("aria-label")).toContain("Monthly Window");
		expect(progressbars[0]?.getAttribute("aria-label")).toContain("45.0%");
		expect(progressbars[0]?.getAttribute("aria-label")).toContain("55.0%");
	});

	test("distinguishes no window data from a real zero remaining value", async () => {
		await renderUsage(usage());
		expect(container.textContent).toContain("No quota window data");
		expect(container.querySelector('[role="progressbar"]')).toBeNull();

		await renderUsage(
			usage({
				primary_window: {
					used_percent: 100,
					remaining_percent: 0,
					reset_at: 1_900_000_000,
					reset_after_seconds: 100,
					window_type: "monthly",
				},
			}),
		);
		expect(container.textContent).toContain("Remaining: 0.0%");
		expect(container.querySelector('[role="progressbar"]')).not.toBeNull();
	});

	test("does not draw a zero progress bar for invalid or null percentages", async () => {
		await renderUsage(
			usage({
				primary_window: {
					used_percent: Number.NaN,
					remaining_percent: 80,
					reset_at: 1_900_000_000,
					reset_after_seconds: 100,
					window_type: "monthly",
				},
				secondary_window: {
					used_percent: 20,
					remaining_percent: null as unknown as number,
					reset_at: 1_900_000_100,
					reset_after_seconds: 100,
					window_type: "unknown",
				},
			}),
		);
		expect(container.querySelector('[role="progressbar"]')).toBeNull();
		expect(container.textContent).toContain("Remaining: -");
	});

	test("renders an invalid reset as unknown instead of Invalid Date", async () => {
		await renderUsage(
			usage({
				primary_window: {
					used_percent: 20,
					remaining_percent: 80,
					reset_at: Number.NaN,
					reset_after_seconds: 100,
					window_type: "unknown",
				},
			}),
		);
		expect(container.textContent).toContain("Reset unknown");
		expect(container.textContent).not.toContain("Invalid Date");
	});

	test("renders the reset credits count when reported, including zero", async () => {
		await renderUsage(usage({ reset_credits_available: 3 }));
		expect(container.textContent).toContain("Reset credits 3");

		await renderUsage(usage({ reset_credits_available: 0 }));
		expect(container.textContent).toContain("Reset credits 0");

		await renderUsage(usage());
		expect(container.textContent).not.toContain("Reset credits");
	});

	test("renders the spendable credits balance verbatim when reported", async () => {
		await renderUsage(
			usage({
				credits: { has_credits: true, unlimited: false, balance: "123.456789012345678" },
			}),
		);
		expect(container.textContent).toContain("Credits: 123.456789012345678");

		await renderUsage(usage());
		expect(container.textContent).not.toContain("Credits:");
	});

	test("renders unlimited and zero credits states", async () => {
		await renderUsage(usage({ credits: { has_credits: true, unlimited: true, balance: null } }));
		expect(container.textContent).toContain("Credits: Unlimited");

		await renderUsage(usage({ credits: { has_credits: false, unlimited: false, balance: null } }));
		expect(container.textContent).toContain("Credits: 0");
	});
});
