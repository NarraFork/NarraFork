import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import i18next, { type i18n } from "i18next";
import { parseHTML } from "linkedom";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import type { CodexUsageForecast, PublicCodexQuotaOverview } from "../../lib/api/types";
import settingsLocale from "../../locales/en/settings.json";
import zhSettingsLocale from "../../locales/zh-CN/settings.json";
import { CodexQuotaTrendChart, formatQuotaTrendDuration } from "./CodexQuotaTrendChart";

let root: Root;
let container: HTMLDivElement;
let testI18n: i18n;

function installDom() {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	Object.assign(globalThis, {
		window,
		document: window.document,
		navigator: window.navigator,
		Event: window.Event,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		Text: window.Text,
		getComputedStyle: () => ({ getPropertyValue: () => "" }),
		IS_REACT_ACT_ENVIRONMENT: false,
	});
}

function formatDuration(minutes: number, language = "en"): string {
	const t = testI18n.getFixedT(language, "settings");
	return formatQuotaTrendDuration(minutes * 60_000, (key, values) => t(key, values), 0);
}

async function renderTrend(trend: CodexUsageForecast | PublicCodexQuotaOverview["trend"]) {
	root.render(
		<I18nextProvider i18n={testI18n}>
			<MantineProvider>
				<CodexQuotaTrendChart trend={trend} />
			</MantineProvider>
		</I18nextProvider>,
	);
	await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(async () => {
	installDom();
	testI18n = i18next.createInstance();
	await testI18n.use(initReactI18next).init({
		lng: "en",
		fallbackLng: "en",
		defaultNS: "settings",
		resources: {
			en: { settings: settingsLocale },
			"zh-CN": { settings: zhSettingsLocale },
		},
		interpolation: { escapeValue: false },
		react: { useSuspense: false },
	});
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	root.unmount();
	container.remove();
});

describe("CodexQuotaTrendChart", () => {
	test("formats day-scale durations without changing the surrounding relative-time text", () => {
		expect(formatDuration(29 * 1440 + 22 * 60 + 36)).toBe("in 29d 22h 36m");
		expect(formatDuration(29 * 1440 + 22 * 60 + 36, "zh-CN")).toBe(
			"29 天 22 小时 36 分钟后",
		);
		expect(formatDuration(1440 + 2 * 60 + 3)).toBe("in 1d 2h 3m");
		expect(formatDuration(1440)).toBe("in 1d");
	});

	test("keeps sub-day durations in hours and minutes across minute boundaries", () => {
		expect(formatDuration(23 * 60 + 59)).toBe("in 23h 59m");
		expect(formatDuration(59)).toBe("in 59m");
		expect(formatDuration(60)).toBe("in 1h");
	});

	test("omits entirely missing series but still renders a real zero series", async () => {
		const now = Date.now();
		await renderTrend({
			generatedAt: new Date(now).toISOString(),
			unit: "account_equivalent",
			tiers: ["team", "plus"],
			points: [
				{ timestamp: now - 60_000, byTier: { team: 0 } },
				{ timestamp: now + 60_000, byTier: { team: 0 } },
			],
		});

		expect(container.querySelector('path[data-tier="team"]')).not.toBeNull();
		expect(container.querySelector('path[data-tier="plus"]')).toBeNull();
	});

	test("preserves missing keys from the public overview trend fixture", async () => {
		const now = Date.now();
		await renderTrend({
			generatedAt: new Date(now).toISOString(),
			types: ["team", "plus"],
			points: [
				{ timestamp: now - 60_000, byType: { team: 1.38 } },
				{ timestamp: now, byType: { plus: 1 } },
				{ timestamp: now + 60_000, byType: { team: 2 } },
			],
		});

		expect(container.querySelectorAll('path[data-tier="team"]').length).toBeGreaterThanOrEqual(2);
		expect(container.innerHTML).not.toContain("NaN");
	});

	test("does not coerce a missing middle value to zero and keeps monthly paths finite", async () => {
		const now = Date.now();
		const month = 30 * 24 * 60 * 60 * 1000;
		await renderTrend({
			generatedAt: new Date(now).toISOString(),
			unit: "account_equivalent",
			tiers: ["team"],
			points: [
				{ timestamp: now - 60_000, byTier: { team: 1.38 } },
				{ timestamp: now + month / 2, byTier: {} },
				{ timestamp: now + month, byTier: { team: 2 } },
			],
		});

		const paths = [...container.querySelectorAll('path[data-tier="team"]')];
		expect(paths.length).toBeGreaterThanOrEqual(2);
		for (const path of paths) {
			const d = path.getAttribute("d") ?? "";
			expect(d).not.toContain("NaN");
			expect(d).not.toContain("Infinity");
		}
		expect(container.innerHTML).not.toContain("NaN");
		expect(container.innerHTML).not.toContain("Infinity");
	});
});
