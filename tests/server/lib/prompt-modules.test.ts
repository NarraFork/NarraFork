import { describe, expect, test } from "bun:test";
import { getPrompt } from "../../../server/lib/prompts/core";
import { buildKnowledgeStewardSystemPrompt } from "../../../server/lib/prompts/knowledge-steward";
import { buildReviewSystemPrompt, getReviewStartMessage } from "../../../server/lib/prompts/review";
import { getSubagentPrompt } from "../../../server/lib/prompts/subagents";
import {
	getDynamicSpecSystemReminder,
	getPlanModeSystemReminder,
} from "../../../server/lib/prompts/system-reminders";
import type { Locale } from "../../../shared/i18n-locales";

const futureLocale = "ja" as Locale;

describe("model prompt modules", () => {
	test("fall back to the canonical English prompt for untranslated locales", () => {
		expect(getPrompt("title", futureLocale)).toBe(getPrompt("title", "en"));
		expect(getSubagentPrompt("explore", futureLocale)).toBe(getSubagentPrompt("explore", "en"));
		expect(getReviewStartMessage(futureLocale)).toBe(getReviewStartMessage("en"));
		expect(buildKnowledgeStewardSystemPrompt(futureLocale)).toBe(
			buildKnowledgeStewardSystemPrompt("en"),
		);
		expect(getDynamicSpecSystemReminder(futureLocale)).toBe(getDynamicSpecSystemReminder("en"));
	});

	test("preserves dynamic prompt interpolation", () => {
		expect(buildReviewSystemPrompt("example diff", "en")).toContain("example diff");
		expect(getPlanModeSystemReminder("en", "abc123", false)).toContain(".narrafork/plan-abc123.md");
	});

	test("returns null for custom subagent types without built-in prompts", () => {
		expect(getSubagentPrompt("custom", "en")).toBeNull();
	});
});
