import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import i18next, { type i18n } from "i18next";
import { parseHTML } from "linkedom";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import type {
	CodexUsageForecast,
	CodexUsageSchedulerSnapshot,
	CodexUsageSummary,
	CodexUsageTierStats,
} from "../../lib/api/types";
import settingsLocale from "../../locales/en/settings.json";
import { CodexQuotaOverview } from "./CodexQuotaOverview";

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
		IS_REACT_ACT_ENVIRONMENT: false,
	});
}

const scheduler: CodexUsageSchedulerSnapshot = {
	scheduledCredentialCount: 0,
	dueCredentialCount: 0,
	started: true,
};
const trend: CodexUsageForecast = {
	generatedAt: "2026-04-01T00:00:00.000Z",
	unit: "account_equivalent",
	tiers: ["team"],
	points: [],
};

function teamStats(overrides: Partial<CodexUsageTierStats>): CodexUsageTierStats {
	return {
		tier: "team",
		accountCount: 2,
		knownUsageCount: 2,
		zeroUsageCount: 0,
		scheduledAccountCount: 2,
		remainingAccountEquivalents: 1.38,
		averageRemainingPercent: 69,
		...overrides,
	};
}

function summary(stats: CodexUsageTierStats): CodexUsageSummary {
	return {
		generatedAt: "2026-04-01T00:00:00.000Z",
		totalTrackedAccounts: stats.accountCount,
		totalKnownUsageAccounts: stats.knownUsageCount,
		missingUsageAccounts: 0,
		zeroUsageAccounts: stats.zeroUsageCount,
		scheduledAccountCount: stats.scheduledAccountCount,
		totalModeledUsageAccounts: stats.modeledUsageCount,
		totalUnmodeledUsageAccounts: stats.unmodeledUsageCount,
		byTier: {
			free: teamStats({ tier: "free", accountCount: 0, knownUsageCount: 0 }),
			plus: teamStats({ tier: "plus", accountCount: 0, knownUsageCount: 0 }),
			team: stats,
			k12: teamStats({ tier: "k12", accountCount: 0, knownUsageCount: 0 }),
			prolite: teamStats({ tier: "prolite", accountCount: 0, knownUsageCount: 0 }),
			pro: teamStats({ tier: "pro", accountCount: 0, knownUsageCount: 0 }),
			other: teamStats({ tier: "other", accountCount: 0, knownUsageCount: 0 }),
		},
	};
}

function getTierCard(tier: string): HTMLElement {
	const card = container.querySelector(`[data-codex-tier="${tier}"]`);
	if (!(card instanceof HTMLElement)) throw new Error(`Missing Codex tier card: ${tier}`);
	return card;
}

async function renderOverview(stats: CodexUsageTierStats) {
	root.render(
		<I18nextProvider i18n={testI18n}>
			<MantineProvider>
				<CodexQuotaOverview
					summary={summary(stats)}
					trend={trend}
					scheduler={scheduler}
					tierOrder={["team"]}
				/>
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
		resources: { en: { settings: settingsLocale } },
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

describe("CodexQuotaOverview", () => {
	test("shows unknown average without drawing a false zero progress bar", async () => {
		await renderOverview(
			teamStats({
				remainingAccountEquivalents: 0,
				averageRemainingPercent: null,
				modeledUsageCount: 0,
				unmodeledUsageCount: 2,
			}),
		);
		const teamCard = getTierCard("team");
		expect(teamCard.textContent).toContain("Quota amount unknown");
		expect(teamCard.textContent).not.toContain("0 accounts eq.");
		expect(teamCard.textContent).toContain("Average remaining unknown");
		expect(teamCard.textContent).toContain("2 unmodeled accounts");
		expect(teamCard.textContent).toContain("Reset unknown");
		expect(teamCard.textContent).not.toContain("No non-zero usage reset scheduled");
		expect(teamCard.querySelector('[aria-label^="Team average remaining"]')).toBeNull();
	});

	test("keeps old known tier stats without coverage modeled", async () => {
		await renderOverview(
			teamStats({
				remainingAccountEquivalents: 1.38,
				averageRemainingPercent: 69,
				modeledUsageCount: undefined,
				unmodeledUsageCount: undefined,
			}),
		);
		expect(container.textContent).toContain("1.38 accounts eq.");
		expect(container.textContent).toContain("Avg remaining: 69.0%");
		expect(container.textContent).toContain("No non-zero usage reset scheduled");
		expect(container.textContent).not.toContain("Quota amount unknown");
		expect(container.querySelector('[aria-label^="Team average remaining"]')).not.toBeNull();
	});

	test("keeps old monthly null tier stats conservative", async () => {
		await renderOverview(
			teamStats({
				remainingAccountEquivalents: 0,
				averageRemainingPercent: null,
				modeledUsageCount: undefined,
				unmodeledUsageCount: undefined,
			}),
		);
		expect(container.textContent).toContain("Quota amount unknown");
		expect(container.textContent).toContain("Average remaining unknown");
		expect(container.textContent).toContain("Reset unknown");
		expect(container.textContent).not.toContain("0 accounts eq.");
		expect(container.querySelector('[aria-label^="Team average remaining"]')).toBeNull();
	});

	test("keeps a real zero as exhausted quota", async () => {
		await renderOverview(
			teamStats({
				remainingAccountEquivalents: 0,
				averageRemainingPercent: 0,
				modeledUsageCount: 2,
				unmodeledUsageCount: 0,
			}),
		);
		expect(container.textContent).toContain("Avg remaining: 0.0%");
		expect(container.querySelector('[aria-label^="Team average remaining"]')).not.toBeNull();
	});

	test("only preselects tiers that actually have accounts", async () => {
		await renderOverview(teamStats({}));
		// Every other tier in the fixture has accountCount 0, so a default of "all
		// tiers checked" would fill the grid with cards saying nothing but unknown.
		expect(getTierCard("team")).toBeDefined();
		for (const tier of ["free", "plus", "k12", "prolite", "pro"]) {
			expect(container.querySelector(`[data-codex-tier="${tier}"]`)).toBeNull();
		}
	});

	test("explains the empty grid when no tier has accounts", async () => {
		await renderOverview(teamStats({ accountCount: 0, knownUsageCount: 0 }));
		expect(container.querySelector("[data-codex-tier]")).toBeNull();
		expect(container.textContent).toContain("No accounts yet");
		expect(container.textContent).not.toContain("Select at least one tier");
	});

	test("shows modeled values and separate unknown coverage for mixed data", async () => {
		await renderOverview(
			teamStats({
				accountCount: 3,
				modeledUsageCount: 2,
				unmodeledUsageCount: 1,
			}),
		);
		expect(container.textContent).toContain("1.38");
		expect(container.textContent).toContain("Avg remaining: 69.0%");
		expect(container.textContent).toContain("2 modeled");
		expect(container.textContent).toContain("1 unmodeled account");
	});
});
