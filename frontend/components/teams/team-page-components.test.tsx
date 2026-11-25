/**
 * The team page's components rendered with the real Mantine and both locales (the redesign R):
 * the header's status sentence, people and 全部暂停 (members only, kept while an archived team's
 * workers run); 「等你处理」 cards of each kind, folded past three, 合并 with its states (M); the work
 * list's groups and rows, its starting and wrap-up states, read-only 「等成员处理」; the activity
 * words each event; every `teams` string exists in both languages.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { MantineProvider } from "@mantine/core";
import type {
	TeamActivityPage,
	TeamBoardItem,
	TeamMembersResponse,
	TeamPageSummary,
	TeamPendingApproval,
	TeamWorkItemDetail,
} from "@shared/project-teams";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterContextProvider,
} from "@tanstack/react-router";
import { createInstance } from "i18next";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { teamKeys } from "../../hooks/useTeams";
import * as recentTabsOwner from "../../lib/recent-tabs-owner";
import enNarrator from "../../locales/en/narrator.json";
import en from "../../locales/en/projects.json";
import zhNarrator from "../../locales/zh-CN/narrator.json";
import zh from "../../locales/zh-CN/projects.json";
import { ActivityLine, TeamActivity } from "./TeamActivity";
import { TeamAttention } from "./TeamAttention";
import { TeamCoordinatorHeader } from "./TeamCoordinatorHeader";
import { TeamHeader } from "./TeamHeader";
import { TeamMembersPanel } from "./TeamMembers";
import { TeamReadOnlyStart, TeamStart } from "./TeamStart";
import { DependencySections, ReviewFindings } from "./TeamWorkDrawer";
import { TeamWorkList } from "./TeamWorkList";
import { attentionEntries, statusSentence, teamPageMode } from "./team-page-model";

const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
const pinScope = { userId: "team-test-user", authGeneration: 1, accessGeneration: 0 };
let scopeSpy: ReturnType<typeof spyOn<typeof recentTabsOwner, "useRecentTabsScope">>;
beforeAll(() => {
	// Static markup intentionally has no real auth scope; supply one to exercise pin placement.
	scopeSpy = spyOn(recentTabsOwner, "useRecentTabsScope").mockReturnValue(pinScope);
});

const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", {
	configurable: true,
	value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
});
afterAll(() => {
	scopeSpy.mockRestore();
	if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
	else Reflect.deleteProperty(globalThis, "localStorage");
});

async function i18nFor(lng: "en" | "zh-CN") {
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
	return i18n;
}

async function render(node: ReactNode, client = new QueryClient(), lng: "en" | "zh-CN" = "en") {
	const i18n = await i18nFor(lng);
	return renderToStaticMarkup(
		<I18nextProvider i18n={i18n}>
			<QueryClientProvider client={client}>
				<MantineProvider>
					<RouterContextProvider router={router}>{node}</RouterContextProvider>
				</MantineProvider>
			</QueryClientProvider>
		</I18nextProvider>,
	);
}

const item = (patch: Partial<TeamBoardItem> = {}): TeamBoardItem => ({
	id: "w1",
	title: "Add the board",
	kind: "change",
	state: "in_progress",
	branch: "team/add-the-board-1a2b3c4d",
	baseRef: "main",
	headSha: "0123456789ab",
	worker: { id: "n-worker", title: "Board worker", status: "working" },
	reviewRounds: 0,
	lastReview: null,
	hasWorktree: true,
	exclusiveKey: null,
	createdAt: "2026-11-18T00:00:00.000Z",
	updatedAt: "2026-11-18T00:00:00.000Z",
	...patch,
});

const summary = (patch: Partial<TeamPageSummary> = {}): TeamPageSummary => ({
	teamId: "lead",
	access: "write",
	coordinatorStatus: "idle",
	runningAgents: [],
	runningCount: 0,
	pendingApprovalCount: 0,
	columnCounts: { queued: 1, in_progress: 2, review: 1, done: 3, cancelled: 1 },
	lastEventId: null,
	lastEventAt: null,
	coordinatorMessageCount: 4,
	coordinatorStopReason: null,
	...patch,
});

const call = (patch: Partial<TeamPendingApproval> = {}): TeamPendingApproval => ({
	id: "call-1",
	agent: { id: "n-worker", title: "Board worker", status: "waiting" },
	depth: 1,
	parentId: "lead",
	toolName: "Bash",
	kind: "tool",
	preview: "pnpm --filter web add @acme/pay-sdk@3.2.0",
	questions: [],
	decisionReason: null,
	createdAt: "2026-11-18T00:00:00.000Z",
	...patch,
});

const noop = () => {};

describe("header", () => {
	const header = (s: TeamPageSummary, phone = false, lng: "en" | "zh-CN" = "en") =>
		render(
			<TeamHeader
				projectId="p"
				teamId="lead"
				projectName="acme-app"
				title="Release crew"
				pinTitle="Release crew"
				summary={s}
				status={statusSentence({
					summary: s,
					member: s.access === "write",
					waiting: 1,
					waitingItems: 1,
				})}
				phone={phone}
				onBack={noop}
				onOpenCoordinatorSession={noop}
				onOpenSettings={noop}
				onDisband={noop}
			/>,
			new QueryClient(),
			lng,
		);

	test("crumb, name, one status sentence; members get pause all, people, pin and the menu", async () => {
		const html = await header(summary({ runningCount: 2 }));
		expect(html).toContain("acme-app");
		expect(html).toContain("Release crew");
		expect(html).toContain('data-testid="team-status" data-tone="active"');
		expect(html).toContain("3 in progress");
		expect(html).toContain("1 waiting on you");
		expect(html).toContain('data-testid="team-pause-all"');
		expect(html).toContain('data-testid="team-members-button"');
		expect(html).toContain('data-testid="pin-to-sidebar"');
		expect(html).toContain('data-testid="team-more-menu"');
		// 全部暂停 is an ordinary button, not a red one.
		expect(html).not.toMatch(/data-testid="team-pause-all"[^>]*red/);
		const zhHtml = await header(summary({ runningCount: 2 }), false, "zh-CN");
		expect(zhHtml).toContain("3 项进行中");
		expect(zhHtml).toContain("1 项等你");
		expect(zhHtml).toContain("全部暂停");
	});

	test("onlookers: no pause all; their sentence says waiting on members", async () => {
		const html = await header(summary({ access: "read", pendingApprovalCount: null }));
		expect(html).not.toContain("team-pause-all");
		expect(html).toContain("1 waiting on members");
		expect(html).toContain('data-testid="team-members-button"');
	});

	test("phone: two rows, the menu button first, pause all moved into the menu", async () => {
		const html = await header(summary({ runningCount: 1 }), true);
		expect(html).toContain('data-phone="true"');
		expect(html).not.toContain('data-testid="team-pause-all"');
		expect(html).not.toContain("team-crumb-project");
	});

	test("an archived team says so; pause all only while its workers still run", async () => {
		const archived = summary({ coordinatorStatus: "archived" });
		const html = await header(archived);
		expect(html).toContain('data-testid="team-archived"');
		expect(html).toContain("Archived");
		expect(html).not.toContain("team-pause-all");
		expect(await header({ ...archived, runningCount: 2 })).toContain("team-pause-all");
	});

	test("pin reads the sidebar's pin", async () => {
		const pinned = new QueryClient();
		pinned.setQueryData(recentTabsOwner.recentTabsFlatQueryKey(pinScope), [
			{ type: "team", id: "lead", title: "Release crew", lastVisitedAt: 1, pinned: true },
		]);
		const html = await render(
			<TeamHeader
				projectId="p"
				teamId="lead"
				projectName={null}
				title="Release crew"
				pinTitle="Release crew"
				summary={summary()}
				status={null}
				phone={false}
				onBack={noop}
			/>,
			pinned,
		);
		expect(html).toContain('data-pinned="true"');
	});
});

describe("等你处理", () => {
	const items = [
		item({ id: "a" }),
		item({
			id: "r",
			state: "ready",
			lastReview: "clear",
			reviewRounds: 2,
			title: "Fix the CSV time zone",
			branch: "team/csv-tz",
			merge: {
				mode: "github",
				phase: null,
				job: null,
				outcome: null,
				canMerge: false,
				disabledReason: "github_pending",
			},
		}),
	];
	const attention = (approvals: TeamPendingApproval[], lng: "en" | "zh-CN" = "en", phone = false) =>
		render(
			<TeamAttention
				entries={attentionEntries({ member: true, approvals, items })}
				phone={phone}
				teamId="lead"
				projectId="p"
				base="main"
				stats={{ r: { added: 42, removed: 11, files: 5, binaryFiles: 0, truncated: false } }}
				onOpenItem={noop}
				onOpenSession={noop}
			/>,
			new QueryClient(),
			lng,
		);

	test("hidden when nothing waits", async () => {
		const html = await render(
			<TeamAttention
				entries={[]}
				phone={false}
				teamId="lead"
				base="main"
				stats={undefined}
				onOpenItem={noop}
			/>,
		);
		expect(html).not.toContain("team-attention");
	});

	test("a tool call: who, the command, deny / approve; a ready item: +/-, files, verdict, branch, merge disabled on GitHub", async () => {
		const html = await attention([call()]);
		expect(html).toContain('data-kind="tool"');
		expect(html).toContain("Add the board");
		expect(html).toContain("the worker asks to run a command");
		expect(html).toContain("pnpm --filter web add @acme/pay-sdk@3.2.0");
		expect(html).toContain('data-testid="team-approval-deny"');
		expect(html).toContain('data-testid="team-approval-approve"');
		expect(html).toContain('data-kind="merge"');
		expect(html).toContain("+42");
		expect(html).toContain("-11");
		expect(html).toContain("5 files");
		expect(html).toContain("Review passed · round 2");
		expect(html).toContain("team/csv-tz → main");
		expect(html).toContain('data-testid="team-merge-view"');
		expect(html).toContain('data-testid="team-merge-return"');
		expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="team-merge-button"/);
		expect(html).toContain('data-reason="github_pending"');
		expect(html).toContain("Merge into main");
		expect(html).toContain('data-testid="team-attention-count"');
	});

	test("a question with options and 自己写…; a plan with 看计划 / 批准; a rule opens its session", async () => {
		const html = await attention(
			[
				call({
					id: "q",
					kind: "question",
					toolName: "AskUserQuestion",
					preview: "",
					questions: ["Which rounding rule?"],
					answerForm: {
						header: "Rounding",
						description: null,
						options: ["Half up", "Banker's"],
						optionDescriptions: [null, null],
						multiSelect: false,
					},
				}),
				call({
					id: "plan",
					kind: "plan",
					toolName: "ExitPlanMode",
					preview: "Release order",
					depth: 0,
					agent: { id: "lead", title: "Lead", status: "waiting" },
					parentId: null,
				}),
			],
			"zh-CN",
		);
		expect(html).toContain("Which rounding rule?");
		expect(html.match(/data-testid="team-question-option"/g)).toHaveLength(2);
		expect(html).toContain("Banker&#x27;s");
		expect(html).toContain("自己写…");
		expect(html).toContain("协调者");
		expect(html).toContain("提交了计划");
		expect(html).toContain("Release order");
		expect(html).toContain("看计划");
		expect(html).toContain('data-testid="team-plan-approve"');
		const several = await attention([
			call({
				kind: "question",
				toolName: "AskUserQuestion",
				questions: ["a", "b"],
				answerForm: null,
			}),
		]);
		expect(several).toContain('data-testid="team-question-answer"');
		const rule = await attention([call({ kind: "rule", toolName: "RequestPermissionRule" })]);
		expect(rule).toContain('data-testid="team-approval-open"');
	});

	test("past three the rest fold into 还有 N 条; on a phone the cards scroll sideways", async () => {
		const calls = ["1", "2", "3", "4"].map((id) => call({ id }));
		const html = await attention(calls, "zh-CN");
		expect(html.match(/data-testid="team-attention-card"/g)).toHaveLength(3);
		expect(html).toContain("还有 2 条");
		const phone = await attention(calls, "zh-CN", true);
		expect(phone).toContain('data-attention-layout="phone"');
		expect(phone).toContain("左右滑动");
		expect(phone).toContain("1 / 5");
	});
});

describe("work list", () => {
	const list = (props: {
		s?: TeamPageSummary;
		items?: TeamBoardItem[];
		approvals?: TeamPendingApproval[];
		lng?: "en" | "zh-CN";
		highlightId?: string | null;
	}) => {
		const s = props.s ?? summary();
		return render(
			<TeamWorkList
				projectId="p"
				teamId="lead"
				summary={s}
				items={props.items ?? []}
				approvals={props.approvals ?? []}
				stats={{ a: { added: 214, removed: 97, files: 4, binaryFiles: 0, truncated: false } }}
				base="main"
				loading={false}
				failed={false}
				hasMore={false}
				onLoadMore={noop}
				highlightId={props.highlightId ?? null}
				mode={teamPageMode(s)}
				archiving={false}
				onArchive={noop}
				onDisband={noop}
				onOpenItem={noop}
			/>,
			new QueryClient(),
			props.lng ?? "en",
		);
	};

	test("groups in order with counts; each row its line and +/-; finished as counts", async () => {
		const html = await list({
			items: [
				item({ id: "q", state: "queued", worker: null }),
				item({ id: "a", worker: { id: "n-worker", title: null, status: "waiting" } }),
				item({ id: "rev", state: "in_review", reviewRounds: 0 }),
				item({
					id: "p",
					worker: { id: "n-p", title: null, status: "working" },
					activity: { toolName: "Bash", preview: "pnpm test api/auth", at: "x" },
				}),
			],
			s: summary({
				runningAgents: [{ id: "n-p", title: null, status: "working" }],
				runningCount: 1,
			}),
			approvals: [call()],
			highlightId: "a",
			lng: "zh-CN",
		});
		const groups = [...html.matchAll(/data-testid="team-group-([a-zA-Z]+)"/g)].map((m) => m[1]);
		expect(groups).toEqual(["needsYou", "inProgress", "review"]);
		expect(html).toContain("需要你");
		expect(html).toContain("评审 · 就绪");
		expect(html).toContain("等批准运行命令");
		expect(html).toContain("+214");
		expect(html).toContain("运行");
		expect(html).toContain("pnpm test api/auth");
		expect(html).toContain("排队");
		expect(html).toContain('data-item-id="a" data-state="in_progress" data-highlighted="true"');
		expect(html).toContain("已完成");
		expect(html).toContain("已取消");
		expect(html).toContain('data-testid="team-finished-done" data-open="false"');
	});

	test("read-only: the first group is 等成员处理, holding the ready items", async () => {
		const html = await list({
			s: summary({ access: "read", pendingApprovalCount: null }),
			items: [item({ id: "r", state: "ready", reviewRounds: 2, lastReview: "clear" })],
			lng: "zh-CN",
		});
		expect(html).toContain("等成员处理");
		expect(html).not.toContain("需要你");
		expect(html).toContain("可以合并");
	});

	test("no work yet: the dashed explanation, not empty columns", async () => {
		const empty = summary({
			columnCounts: { queued: 0, in_progress: 0, review: 0, done: 0, cancelled: 0 },
		});
		const html = await list({ s: empty, lng: "zh-CN" });
		expect(html).toContain('data-testid="team-work-empty"');
		expect(html).toContain("工作项会出现在这里");
		expect(html).not.toContain("team-group-");
	});

	test("wrap-up: archive or disband, done opened", async () => {
		const done = summary({
			columnCounts: { queued: 0, in_progress: 0, review: 0, done: 7, cancelled: 1 },
		});
		const html = await list({ s: done, lng: "zh-CN" });
		expect(html).toContain('data-testid="team-wrap-up"');
		expect(html).toContain("没有进行中的工作项");
		expect(html).toContain("7 个分支都已合并到 main");
		expect(html).toContain('data-testid="team-wrap-up-archive"');
		expect(html).toContain('data-testid="team-wrap-up-disband"');
		expect(html).toContain('data-testid="team-finished-done" data-open="true"');
		// Onlookers get the explanation without the buttons.
		const reader = await list({ s: { ...done, access: "read", pendingApprovalCount: null } });
		expect(reader).toContain("team-wrap-up");
		expect(reader).not.toContain("team-wrap-up-archive");
	});
});

describe("starting state", () => {
	test("tells what to do, with three examples", async () => {
		const html = await render(<TeamStart teamId="lead" />, new QueryClient(), "zh-CN");
		expect(html).toContain("告诉协调者这个团队要完成什么");
		expect(html.match(/data-testid="team-start-example"/g)).toHaveLength(3);
	});
});

describe("members (M1)", () => {
	const members: TeamMembersResponse = {
		members: [
			{
				userId: "u-owner",
				username: "olivia",
				avatarColor: null,
				avatarImageId: null,
				role: "member",
				owner: true,
				lastSpokeAt: "2026-11-18T09:31:00.000Z",
			},
			{
				userId: "u-bob",
				username: "bob",
				avatarColor: null,
				avatarImageId: null,
				role: "member",
				owner: false,
				lastSpokeAt: null,
			},
			{
				userId: "u-carol",
				username: "carol",
				avatarColor: null,
				avatarImageId: null,
				role: "onlooker",
				owner: false,
				lastSpokeAt: null,
			},
		],
		more: false,
		visibility: "project",
		writeAudience: "project",
		canManage: false,
	};

	test("members and onlookers with their role, owner and last message; who manages", async () => {
		const client = new QueryClient();
		client.setQueryData(teamKeys.members("lead"), members);
		const html = await render(<TeamMembersPanel projectId="p" teamId="lead" />, client);
		const rows = [...html.matchAll(/data-user-id="([^"]+)" data-role="([a-z]+)"/g)].map((match) => [
			match[1],
			match[2],
		]);
		expect(rows).toEqual([
			["u-owner", "member"],
			["u-bob", "member"],
			["u-carol", "onlooker"],
		]);
		expect(html).toContain("2 members");
		expect(html).toContain("1 onlooker");
		expect(html).toContain("Owner");
		expect(html).toContain("Last spoke");
		expect(html).toContain("No recent message");
		expect(html).toContain("Everyone with write access to the project is a member too.");
		expect(html).toContain("Everyone in the project can look on.");
		// Not the owner: no sharing controls, only who can change it.
		expect(html).toContain("team-members-manage-hint");
		expect(html).not.toContain('data-testid="team-members-manage"');

		const zhHtml = await render(<TeamMembersPanel projectId="p" teamId="lead" />, client, "zh-CN");
		expect(zhHtml).toContain("2 位成员");
		expect(zhHtml).toContain("旁观者");
		expect(zhHtml).toContain("所有者");
		expect(zhHtml).toContain("最近没有发言");
	});
});

describe("activity", () => {
	test("events worded with item, note and actor", async () => {
		const client = new QueryClient();
		const page: TeamActivityPage = {
			events: [
				{
					id: "e2",
					kind: "team.decision",
					workItemId: null,
					workItemTitle: null,
					actorKind: "agent",
					actorId: "lead",
					actorName: "Release crew",
					detail: { summary: "Merge order: board first" },
					detailOmitted: false,
					createdAt: "2026-11-18T00:00:02.000Z",
				},
				{
					id: "e1",
					kind: "work.review",
					workItemId: "w1",
					workItemTitle: "Add the board",
					actorKind: "person",
					actorId: "u1",
					actorName: null,
					detail: { round: 1, verdict: "clear", findings: 0 },
					detailOmitted: false,
					createdAt: "2026-11-18T00:00:01.000Z",
				},
				{
					id: "e4",
					kind: "approval.denied",
					workItemId: null,
					workItemTitle: null,
					actorKind: "person",
					actorId: "u2",
					actorName: "bob",
					detail: { tool: "Bash", agentTitle: "Parser worker", depth: 1 },
					detailOmitted: false,
					createdAt: "2026-11-18T00:00:04.000Z",
				},
				{
					id: "e5",
					kind: "approval.allowed",
					workItemId: null,
					workItemTitle: null,
					actorKind: "person",
					actorId: "u5",
					actorName: "erin",
					detail: {
						tool: "ExitPlanMode",
						approvalKind: "plan",
						agentTitle: "Parser worker",
						depth: 1,
					},
					detailOmitted: false,
					createdAt: "2026-11-18T00:00:05.000Z",
				},
				{
					id: "e3",
					kind: "question.answered",
					workItemId: null,
					workItemTitle: null,
					actorKind: "person",
					actorId: "u3",
					actorName: "carol",
					detail: { tool: "AskUserQuestion", agentTitle: "Release crew", depth: 0 },
					detailOmitted: false,
					createdAt: "2026-11-18T00:00:03.000Z",
				},
				{
					id: "e0",
					kind: "team.brief",
					workItemId: null,
					workItemTitle: null,
					actorKind: "system",
					actorId: null,
					actorName: null,
					detail: null,
					detailOmitted: true,
					createdAt: "2026-11-18T00:00:00.000Z",
				},
			],
			nextCursor: null,
		};
		client.setQueryData(teamKeys.activity("lead"), { pages: [page], pageParams: [undefined] });
		const html = await render(<TeamActivity projectId="p" teamId="lead" />, client);
		expect(html).toContain("Decided on people&#x27;s behalf");
		expect(html).toContain("Merge order: board first");
		expect(html).toContain("Review recorded");
		expect(html).toContain("Round 1: clear, 0 findings");
		expect(html).toContain("Someone");
		expect(html).toContain("Details too long to list");
		expect(html).toContain("System");
		// M1: who decided, on what, in which session.
		expect(html).toContain("Denied");
		expect(html).toContain("Bash · Parser worker");
		expect(html).toContain("bob");
		expect(html).toContain("Answered a question");
		expect(html).toContain("AskUserQuestion · coordinator");
		// A plan decision names the plan, never its tool.
		expect(html).toContain("A plan · Parser worker");
		expect(html).not.toContain("ExitPlanMode");
		expect(html).toContain("carol");
	});
});

describe("strings", () => {
	test("every teams string exists in English and Chinese", () => {
		const keys = (value: unknown, prefix = ""): string[] =>
			value && typeof value === "object"
				? Object.entries(value).flatMap(([key, child]) => keys(child, `${prefix}${key}.`))
				: [prefix.slice(0, -1)];
		expect(keys(zh.teams).sort()).toEqual(keys(en.teams).sort());
	});
});

describe("review fixes", () => {
	const header = (phone: boolean) =>
		render(
			<TeamHeader
				projectId="p"
				teamId="lead"
				projectName="acme-app"
				title="Release crew"
				summary={summary()}
				status={null}
				phone={phone}
				onBack={noop}
			/>,
		);

	test("the phone header keeps its back arrow", async () => {
		expect(await header(true)).toContain('data-testid="team-back"');
		expect(await header(false)).toContain('data-testid="team-back"');
	});

	test("等你处理: the asker opens its session, a reason shows, more than listed is said", async () => {
		const items = [item({ id: "a" })];
		const html = await render(
			<TeamAttention
				entries={attentionEntries({
					member: true,
					approvals: [call({ decisionReason: "Writes outside the worktree" })],
					items,
				})}
				phone={false}
				teamId="lead"
				base="main"
				stats={undefined}
				more
				onOpenItem={noop}
				onOpenSession={noop}
				onOpenCoordinatorSession={noop}
			/>,
		);
		expect(html).toContain('data-testid="team-approval-asker"');
		expect(html).toContain("Writes outside the worktree");
		expect(html).toContain('data-testid="team-attention-beyond"');
		expect(html).toContain("More are waiting than listed here");
		expect(html).toContain(">1+<");
		const unscanned = await render(
			<TeamAttention
				entries={attentionEntries({ member: true, approvals: [call()], items })}
				phone={false}
				teamId="lead"
				base="main"
				stats={undefined}
				unscanned
				onOpenItem={noop}
			/>,
		);
		expect(unscanned).toContain("may not be listed here");
	});

	test("a long option is answered with its whole title, only its label clipped", async () => {
		const long = `Read the team's default time zone ${"x".repeat(100)}`;
		const html = await render(
			<TeamAttention
				entries={attentionEntries({
					member: true,
					approvals: [
						call({
							kind: "question",
							toolName: "AskUserQuestion",
							questions: ["Which?"],
							answerForm: {
								header: "Zone",
								description: null,
								options: [long, "UTC"],
								optionDescriptions: [null, null],
								multiSelect: false,
							},
						}),
					],
					items: [],
				})}
				phone={false}
				teamId="lead"
				base="main"
				stats={undefined}
				onOpenItem={noop}
			/>,
		);
		expect(html).toContain(
			`data-value="Read the team&#x27;s default time zone ${"x".repeat(100)}"`,
		);
	});

	test("marks on rows; no +0 -0; the wrap-up never offers disband while worktrees are held", async () => {
		const s = summary({
			columnCounts: { queued: 1, in_progress: 1, review: 0, done: 2, cancelled: 0 },
		});
		const html = await render(
			<TeamWorkList
				projectId="p"
				teamId="lead"
				summary={s}
				items={[
					item({ id: "lock", exclusiveKey: "paths" }),
					item({ id: "q", state: "queued", worker: null }),
				]}
				approvals={[]}
				stats={{ q: { added: 0, removed: 0, files: 0, binaryFiles: 0, truncated: false } }}
				base="main"
				loading={false}
				failed={false}
				hasMore={false}
				onLoadMore={noop}
				highlightId={null}
				mode={teamPageMode(s)}
				archiving={false}
				onOpenItem={noop}
			/>,
		);
		expect(html).toContain('data-mark="exclusive"');
		expect(html).not.toContain("diff-count");
		const held = summary({
			columnCounts: { queued: 0, in_progress: 0, review: 0, done: 2, cancelled: 1 },
			heldWorktreeCount: 2,
		});
		const wrap = await render(
			<TeamWorkList
				projectId="p"
				teamId="lead"
				summary={held}
				items={[]}
				approvals={[]}
				stats={undefined}
				base="main"
				loading={false}
				failed={false}
				hasMore={false}
				onLoadMore={noop}
				highlightId={null}
				mode={teamPageMode(held)}
				archiving={false}
				onArchive={noop}
				onDisband={noop}
				onOpenItem={noop}
			/>,
			new QueryClient(),
			"zh-CN",
		);
		expect(wrap).toContain('data-testid="team-wrap-up-held"');
		expect(wrap).toContain("还有 2 个已结束的工作项保留着 worktree");
		expect(wrap).toContain("team-wrap-up-archive");
		expect(wrap).not.toContain("team-wrap-up-disband");
	});

	test("the coordinator signs its events as 协调者; read-only members get a plain start line", async () => {
		const event = {
			id: "e",
			kind: "work.created",
			workItemId: "w",
			workItemTitle: "Fix",
			actorKind: "agent" as const,
			actorId: "lead",
			actorName: "发布小组",
			detail: null,
			detailOmitted: false,
			createdAt: "2026-11-18T00:00:00.000Z",
		};
		const html = await render(
			<ActivityLine event={event} coordinatorId="lead" />,
			new QueryClient(),
			"zh-CN",
		);
		expect(html).toContain("协调者");
		expect(html).not.toContain("发布小组");
		const start = await render(<TeamReadOnlyStart />, new QueryClient(), "zh-CN");
		expect(start).toContain("还没有人给协调者布置任务");
		expect(start).not.toContain("team-start-example");
	});
});

describe("questions keep their context", () => {
	const card = (form: TeamPendingApproval["answerForm"], questions: string[] = []) =>
		render(
			<TeamAttention
				entries={attentionEntries({
					member: true,
					approvals: [
						call({ kind: "question", toolName: "AskUserQuestion", questions, answerForm: form }),
					],
					items: [],
				})}
				phone={false}
				teamId="lead"
				base="main"
				stats={undefined}
				onOpenItem={noop}
			/>,
		);

	test("the title, the whole prompt and each option's explanation; the answer is the title", async () => {
		const html = await card({
			header: "Rounding rule",
			description: "Discounts split across lines leave a 0.005 remainder. Which rule rounds it?",
			options: ["Half up", "Banker's rounding"],
			optionDescriptions: ["Rounds 0.5 away from zero", null],
			multiSelect: false,
		});
		expect(html).toContain("Rounding rule");
		expect(html).toContain("leave a 0.005 remainder. Which rule rounds it?");
		expect(html.match(/data-testid="team-question-option-description"/g)).toHaveLength(1);
		expect(html).toContain("Rounds 0.5 away from zero");
		expect(html).toContain('data-value="Banker&#x27;s rounding"');
	});

	test("context too long for a card: the full form, no one-click answers", async () => {
		const html = await card(
			{
				header: "Plan",
				description: "x".repeat(700),
				options: ["A", "B"],
				optionDescriptions: [null, null],
				multiSelect: false,
			},
			["Long"],
		);
		expect(html).not.toContain("team-question-option");
		expect(html).toContain('data-testid="team-question-answer"');
	});

	test("a refused base branch has its own words in both languages", async () => {
		const { settingsErrorKey, workStartPatch } = await import("./TeamSettingsModal");
		// W: only the work start key is sent; the default removes it (the server merges).
		expect(workStartPatch("remote")).toEqual({ workStart: "remote" });
		expect(workStartPatch("default")).toEqual({ workStart: null });
		const key = settingsErrorKey({ data: { code: "TEAM_BASE_BRANCH_UNRESOLVED" } });
		expect(key).toBe("teams.page.settings.errors.TEAM_BASE_BRANCH_UNRESOLVED");
		expect(settingsErrorKey({ data: { code: "OTHER" } })).toBeNull();
		for (const lng of ["en", "zh-CN"] as const) {
			const i18n = await i18nFor(lng);
			const text = i18n.t(key ?? "", { branch: "mian" });
			expect(text).toContain("mian");
			expect(text).not.toContain("teams.page");
		}
	});
});

describe("dependencies (D)", () => {
	const dep = (id: string, title: string, state: TeamBoardItem["state"]) => ({ id, title, state });
	const rows = (items: TeamBoardItem[], lng: "en" | "zh-CN") =>
		render(
			<TeamWorkList
				projectId="p"
				teamId="lead"
				summary={summary()}
				items={items}
				approvals={[]}
				stats={{}}
				base="main"
				loading={false}
				failed={false}
				hasMore={false}
				onLoadMore={noop}
				highlightId={null}
				mode={teamPageMode(summary())}
				archiving={false}
				onArchive={noop}
				onDisband={noop}
				onOpenItem={noop}
			/>,
			new QueryClient(),
			lng,
		);

	test("a blocked queued row names what it waits for, or how many; a cancelled one says so", async () => {
		const queued = (id: string, dependsOn: TeamBoardItem["dependsOn"]) =>
			item({ id, state: "queued", worker: null, dependsOn });
		const zhHtml = await rows(
			[
				queued("one", [dep("a", "数据表", "in_progress")]),
				queued("two", [dep("a", "数据表", "ready"), dep("b", "接口", "queued")]),
				queued("many", [
					dep("a", "A", "queued"),
					dep("b", "B", "queued"),
					dep("c", "C", "queued"),
					dep("d", "D", "merged"),
				]),
				queued("gone", [dep("x", "旧方案", "cancelled")]),
				queued("free", [dep("d", "D", "merged")]),
			],
			"zh-CN",
		);
		expect(zhHtml).toContain("排队 · 等「数据表」合并");
		expect(zhHtml).toContain("排队 · 等「数据表」「接口」合并");
		expect(zhHtml).toContain("排队 · 等 3 项合并");
		expect(zhHtml).toContain("排队 · 依赖「旧方案」已取消");
		const enHtml = await rows(
			[queued("two", [dep("a", "Schema", "queued"), dep("b", "API", "queued")])],
			"en",
		);
		expect(enHtml).toContain("Queued · waiting for “Schema” and “API” to merge");
	});

	const detail = (patch: Partial<TeamWorkItemDetail> = {}): TeamWorkItemDetail => ({
		item: item({
			id: "w2",
			state: "queued",
			worker: null,
			dependsOn: [dep("a", "数据表", "merged"), dep("b", "旧方案", "cancelled")],
		}),
		base: "main",
		aheadBy: 0,
		stat: null,
		files: [],
		filesMore: false,
		diffAvailable: false,
		reviews: [],
		events: [],
		eventsMore: false,
		canReturn: false,
		dependents: [dep("c", "页面", "queued")],
		dependentsMore: true,
		...patch,
	});

	test("the drawer lists dependencies with their state, warns about a cancelled one, and lists dependents", async () => {
		const opened: string[] = [];
		const html = await render(
			<DependencySections detail={detail()} onOpenItem={(id) => opened.push(id)} />,
			new QueryClient(),
			"zh-CN",
		);
		expect(html).toContain('data-testid="team-drawer-dependencies"');
		expect(html).toContain("依赖");
		expect(html).toContain('data-state="merged"');
		expect(html).toContain("已合并");
		expect(html).toContain('data-testid="team-dependency-cancelled"');
		expect(html).toContain("「旧方案」已取消，永远不会合并");
		expect(html).toContain('data-testid="team-drawer-dependents"');
		expect(html).toContain("被依赖");
		expect(html).toContain("页面");
		expect(html).toContain("依赖它的工作项比这里列出的多");
		// Titles are buttons that open the item in the drawer.
		expect(html.match(/<button/g)?.length).toBe(3);

		const waiting = await render(
			<DependencySections
				detail={detail({
					item: item({ state: "queued", worker: null, dependsOn: [dep("a", "Schema", "ready")] }),
					dependents: [],
					dependentsMore: false,
				})}
			/>,
			new QueryClient(),
			"en",
		);
		expect(waiting).toContain("Ready to merge");
		expect(waiting).toContain("Starts once every item here is merged into main.");
		expect(waiting).not.toContain("team-dependency-cancelled");
		expect(waiting).not.toContain("team-drawer-dependents");
		const none = await render(
			<DependencySections detail={detail({ item: item(), dependents: [] })} />,
		);
		expect(none).not.toContain("data-testid");
	});

	test("the activity words dependency changes and unblocks", async () => {
		const event = (kind: string, detailValue: Record<string, unknown>) => ({
			id: kind,
			kind,
			workItemId: "w2",
			workItemTitle: "API",
			actorKind: "agent" as const,
			actorId: "lead",
			actorName: "Release crew",
			detail: detailValue,
			detailOmitted: false,
			createdAt: "2026-11-18T00:00:01.000Z",
		});
		const html = await render(
			<>
				<ActivityLine event={event("work.dependencies_changed", { dependsOn: ["a", "b"] })} />
				<ActivityLine event={event("work.unblocked", { mergedItem: "a", dependsOn: ["a"] })} />
			</>,
			new QueryClient(),
			"zh-CN",
		);
		expect(html).toContain("修改依赖");
		// The event keeps only ids, not which were merged then: the count is worded neutrally.
		expect(html).toContain("依赖 2 项");
		expect(html).not.toContain("项合并");
		expect(html).toContain("可以开始了");
		expect(html).toContain("依赖的工作项都已合并");
	});
});

describe("review findings", () => {
	test("muted text clamped to three lines, 展开 when long, a note when cut", async () => {
		const short = await render(
			<ReviewFindings text="缺少跨日边界用例" clipped={false} />,
			undefined,
			"zh-CN",
		);
		expect(short).toContain("缺少跨日边界用例");
		expect(short).toContain("--text-line-clamp:3");
		expect(short).not.toContain("team-review-findings-toggle");
		const long = await render(
			<ReviewFindings text={"x".repeat(300)} clipped />,
			undefined,
			"zh-CN",
		);
		expect(long).toContain("team-review-findings-toggle");
		expect(long).toContain("展开");
		expect(long).toContain("评审意见合计太长");
		const gone = await render(<ReviewFindings text={null} clipped />);
		expect(gone).toContain("The findings are too long in all");
	});
});

describe("the coordinator's column header", () => {
	const agent = (id: string, status = "working") => ({ id, title: id, status });
	test("协调者 · N 个会话在运行 · 完整会话, in place of the session toolbar", async () => {
		const running = summary({
			coordinatorStatus: "working",
			runningAgents: [agent("lead"), agent("w1"), agent("w2"), agent("w3"), agent("w4")],
			runningCount: 5,
		});
		const zhHtml = await render(
			<TeamCoordinatorHeader summary={running} onOpenCoordinatorSession={() => {}} />,
			undefined,
			"zh-CN",
		);
		expect(zhHtml).toContain("协调者");
		expect(zhHtml).toContain("4 个会话在运行");
		expect(zhHtml).not.toContain("工作者");
		expect(zhHtml).toContain("完整会话");
		expect(zhHtml).toContain('data-tone="blue"');
		const html = await render(<TeamCoordinatorHeader summary={running} />);
		expect(html).toContain("4 sessions running");
		// No way to the full session given: no link.
		expect(html).not.toContain("team-coordinator-full-session");
		const idle = await render(
			<TeamCoordinatorHeader summary={summary()} onOpenCoordinatorSession={() => {}} />,
			undefined,
			"zh-CN",
		);
		expect(idle).toContain("空闲");
		expect(idle).toContain('data-kind="status"');
	});

	test("a list cut down to the coordinator still reads 1+, never 0+", async () => {
		const cut = summary({ runningAgents: [agent("lead")], runningCount: 2 });
		const zhHtml = await render(<TeamCoordinatorHeader summary={cut} />, undefined, "zh-CN");
		expect(zhHtml).toContain("1+ 个会话在运行");
		expect(zhHtml).not.toContain("0+");
		expect(await render(<TeamCoordinatorHeader summary={cut} />)).toContain("1+ sessions running");
	});

	test("连接断开 while the panel's socket is down, nothing while it is up", async () => {
		const down = { disconnected: true, reconnect: () => {} };
		const zhHtml = await render(
			<TeamCoordinatorHeader summary={summary()} connection={down} />,
			undefined,
			"zh-CN",
		);
		expect(zhHtml).toContain("team-coordinator-disconnected");
		expect(zhHtml).toContain("连接断开");
		expect(zhHtml).toContain('title="点击重新连接"');
		const html = await render(<TeamCoordinatorHeader summary={summary()} connection={down} />);
		expect(html).toContain("Disconnected");
		for (const connection of [undefined, null, { ...down, disconnected: false }]) {
			const upHtml = await render(
				<TeamCoordinatorHeader summary={summary()} connection={connection} />,
			);
			expect(upHtml).not.toContain("team-coordinator-disconnected");
		}
	});

	test("the session page keeps its toolbar: only the team route leaves it out", () => {
		const panel = readFileSync(new URL("../narrator/NarratorPanel.tsx", import.meta.url), "utf8");
		expect(panel).toContain("hideHeader = false,");
		expect(panel).toMatch(/\{!hideHeader && \(\s*<NarratorHeaderLayout/);
		const route = readFileSync(
			new URL("../../routes/projects/$projectId_.teams.$teamId.tsx", import.meta.url),
			"utf8",
		);
		expect(route).toMatch(/\bhideHeader\b/);
		// The hidden header's 「连接断开」 reaches the coordinator line through the panel's report.
		expect(route).toMatch(/onConnectionChange=\{onConnectionChange\}/);
		expect(route).toMatch(/onConnectionChange=\{setConnection\}/);
		expect(route).toMatch(/conversationConnection=\{connection\}/);
		expect(panel).toContain(
			"useReportPanelConnection(onConnectionChange, disconnected && !isWorkspacePreview, reconnect);",
		);
		const session = readFileSync(
			new URL("../../routes/narrators/$narratorId.tsx", import.meta.url),
			"utf8",
		);
		expect(session).not.toMatch(/\bhideHeader\b/);
	});
});

describe("merge (M)", () => {
	const ready = (merge: TeamBoardItem["merge"]) =>
		item({
			id: "r",
			state: "ready",
			lastReview: "clear",
			reviewRounds: 1,
			title: "Ship it",
			branch: "team/ship",
			worker: null,
			merge,
		});
	const card = (merge: TeamBoardItem["merge"], lng: "en" | "zh-CN" = "en") =>
		render(
			<TeamAttention
				entries={attentionEntries({ member: true, approvals: [], items: [ready(merge)] })}
				phone={false}
				teamId="lead"
				projectId="p"
				base="main"
				stats={undefined}
				onOpenItem={noop}
			/>,
			new QueryClient(),
			lng,
		);
	const idle = {
		mode: "local" as const,
		phase: null,
		job: null,
		outcome: null,
		canMerge: true,
		disabledReason: null,
	};

	test("the card: 合并到 base enabled; 正在合并… while a job runs; outcomes as badges", async () => {
		const enabled = await card(idle, "zh-CN");
		expect(enabled).toContain("合并到 main");
		expect(enabled).not.toMatch(/<button[^>]*disabled=""[^>]*data-testid="team-merge-button"/);
		const running = await card(
			{ ...idle, phase: "merging", job: "merge", canMerge: false, disabledReason: "merging" },
			"zh-CN",
		);
		expect(running).toContain("正在合并…");
		expect(running).toContain('data-merge-label="merging"');
		const conflict = await card({ ...idle, outcome: "conflict" }, "zh-CN");
		expect(conflict).toContain('data-outcome="conflict"');
		expect(conflict).toContain("与 main 有冲突");
		const prepared = await card({ ...idle, outcome: "prepared" }, "zh-CN");
		expect(prepared).toContain('data-outcome="prepared"');
		expect(prepared).toContain('data-testid="team-merge-open-prepared"');
		expect(prepared).toContain("重新准备");
	});

	test("disabled reasons say why, in both languages", async () => {
		for (const reason of [
			"worker_running",
			"github_pending",
			"git_too_old",
			"base_remote",
			"checking",
		] as const) {
			const html = await card({ ...idle, canMerge: false, disabledReason: reason }, "zh-CN");
			expect(html).toContain(`data-reason="${reason}"`);
			expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="team-merge-button"/);
		}
		expect(zh.teams.page.merge.disabled.github_pending).toContain("GitHub PR 流程即将提供");
	});

	test("the drawer's outcome: conflicts with 退回, a failure in words, a prepared merge with its command", async () => {
		const { MergeOutcome } = await import("./TeamMerge");
		const view = (detail: NonNullable<TeamWorkItemDetail["merge"]>["detail"], extra = {}) => ({
			...idle,
			outcome: detail?.kind === "prepared" ? ("prepared" as const) : ("conflict" as const),
			detail,
			...extra,
		});
		const outcome = (
			merge: NonNullable<TeamWorkItemDetail["merge"]>,
			lng: "en" | "zh-CN" = "zh-CN",
		) =>
			render(
				<MergeOutcome
					projectId="p"
					teamId="lead"
					itemId="r"
					base="main"
					merge={merge}
					canReturn
					onReturn={noop}
				/>,
				new QueryClient(),
				lng,
			);
		const conflict = await outcome(
			view({
				kind: "failed",
				code: "conflict",
				message: null,
				conflicts: ["src/a.ts", "src/b.ts"],
				more: true,
				at: "2026-11-25T00:00:00.000Z",
			}),
		);
		expect(conflict).toContain('data-testid="team-merge-conflicts"');
		expect(conflict).toContain("src/b.ts");
		expect(conflict).toContain("冲突的文件比这里列出的多");
		expect(conflict).toContain('data-testid="team-merge-conflict-return"');
		const failed = await outcome(
			view({
				kind: "failed",
				code: "TEAM_MERGE_BASE_MOVED",
				message: "main kept moving",
				at: "2026-11-25T00:00:00.000Z",
			}),
			"en",
		);
		expect(failed).toContain('data-code="TEAM_MERGE_BASE_MOVED"');
		expect(failed).toContain("The base kept moving");
		const prepared = await outcome(
			view(
				{
					kind: "prepared",
					mergeCommit: "a".repeat(40),
					baseSha: "b".repeat(40),
					checkedOutAt: "/home/alice/app",
					at: "2026-11-25T00:00:00.000Z",
				},
				{
					fastForward: {
						available: true,
						blocker: null,
						runningSessions: 0,
						terminals: 1,
						command: "git -C /home/alice/app merge --ff-only refs/narrafork/team-merges/r",
						files: ["src/a.ts", "upstream/u.ts"],
						filesMore: false,
					},
				},
			),
		);
		expect(prepared).toContain(
			"合并结果已准备好。main 检出在 /home/alice/app，NarraFork 不改动那里的文件。",
		);
		expect(prepared).toContain('data-testid="team-merge-fast-forward"');
		expect(prepared).toContain("在该目录中快进");
		expect(prepared).toContain(
			"git -C /home/alice/app merge --ff-only refs/narrafork/team-merges/r",
		);
		expect(prepared).toContain('data-testid="team-merge-copy"');
		const blocked = await outcome(
			view(
				{
					kind: "prepared",
					mergeCommit: "a".repeat(40),
					baseSha: "b".repeat(40),
					checkedOutAt: "/home/alice/app",
					at: "2026-11-25T00:00:00.000Z",
				},
				{
					fastForward: {
						available: false,
						blocker: "sessions_running",
						runningSessions: 2,
						terminals: 0,
						command: "git -C /home/alice/app merge --ff-only refs/narrafork/team-merges/r",
						files: ["src/a.ts", "upstream/u.ts"],
						filesMore: false,
					},
				},
			),
		);
		expect(blocked).toMatch(/<button[^>]*disabled=""[^>]*data-testid="team-merge-fast-forward"/);
		// A refused fast-forward keeps the prepared merge, with git's files and the command (review 11).
		const refused = await outcome(
			view(
				{
					kind: "prepared",
					mergeCommit: "a".repeat(40),
					baseSha: "b".repeat(40),
					checkedOutAt: "/home/alice/app",
					at: "2026-11-25T00:00:00.000Z",
					fastForwardFailure: {
						code: "TEAM_MERGE_FAST_FORWARD_REFUSED",
						message: "error: Your local changes would be overwritten",
						files: ["src/a.ts", "src/b.ts"],
						at: "2026-11-25T00:01:00.000Z",
					},
				},
				{
					fastForward: {
						available: true,
						blocker: null,
						runningSessions: 0,
						terminals: 0,
						command: "git -C /home/alice/app merge --ff-only refs/narrafork/team-merges/r",
						files: ["src/a.ts", "upstream/u.ts"],
						filesMore: false,
					},
				},
			),
		);
		expect(refused).toContain('data-code="TEAM_MERGE_FAST_FORWARD_REFUSED"');
		expect(refused).toContain("src/b.ts");
		expect(refused).toContain('data-testid="team-merge-fast-forward"');
		expect(refused).toContain("git -C /home/alice/app merge --ff-only");
		expect(blocked).toContain("那里有 2 个会话在运行");
		// Off the base the blocker shows and no command is offered (Devin 2).
		const offBase = await outcome(
			view(
				{
					kind: "prepared",
					mergeCommit: "a".repeat(40),
					baseSha: "b".repeat(40),
					checkedOutAt: "/home/alice/app",
					at: "2026-11-25T00:00:00.000Z",
				},
				{
					fastForward: {
						available: false,
						blocker: "not_on_base",
						runningSessions: 0,
						terminals: 0,
						command: null,
						files: [],
						filesMore: false,
					},
				},
			),
		);
		expect(offBase).toContain('data-testid="team-merge-blocker"');
		expect(offBase).not.toContain('data-testid="team-merge-command"');
	});
});
