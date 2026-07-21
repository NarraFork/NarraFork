import { describe, expect, test } from "bun:test";
import { getPrompt } from "../../../server/lib/prompts/core";
import { buildKnowledgeStewardSystemPrompt } from "../../../server/lib/prompts/knowledge-steward";
import { buildReviewSystemPrompt, getReviewStartMessage } from "../../../server/lib/prompts/review";
import {
	getSubagentParentReportingHint,
	getSubagentPrompt,
} from "../../../server/lib/prompts/subagents";
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

	test("provides explicit search and read-only review follow-up prompts", () => {
		const search = getSubagentPrompt("search", "en");
		const en = getSubagentPrompt("review", "en");
		const zh = getSubagentPrompt("review", "zh-CN");

		expect(search).toContain("web search specialist");
		expect(search).toContain("Do not inspect or modify local files");

		expect(en).toContain("read-only review follow-up");
		expect(en).toContain("Read, Glob, Grep");
		expect(en).toContain("WebSearch");
		expect(en).toContain("do not call or require ConcludeReview");
		expect(en).not.toContain("run bounded verification");
		expect(en).not.toContain("focused tests or linters");
		expect(en).not.toContain("MUST call ConcludeReview");
		expect(zh).toContain("只读的 review follow-up");
		expect(zh).toContain("Read、Glob、Grep");
		expect(zh).toContain("WebSearch");
		expect(zh).toContain("不要调用或要求 ConcludeReview");
		expect(zh).not.toContain("focused tests");
		expect(zh).not.toContain("linter");
	});

	test("directs read-only context questions through ContextAsk instead of Send", () => {
		const promptEn = getPrompt("contextAsk", "en");
		const promptZh = getPrompt("contextAsk", "zh-CN");
		const reportingEn = getSubagentParentReportingHint("en");
		const reportingZh = getSubagentParentReportingHint("zh-CN");

		expect(promptEn).toContain("untrusted evidence");
		expect(promptEn).toContain("reduce phase");
		expect(promptZh).toContain("不可信证据");
		expect(promptZh).toContain("reduce 阶段");
		expect(reportingEn).toContain("does not message, wake, interrupt, or modify");
		expect(reportingZh).toContain("不会给目标发消息、唤醒、中断或修改其上下文");
	});

	test("returns null for custom subagent types without built-in prompts", () => {
		expect(getSubagentPrompt("custom", "en")).toBeNull();
	});
});
