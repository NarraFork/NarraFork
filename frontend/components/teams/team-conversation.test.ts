/**
 * Team mode of the coordinator conversation, the page side: which events make dividers and how
 * they read (both locales), the `since` bound that pages them with the messages, the chip
 * wording, and that only the team page turns the mode on.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { TeamActivityEvent } from "@shared/project-teams";
import { createInstance } from "i18next";
import en from "../../locales/en/projects.json";
import zh from "../../locales/zh-CN/projects.json";
import {
	chipLabels,
	conversationEvents,
	conversationSince,
	dividerOf,
	dividerTime,
	eventsRevision,
	serverTimeMs,
} from "./team-conversation";

async function tFor(lng: "en" | "zh-CN") {
	const i18n = createInstance();
	await i18n.init({
		lng,
		resources: { en: { projects: en }, "zh-CN": { projects: zh } },
		defaultNS: "projects",
		interpolation: { escapeValue: false },
	});
	return i18n.t.bind(i18n) as (key: string, values?: Record<string, unknown>) => string;
}

function event(
	id: string,
	kind: string,
	createdAt: string,
	detail: Record<string, unknown> | null = null,
	title: string | null = "修复导出 CSV 时区错误",
): TeamActivityEvent {
	return {
		id,
		kind,
		workItemId: "w1",
		workItemTitle: title,
		actorKind: "agent",
		actorId: null,
		actorName: null,
		detail,
		detailOmitted: false,
		createdAt,
	};
}

const local = (h: number, m: number, day = 27) => new Date(2026, 10, day, h, m).getTime();
const NOW = local(12, 0);

describe("dividers", () => {
	test("a small set of kinds makes a divider; the rest make none", () => {
		expect(dividerOf(event("1", "work.review", "", { verdict: "clear" }))?.key).toBe("reviewClear");
		expect(dividerOf(event("1", "work.review", "", { verdict: "blocker" }))?.tone).toBe("warn");
		expect(dividerOf(event("1", "work.review", "", null))).toBeNull();
		expect(dividerOf(event("1", "work.returned", ""))?.key).toBe("returned");
		expect(dividerOf(event("1", "work.merged", "", { detectedBy: "local_merge" }))?.key).toBe(
			"merged",
		);
		expect(dividerOf(event("1", "work.merged", "", { detectedBy: "pull_request", pr: 7 }))).toEqual(
			{
				key: "mergedPr",
				values: { pr: 7 },
				tone: "ok",
			},
		);
		expect(dividerOf(event("1", "work.pr_opened", "", { pr: 7 }))?.key).toBe("prOpened");
		expect(dividerOf(event("1", "work.pr_opened", "", {}))).toBeNull();
		expect(dividerOf(event("1", "work.merge_failed", ""))?.tone).toBe("warn");
		for (const kind of ["work.created", "work.started", "team.brief", "work.sync", "unknown"])
			expect(dividerOf(event("1", kind, "", {}))).toBeNull();
	});

	test("worded in both locales, with the local time, ascending by time then id", async () => {
		const at = new Date(local(10, 31)).toISOString();
		const events = [
			event("b", "work.merged", at, {}),
			event("c", "work.created", at, {}),
			event("a", "work.review", at, { verdict: "clear" }),
			event("z", "work.returned", new Date(local(9, 5)).toISOString(), { round: 2 }, null),
			event("a", "work.review", at, { verdict: "clear" }),
		];
		const zhT = await tFor("zh-CN");
		expect(conversationEvents(events, zhT, NOW).map((divider) => divider.text)).toEqual([
			"09:05 · 「一个工作项」被退回",
			"10:31 · 「修复导出 CSV 时区错误」评审通过",
			"10:31 · 「修复导出 CSV 时区错误」已合并",
		]);
		const enT = await tFor("en");
		expect(conversationEvents(events, enT, NOW)[1]?.text).toBe(
			"10:31 · 「修复导出 CSV 时区错误」 passed review",
		);
	});

	test("another day carries its date", () => {
		expect(dividerTime(local(10, 31), NOW)).toBe("10:31");
		expect(dividerTime(local(23, 59, 26), NOW)).toBe("11-26 23:59");
	});

	test("events page with the messages: `since` only while older history exists", () => {
		expect(conversationSince(null)).toBeUndefined();
		expect(
			conversationSince({ oldestAt: "2026-11-27T10:00:00.000Z", hasPrev: false }),
		).toBeUndefined();
		expect(conversationSince({ oldestAt: "2026-11-27 10:00:00", hasPrev: true })).toBe(
			"2026-11-27T10:00:00.000Z",
		);
		expect(conversationSince({ oldestAt: null, hasPrev: true })).toBeUndefined();
		expect(serverTimeMs("nonsense")).toBeNaN();
	});

	test("the revision moves with the dividers and the language", async () => {
		const t = await tFor("zh-CN");
		const one = conversationEvents([event("a", "work.merged", "2026-11-27T02:00:00Z", {})], t, NOW);
		const two = conversationEvents(
			[
				event("a", "work.merged", "2026-11-27T02:00:00Z", {}),
				event("b", "work.returned", "2026-11-27T03:00:00Z"),
			],
			t,
			NOW,
		);
		expect(eventsRevision(one, "zh-CN")).not.toBe(eventsRevision(two, "zh-CN"));
		expect(eventsRevision(one, "zh-CN")).not.toBe(eventsRevision(one, "en"));
		expect(eventsRevision(one, "zh-CN")).toBe(eventsRevision([...one], "zh-CN"));
	});
});

describe("chip wording", () => {
	test("every Team action has its own label in both locales", async () => {
		for (const lng of ["en", "zh-CN"] as const) {
			const labels = chipLabels(await tFor(lng));
			for (const [action, label] of Object.entries(labels.actions)) {
				expect(label).not.toContain("teams.conversation");
				expect(label.length).toBeGreaterThan(0);
				expect(action).not.toContain("_");
			}
			expect(labels.other).not.toContain("teams.conversation");
		}
		const zhLabels = chipLabels(await tFor("zh-CN"));
		expect(zhLabels.actions["work.create"]).toBe("创建工作项");
		expect(zhLabels.count(7)).toBe("×7");
		expect(zhLabels.failed(1)).toBe("1 次失败");
		expect(chipLabels(await tFor("en")).failed(2)).toBe("2 failed");
	});
});

describe("only the team page turns team mode on", () => {
	test("the context is provided by the team route alone; the session page never sees it", () => {
		const root = join(import.meta.dir, "..", "..");
		const providers: string[] = [];
		const walk = (dir: string) => {
			for (const name of readdirSync(dir)) {
				if (name === "node_modules" || name === "routeTree.gen.ts") continue;
				const path = join(dir, name);
				if (statSync(path).isDirectory()) walk(path);
				else if (/\.tsx?$/.test(name) && !/\.test\.|browser-fixture/.test(name)) {
					if (readFileSync(path, "utf8").includes("TeamConversationModeContext.Provider"))
						providers.push(relative(root, path));
				}
			}
		};
		walk(root);
		expect(providers).toEqual(["routes/projects/$projectId_.teams.$teamId.tsx"]);
	});
});
