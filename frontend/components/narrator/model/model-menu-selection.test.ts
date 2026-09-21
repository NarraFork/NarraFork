import { describe, expect, test } from "bun:test";
import {
	buildAggModelValue,
	FOLLOW_DEFAULT_MODEL,
	FOLLOW_SUMMARY_MODEL,
	type ModelAggregation,
} from "../../../lib/constants";
import {
	canAssignGlobalModelRole,
	centerModelMenuSelection,
	modelMenuSelection,
} from "./model-menu-selection";

const aggregations: ModelAggregation[] = [
	{ id: "group", name: "Group", models: ["a:model", "b:model:variant"], routingMode: "priority" },
];

describe("model menu selection", () => {
	test.each([
		null,
		undefined,
		"",
		FOLLOW_DEFAULT_MODEL,
	])("normalizes default selection %s", (value) => {
		expect(modelMenuSelection(value, aggregations).targetValue).toBe(FOLLOW_DEFAULT_MODEL);
	});
	test("keeps ordinary and summary model values", () => {
		for (const value of ["a:model", "__summary__", "removed:model"]) {
			expect(modelMenuSelection(value, aggregations).targetValue).toBe(value);
		}
	});
	test("resolves automatic aggregation and exposes members", () => {
		const selection = modelMenuSelection(buildAggModelValue("group"), aggregations);
		expect(selection.targetValue).toBe("__agg__:group");
		expect(selection.members).toEqual(aggregations[0].models);
	});
	test("preserves pinned member including embedded colons", () => {
		const value = buildAggModelValue("group", "b:model:variant");
		expect(modelMenuSelection(value, aggregations).targetValue).toBe(value);
	});
	test("falls back to aggregation for missing members or configuration", () => {
		expect(modelMenuSelection("__agg__:group:missing:model", aggregations).targetValue).toBe(
			"__agg__:group",
		);
		expect(modelMenuSelection("__agg__:group:a:model", []).targetValue).toBe("__agg__:group");
	});
});

describe("global model role assignment", () => {
	test("rejects empty values and meta sentinels", () => {
		expect(canAssignGlobalModelRole(null)).toBe(false);
		expect(canAssignGlobalModelRole(undefined)).toBe(false);
		expect(canAssignGlobalModelRole("")).toBe(false);
		expect(canAssignGlobalModelRole(FOLLOW_DEFAULT_MODEL)).toBe(false);
		expect(canAssignGlobalModelRole(FOLLOW_SUMMARY_MODEL)).toBe(false);
	});
	test("allows concrete models and aggregation roots", () => {
		expect(canAssignGlobalModelRole("xiaomi:mimo-x-pro-preview")).toBe(true);
		expect(canAssignGlobalModelRole(buildAggModelValue("group"))).toBe(true);
	});
});

describe("dropdown-only centering", () => {
	function center(rowTop: number, scrollTop = 0, scrollHeight = 2000) {
		const container = {
			scrollTop,
			scrollHeight,
			clientHeight: 400,
			clientTop: 1,
			getBoundingClientRect: () => ({ top: 100 }),
		} as HTMLElement;
		const item = { getBoundingClientRect: () => ({ top: rowTop, height: 32 }) } as HTMLElement;
		centerModelMenuSelection(container, item, 48);
		return container.scrollTop;
	}
	test("centers in viewport above sticky search footer", () => {
		expect(center(1000)).toBe(739);
		expect(center(700, 300)).toBe(739);
	});
	test("clamps to both scroll boundaries and handles short lists", () => {
		expect(center(101)).toBe(0);
		expect(center(3000)).toBe(1600);
		expect(center(200, 0, 200)).toBe(0);
	});
});

test("both statusbar variants wire aggregation controls inside the model dropdown", async () => {
	// The model dropdown lives in the interaction status bar (both desktop and
	// mobile variants), not NarratorPanel.
	const statusBar = await Bun.file(
		new URL("../interaction/NarratorInteractionStatusBar.tsx", import.meta.url),
	).text();
	expect(statusBar).not.toContain("AggProviderSwitcher");
	expect(statusBar.match(/data-model-menu-scroll/g)).toHaveLength(2);
	expect(
		statusBar.match(
			/<ModelMenuItems\s+opened=\{menuOpen(?:Desktop|Mobile)\}\s+aggregations=\{model\.aggregations\}/g,
		),
	).toHaveLength(2);
});
