/**
 * The team page's components rendered with the real Mantine and both locales (P4): a card shows
 * its title, branch, worker, last verdict and marks as icons; the board's columns show the
 * summary's counts with finished columns folded; the top bar shows approvals and "pause all" to
 * members only; the activity words each event; every `teams` string exists in both languages.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import type {
	TeamActivityPage,
	TeamApprovalsResponse,
	TeamBoardColumn,
	TeamBoardColumnPage,
	TeamBoardItem,
	TeamPageSummary,
} from "@shared/project-teams";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { teamKeys } from "../../hooks/useTeams";
import en from "../../locales/en/projects.json";
import zh from "../../locales/zh-CN/projects.json";
import { TeamActivity } from "./TeamActivity";
import { TeamBoard, TeamBoardCard } from "./TeamBoard";
import { TeamApprovalsList, TeamTopBar } from "./TeamTopBar";
import { TEAM_BOARD_COLUMNS } from "./team-page-model";

const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", {
	configurable: true,
	value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
});
afterAll(() => {
	if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
	else Reflect.deleteProperty(globalThis, "localStorage");
});

async function i18nFor(lng: "en" | "zh-CN") {
	const i18n = createInstance();
	await i18n.init({
		lng,
		resources: { en: { projects: en }, "zh-CN": { projects: zh } },
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
				<MantineProvider>{node}</MantineProvider>
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
	reviewRounds: 2,
	lastReview: "blocker",
	hasWorktree: true,
	exclusiveKey: "migrations",
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
	columnCounts: { queued: 1, in_progress: 1, review: 0, done: 3, cancelled: 0 },
	lastEventId: null,
	lastEventAt: null,
	...patch,
});

function seededClient(columns: Partial<Record<TeamBoardColumn, TeamBoardItem[]>>) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	for (const column of TEAM_BOARD_COLUMNS) {
		const page: TeamBoardColumnPage = { column, items: columns[column] ?? [], nextCursor: null };
		client.setQueryData(teamKeys.board("lead", column), {
			pages: [page],
			pageParams: [undefined],
		});
	}
	return client;
}

describe("board card", () => {
	test("title, branch, worker status, verdict with rounds, marks as icons", async () => {
		const html = await render(<TeamBoardCard item={item()} />);
		expect(html).toContain('data-state="in_progress"');
		expect(html).toContain("Add the board");
		expect(html).toContain("team/add-the-board-1a2b3c4d");
		expect(html).toContain("Board worker");
		expect(html).toContain('data-verdict="blocker"');
		expect(html).toContain("Last review: blocker · 2 review rounds");
		expect(html).toContain('data-mark="exclusive"');
		expect(html).not.toContain('data-mark="cleanable"');
		// The state is the outline's badge (an SVG with its state), never a text glyph.
		expect(html).toMatch(/<svg[^>]*data-status="doing"[^>]*aria-label="In progress"/);
		expect(html).not.toMatch(/[☐☑✓✔✗✘●○◐]/);
	});

	test("no worker, no branch, no verdict; a merged item holding its worktree", async () => {
		const html = await render(
			<TeamBoardCard
				item={item({
					state: "merged",
					worker: null,
					branch: null,
					lastReview: null,
					exclusiveKey: null,
				})}
			/>,
		);
		expect(html).toContain("No worker yet");
		expect(html).toContain("No branch yet");
		expect(html).not.toContain("data-verdict");
		expect(html).toContain('data-mark="cleanable"');
		expect(html).toMatch(/data-status="done"/);
	});

	test("Chinese", async () => {
		const html = await render(<TeamBoardCard item={item()} />, new QueryClient(), "zh-CN");
		expect(html).toContain("最近评审：有阻塞 · 2 轮评审");
		expect(html).toContain('aria-label="进行中"');
	});
});

describe("ready items and approvals answered in their session", () => {
	test("a ready card in the review column says its state in words", async () => {
		const html = await render(
			<TeamBoardCard item={item({ state: "ready", lastReview: "clear" })} />,
		);
		expect(html).toContain('data-testid="team-card-state"');
		expect(html).toContain("Ready to merge");
		expect(html).toMatch(/data-status="delegated"/);
		expect(html).not.toMatch(/data-status="newly_done"/);
		const review = await render(<TeamBoardCard item={item({ state: "in_review" })} />);
		expect(review).not.toContain("team-card-state");
	});

	test("questions show as text with Open session, never Approve / Deny", async () => {
		const client = new QueryClient();
		const approvals: TeamApprovalsResponse = {
			more: false,
			approvals: [
				{
					id: "q1",
					agent: { id: "w", title: "Worker", status: "waiting" },
					depth: 1,
					toolName: "AskUserQuestion",
					kind: "question",
					preview: "",
					questions: ["Which branch first?"],
					decisionReason: null,
					createdAt: "2026-11-18T00:00:00.000Z",
				},
				{
					id: "t1",
					agent: { id: "w", title: "Worker", status: "waiting" },
					depth: 1,
					toolName: "Bash",
					kind: "tool",
					preview: "bun test",
					questions: [],
					decisionReason: null,
					createdAt: "2026-11-18T00:00:01.000Z",
				},
			],
		};
		client.setQueryData(teamKeys.approvals("lead"), approvals);
		const html = await render(
			<TeamApprovalsList projectId="p" teamId="lead" onOpenSession={() => {}} />,
			client,
		);
		const [question, tool] = html.split('data-testid="team-approval"').slice(1);
		expect(question).toContain("Question");
		expect(question).toContain("Which branch first?");
		expect(question).toContain("team-approval-open");
		expect(question).not.toContain("team-approval-approve");
		expect(question).not.toContain("questions&quot;");
		expect(tool).toContain("team-approval-approve");
		expect(tool).toContain("bun test");
	});
});

describe("board", () => {
	test("five columns with the summary's counts; finished ones folded", async () => {
		const client = seededClient({
			queued: [item({ id: "q", state: "queued", title: "Queued one" })],
			in_progress: [item()],
			done: [item({ id: "m", state: "merged", title: "Merged one" })],
		});
		const html = await render(
			<TeamBoard projectId="p" teamId="lead" summary={summary()} />,
			client,
		);
		const columns = [...html.matchAll(/data-column="([a-z_]+)" data-count="(\d+)"/g)].map(
			(match) => [match[1], Number(match[2])],
		);
		expect(columns).toEqual([
			["queued", 1],
			["in_progress", 1],
			["review", 0],
			["done", 3],
			["cancelled", 0],
		]);
		expect(html).toContain("Queued one");
		expect(html).toContain("Add the board");
		// Done is folded: its card is not rendered until opened.
		expect(html).not.toContain("Merged one");
		expect(html).toContain("Nothing here");
	});
});

describe("top bar", () => {
	test("members see approvals (capped) and pause all; onlookers see neither", async () => {
		const member = await render(
			<TeamTopBar
				projectId="p"
				teamId="lead"
				title="Release crew"
				summary={summary({
					pendingApprovalCount: 51,
					runningCount: 2,
					runningAgents: [
						{ id: "lead", title: "Release crew", status: "working" },
						{ id: "w", title: "Worker", status: "waiting" },
					],
				})}
			/>,
		);
		expect(member).toContain("Release crew");
		expect(member).toContain('data-testid="team-approvals-button"');
		expect(member).toContain("50+ approvals");
		expect(member).toContain("2 running");
		expect(member).toContain('data-testid="team-pause-all"');

		const reader = await render(
			<TeamTopBar
				projectId="p"
				teamId="lead"
				title="Release crew"
				summary={summary({ access: "read", pendingApprovalCount: null })}
			/>,
		);
		expect(reader).not.toContain("team-approvals-button");
		expect(reader).not.toContain("team-pause-all");
		expect(reader).toContain("Nothing running");
	});

	test("Chinese", async () => {
		const html = await render(
			<TeamTopBar
				projectId="p"
				teamId="lead"
				title="发布小组"
				summary={summary({ pendingApprovalCount: 1, runningCount: 1 })}
			/>,
			new QueryClient(),
			"zh-CN",
		);
		expect(html).toContain("1 个待批");
		expect(html).toContain("1 个运行中");
		expect(html).toContain("全部暂停");
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
