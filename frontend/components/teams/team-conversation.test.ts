/**
 * Team mode of the coordinator conversation, the page side: which events make dividers and how
 * they read (both locales), the `since` bound that pages them with the messages, the chip
 * wording, and that only the team page turns the mode on.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { getSummary } from "@frontend/components/narrator/tool-call/tool-display";
import type { TeamActivityEvent } from "@shared/project-teams";
import {
	TEAM_TOOL_ACTION_EVENT_LABEL,
	TEAM_TOOL_ACTION_KEYS,
	teamToolLabelKey,
} from "@shared/team-tool-actions";
import { createInstance } from "i18next";
import enNarrator from "../../locales/en/narrator.json";
import en from "../../locales/en/projects.json";
import zhNarrator from "../../locales/zh-CN/narrator.json";
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
		resources: {
			en: { projects: en, narrator: enNarrator },
			"zh-CN": { projects: zh, narrator: zhNarrator },
		},
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
		expect(dividerOf(event("1", "work.pr_opened", "", { pr: 7, reopened: true }))?.key).toBe(
			"prReopened",
		);
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
		expect(zhLabels.actions["work.create"]).toBe("建立工作项");
		expect(zhLabels.actions["work.ready"]).toBe("标记为可合并");
		expect(zhLabels.actions["work.sync"]).toBe("同步基线");
		expect(zhLabels.actions.checkin).toBe("自检");
		expect(zhLabels.actions.decision).toBe("替人拍板");
		expect(zhLabels.actions.cleanup).toBe("清理 worktree");
		expect(zhLabels.cancelled(1)).toBe("1 次取消");
		expect(zhLabels.count(7)).toBe("×7");
		expect(zhLabels.failed(1)).toBe("1 次失败");
		expect(chipLabels(await tFor("en")).failed(2)).toBe("2 failed");
	});
});

describe("one wording per Team action", () => {
	test("the chip and summary table equals the activity feed's event labels, in both locales", () => {
		for (const [narrator, projects] of [
			[enNarrator, en],
			[zhNarrator, zh],
		] as const) {
			const table = (narrator as { teamTool: Record<string, string> }).teamTool;
			const events = (projects as { teams: { event: Record<string, string> } }).teams.event;
			for (const action of TEAM_TOOL_ACTION_KEYS) {
				const label = table[teamToolLabelKey(action)];
				expect(label?.length ?? 0).toBeGreaterThan(0);
				const eventLabel = TEAM_TOOL_ACTION_EVENT_LABEL[action];
				if (eventLabel) expect({ action, label }).toEqual({ action, label: events[eventLabel] });
			}
		}
	});

	test("the English PR dividers read naturally, and a reopened PR says so", async () => {
		const t = await tFor("en");
		const at = new Date(NOW).toISOString();
		const lines = conversationEvents(
			[
				event("a", "work.pr_opened", at, { pr: 7 }, "Fix CSV"),
				event("b", "work.pr_opened", at, { pr: 7, reopened: true }, "Fix CSV"),
			],
			t,
			NOW,
		).map((divider) => divider.text.slice(divider.text.indexOf("·") + 2));
		expect(lines).toEqual(["PR #7 opened for 「Fix CSV」", "PR #7 reopened for 「Fix CSV」"]);
	});
});

describe("Team call summaries (tool cards and trace rows on every page)", () => {
	const labels = (narrator: { teamTool: Record<string, string> }) => {
		const out: Record<string, string> = {};
		for (const [key, value] of Object.entries(narrator.teamTool))
			out[`teamTool_${key}`] = value.replace("{{count}}", "{count}");
		return out;
	};
	const zhLabels = labels(zhNarrator as never);

	test("names the action and what it is about, never `Team · Team`", () => {
		expect(
			getSummary("Team", { action: "work.create", title: "修复导出" }, undefined, zhLabels),
		).toBe("建立工作项 · 修复导出");
		expect(getSummary("Team", { action: "work.ready", item: "w-1" }, undefined, zhLabels)).toBe(
			"标记为可合并 · w-1",
		);
		expect(
			getSummary(
				"Team",
				{ action: "work.review", item: "w-1", verdict: "blocker" },
				undefined,
				zhLabels,
			),
		).toBe("记录评审 · w-1 · 有阻塞问题");
		expect(getSummary("Team", { action: "checkin", minutes: 30 }, undefined, zhLabels)).toBe(
			"自检 · 30 分钟后",
		);
		expect(getSummary("Team", { action: "brief" }, undefined, zhLabels)).toBe("读取简报");
		expect(getSummary("Team", { action: "mystery" }, undefined, zhLabels)).toBe("团队操作");
		// A server-truncated input still names its action.
		expect(
			getSummary(
				"Team",
				{ _truncated: true, preview: '{"action":"work.sync","item":"w-2"' },
				undefined,
				zhLabels,
			),
		).toBe("同步基线");
		// English fallbacks without injected labels.
		expect(getSummary("Team", { action: "work.create", title: "Fix" })).toBe(
			"Work item created · Fix",
		);
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
		// A new team is a new conversation (no window, no dividers carried over).
		const route = readFileSync(join(root, "routes/projects/$projectId_.teams.$teamId.tsx"), "utf8");
		expect(route).toMatch(/<CoordinatorConversation\s+\/\/[^\n]*\n\s+key=\{teamId\}/);
		// Only the coordinator's own top-level list takes the mode, never a subagent's.
		const list = readFileSync(
			join(root, "components/narrator/vlist/PretextExactMessageList.tsx"),
			"utf8",
		);
		expect(list).toContain(
			"providedTeamMode && !isSubagent && providedTeamMode.narratorId === narratorId",
		);
	});
});
