import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import i18next, { type i18n } from "i18next";
import { parseHTML } from "linkedom";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import type { PublicCodexQuotaOverview } from "../../../lib/api/types";
import narratorLocale from "../../../locales/en/narrator.json";
import settingsLocale from "../../../locales/en/settings.json";
import {
	applyPublicCodexQuotaOverviewIfValid,
	CodexQuotaIndicatorContent,
	isPublicCodexQuotaOverview,
} from "./CodexQuotaIndicator";

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

function overview(overrides: Partial<PublicCodexQuotaOverview>): PublicCodexQuotaOverview {
	return {
		generatedAt: "2026-04-01T00:00:00.000Z",
		unit: "account_equivalent",
		totalRemainingAccountEquivalents: 0,
		totalAccountEquivalents: 0,
		trackedAccountCount: 2,
		modeledAccountCount: 0,
		unmodeledAccountCount: 2,
		segments: [],
		trend: { generatedAt: "2026-04-01T00:00:00.000Z", points: [], types: [] },
		nextResetAt: null,
		usageQueueRunning: false,
		schedulerStarted: true,
		...overrides,
	};
}

async function renderContent(value: PublicCodexQuotaOverview) {
	root.render(
		<I18nextProvider i18n={testI18n}>
			<MantineProvider>
				<CodexQuotaIndicatorContent overview={value} compact={false} />
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
		defaultNS: "narrator",
		ns: ["narrator", "settings"],
		resources: { en: { narrator: narratorLocale, settings: settingsLocale } },
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

describe("CodexQuotaIndicatorContent", () => {
	test("shows unknown quota instead of 0 / N when every account is unmodeled", async () => {
		await renderContent(overview({}));
		expect(container.textContent).toContain("Quota unknown (2 accounts)");
		expect(container.textContent).not.toContain("0 / 2");
		expect(container.textContent).toContain("Reset unknown");
		expect(container.textContent).not.toContain("No non-zero usage reset scheduled");
		expect(container.querySelector('[data-coverage="unknown"]')).not.toBeNull();
	});

	test("shows modeled quota and unknown coverage separately for mixed data", async () => {
		await renderContent(
			overview({
				totalRemainingAccountEquivalents: 1.38,
				totalAccountEquivalents: 99,
				trackedAccountCount: 3,
				modeledAccountCount: 2,
				unmodeledAccountCount: 1,
				segments: [
					{
						type: "team",
						remainingAccountEquivalents: 1.38,
						totalAccountEquivalents: 99,
						averageRemainingPercent: 69,
						nextResetAt: null,
						trackedAccountCount: 3,
						modeledAccountCount: 2,
						unmodeledAccountCount: 1,
					},
				],
			}),
		);
		expect(container.textContent).toContain("1.38 / 2");
		expect(container.textContent).toContain("1 account unknown");
		const mixedBars = container.querySelectorAll('[data-coverage="mixed"]');
		const mixedBar = mixedBars[mixedBars.length - 1];
		expect(mixedBar).not.toBeNull();
		expect((mixedBar?.firstElementChild as HTMLElement | null)?.style.height).toBe("69%");
	});

	test("keeps old known overview payloads modeled", async () => {
		const legacy = overview({
			totalRemainingAccountEquivalents: 1.38,
			totalAccountEquivalents: 2,
			segments: [
				{
					type: "team",
					remainingAccountEquivalents: 1.38,
					totalAccountEquivalents: 2,
					averageRemainingPercent: 69,
					nextResetAt: null,
				},
			],
		});
		delete legacy.trackedAccountCount;
		delete legacy.modeledAccountCount;
		delete legacy.unmodeledAccountCount;

		await renderContent(legacy);
		expect(container.textContent).toContain("1.38 / 2");
		expect(container.textContent).toContain("No non-zero usage reset scheduled");
		expect(container.textContent).not.toContain("Quota unknown");
		const modeledBars = container.querySelectorAll('[data-coverage="modeled"]');
		const modeledBar = modeledBars[modeledBars.length - 1];
		expect((modeledBar?.firstElementChild as HTMLElement | null)?.style.height).toBe("69%");
	});

	test("keeps an old empty zero-account overview numeric", async () => {
		const legacy = overview({ segments: [] });
		delete legacy.trackedAccountCount;
		delete legacy.modeledAccountCount;
		delete legacy.unmodeledAccountCount;

		await renderContent(legacy);
		expect(container.textContent).toContain("0 / 0");
		expect(container.textContent).not.toContain("Quota unknown");
	});

	test("keeps old monthly null overview payloads conservative", async () => {
		const legacy = overview({
			totalRemainingAccountEquivalents: 0,
			totalAccountEquivalents: 2,
			segments: [
				{
					type: "team",
					remainingAccountEquivalents: 0,
					totalAccountEquivalents: 2,
					averageRemainingPercent: null,
					nextResetAt: null,
				},
			],
		});
		delete legacy.trackedAccountCount;
		delete legacy.modeledAccountCount;
		delete legacy.unmodeledAccountCount;

		await renderContent(legacy);
		expect(container.textContent).toContain("Quota unknown");
		expect(container.textContent).toContain("Reset unknown");
		expect(container.textContent).not.toContain("0 / 2");
		expect(container.querySelector('[data-coverage="unknown"]')).not.toBeNull();
	});
});

describe("isPublicCodexQuotaOverview", () => {
	test("accepts an old overview payload without additive coverage fields", () => {
		const legacy = overview({});
		delete legacy.trackedAccountCount;
		delete legacy.modeledAccountCount;
		delete legacy.unmodeledAccountCount;
		expect(isPublicCodexQuotaOverview(legacy)).toBe(true);
	});

	test("accepts a public trend fixture with missing tier keys", () => {
		const fixture = overview({
			totalRemainingAccountEquivalents: 1.38,
			totalAccountEquivalents: 2,
			modeledAccountCount: 2,
			unmodeledAccountCount: 0,
			trend: {
				generatedAt: "2026-04-01T00:00:00.000Z",
				types: ["team", "plus"],
				points: [
					{ timestamp: 1_800_000_000_000, byType: { team: 1.38 } },
					{ timestamp: 1_802_592_000_000, byType: { plus: 1 } },
				],
			},
		});
		expect(isPublicCodexQuotaOverview(fixture)).toBe(true);
	});

	test("does not apply an invalid websocket payload to the query cache", () => {
		const applied: PublicCodexQuotaOverview[] = [];
		const invalid = { ...overview({}), segments: null };
		expect(applyPublicCodexQuotaOverviewIfValid(invalid, (value) => applied.push(value))).toBe(
			false,
		);
		expect(applied).toHaveLength(0);

		const valid = overview({});
		expect(applyPublicCodexQuotaOverviewIfValid(valid, (value) => applied.push(value))).toBe(true);
		expect(applied).toEqual([valid]);
	});

	test("rejects malformed arrays, trend values, and negative coverage", () => {
		const valid = overview({});
		for (const invalid of [
			{ ...valid, segments: null },
			{ ...valid, trend: { ...valid.trend, points: {} } },
			{
				...valid,
				trend: {
					...valid.trend,
					points: [{ timestamp: 1, byType: { team: Number.NaN } }],
				},
			},
			{ ...valid, modeledAccountCount: -1 },
			{ ...valid, totalRemainingAccountEquivalents: Number.POSITIVE_INFINITY },
		]) {
			expect(isPublicCodexQuotaOverview(invalid)).toBe(false);
		}
	});
});
