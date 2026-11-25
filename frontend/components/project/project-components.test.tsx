/**
 * The redesigned project pages' parts rendered with the real Mantine and both locales (R2): the
 * team cards (numbers, the member's amber badge, the dashed 「新团队」 for writers, the one-line
 * empty state), the session list (tab counts, running rows first, 「最近 7 天」), 「等你处理」 with
 * each card's team or session (hidden when nothing waits), a project list card, and the settings
 * page's seven groups with its read-only gate. Every new `projects` string exists in both
 * languages.
 */
import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { MantineProvider } from "@mantine/core";
import type {
	ProjectAttentionResponse,
	ProjectSessionPage,
	TeamCard,
} from "@shared/project-overview";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import en from "../../locales/en/projects.json";
import zh from "../../locales/zh-CN/projects.json";

mock.module("@tanstack/react-router", () => ({
	Link: ({
		to,
		params,
		children,
		...rest
	}: {
		to: string;
		params?: Record<string, string>;
		children?: ReactNode;
	}) => {
		let href = to;
		for (const [key, value] of Object.entries(params ?? {})) href = href.replace(`$${key}`, value);
		return (
			<a href={href} {...rest}>
				{children}
			</a>
		);
	},
	useNavigate: () => () => {},
}));
let canManage = false;
mock.module("../../hooks/useProjectAccess", () => ({
	useProjectAccess: () => ({ data: { canManage, members: [] }, isError: false, isLoading: false }),
	installProjectAccessListener: () => {},
}));
mock.module("../../hooks/useProjects", () => ({
	useProject: () => ({
		isLoading: false,
		isError: false,
		data: { id: "p", name: "acme-app", gitPath: "/home/me/code/acme-app", chapterSettings: {} },
	}),
	useUpdateProject: () => ({ mutate: () => {}, isPending: false, error: null }),
}));
// The live activity subscription (a socket) is replaced by what it would have delivered.
const activityRequests: string[][] = [];
let liveActivity = new Map<string, unknown>();
mock.module("../dashboard/useNarratorActivity", () => ({
	useNarratorActivity: (ids: readonly string[]) => {
		activityRequests.push([...ids]);
		return liveActivity;
	},
}));
mock.module("./ProjectAccessPanel", () => ({
	ProjectAccessPanel: () => <div data-access-panel />,
}));
mock.module("./ProjectSkillsManager", () => ({
	ProjectSkillsManager: ({ enabled }: { enabled: boolean }) => (
		<div data-skills-manager={enabled ? "editable" : "read-only"} />
	),
}));
mock.module("./ProjectRoutinesList", () => ({
	ProjectRoutinesList: ({ canManage }: { canManage: boolean }) => (
		<div data-routines={canManage ? "editable" : "read-only"} />
	),
}));
mock.module("../settings/TraitLayerEditor", () => ({
	TraitLayerEditor: () => <div data-trait-layer />,
}));
mock.module("../common/CommandsEditor", () => ({
	CommandsEditor: () => <div data-commands-editor />,
}));
mock.module("../permissions/PermissionRuleEditor", () => ({
	PermissionRuleEditor: () => <div data-rule-editor />,
}));

const { ProjectTeamCards } = await import("./ProjectTeamCards");
const { ProjectSessions } = await import("./ProjectSessions");
const { ProjectAttention } = await import("./ProjectAttention");
const { ProjectListCard } = await import("./ProjectListCard");
const { groupOfHash, ProjectSettingsPage } = await import("./ProjectSettingsPage");
const { projectOverviewKeys } = await import("../../hooks/useProjectOverview");

async function render(node: ReactNode, client = new QueryClient(), lng: "en" | "zh-CN" = "zh-CN") {
	const i18n = createInstance();
	await i18n.init({
		lng,
		resources: { en: { projects: en }, "zh-CN": { projects: zh } },
		defaultNS: "projects",
		interpolation: { escapeValue: false },
	});
	return renderToStaticMarkup(
		<I18nextProvider i18n={i18n}>
			<QueryClientProvider client={client}>
				<MantineProvider>{node}</MantineProvider>
			</QueryClientProvider>
		</I18nextProvider>,
	);
}

const team = (id: string, patch: Partial<TeamCard> = {}): TeamCard => ({
	id,
	projectId: "p",
	name: id,
	baseBranch: "main",
	status: "active",
	coordinatorStatus: "working",
	createdBy: null,
	createdAt: "",
	updatedAt: "",
	access: "write",
	briefBytes: 0,
	card: {
		columnCounts: { queued: 0, in_progress: 4, review: 1, done: 4, cancelled: 0 },
		readyCount: 1,
		runningCount: 4,
		pendingApprovalCount: 2,
		coordinatorStopReason: null,
		coordinatorMessageCount: 3,
		lastEventAt: null,
	},
	...patch,
});

function seededTeams(teams: TeamCard[]) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	client.setQueryData(projectOverviewKeys.teamCards("p"), {
		pages: [{ teams, nextCursor: null }],
		pageParams: [undefined],
	});
	return client;
}

describe("team cards", () => {
	test("each card: name, status sentence, numbers and what waits for this member", async () => {
		const html = await render(
			<ProjectTeamCards projectId="p" canCreate onOpenTeam={() => {}} onCreate={() => {}} />,
			seededTeams([team("发布小组"), team("旁观小组", { access: "read" })]),
		);
		expect(html.match(/data-testid="project-team-card"/g)).toHaveLength(2);
		expect(html).toContain("4 项进行中");
		expect(html).toContain("3 项等你");
		expect(html).toContain("3 等你");
		expect(html.match(/data-testid="team-card-waiting"/g)).toHaveLength(1);
		expect(html).toContain('data-testid="team-card-inProgress"');
		expect(html).toContain("就绪");
		// The dashed 「新团队」 card, for writers only.
		expect(html).toContain('data-testid="new-team"');
		const reader = await render(
			<ProjectTeamCards
				projectId="p"
				canCreate={false}
				onOpenTeam={() => {}}
				onCreate={() => {}}
			/>,
			seededTeams([team("发布小组")]),
		);
		expect(reader).not.toContain('data-testid="new-team"');
	});

	test("no teams: one line and a button", async () => {
		const html = await render(
			<ProjectTeamCards projectId="p" canCreate onOpenTeam={() => {}} onCreate={() => {}} />,
			seededTeams([]),
		);
		expect(html).toContain('data-testid="project-teams-empty"');
		expect(html).toContain("还没有团队");
		expect(html).not.toContain('data-testid="project-team-card"');
	});
});

describe("sessions", () => {
	test("进行中: running sessions are the home page's cards with their recent tool calls", async () => {
		const page: ProjectSessionPage = {
			items: [
				{
					id: "s1",
					title: "调研缓存方案",
					status: "waiting",
					group: "running",
					updatedAt: new Date().toISOString(),
					owner: { userId: "u", username: "zhouning", avatarColor: null, avatarImageId: null },
					activity: { toolName: "Edit", preview: "docs/adr.md", at: "" },
					cwd: "/home/me/code/acme-app",
					substatus: [],
				},
				{
					id: "s2",
					title: "修复登录页样式",
					status: "idle",
					group: "recent",
					updatedAt: new Date().toISOString(),
					owner: null,
					activity: null,
					cwd: null,
					substatus: [],
				},
			],
			nextCursor: null,
			counts: { active: 2, all: 41, mine: 1000 },
		};
		const client = new QueryClient();
		client.setQueryData(projectOverviewKeys.sessions("p", "active"), {
			pages: [page],
			pageParams: [undefined],
		});
		activityRequests.length = 0;
		liveActivity = new Map([
			[
				"s1",
				{
					status: "waiting",
					tools: [
						{
							toolUseId: "t1",
							toolName: "Bash",
							status: "running",
							inputSummary: { command: "pnpm typecheck" },
						},
					],
				},
			],
		]);
		const html = await render(<ProjectSessions projectId="p" phone={false} />, client);
		liveActivity = new Map();
		expect(html).toContain("进行中");
		// The running session is a dashboard card (its directory row, its tool calls) inside the
		// card grid, subscribed for activity; the recent one is a compact row after it.
		const cards = html.indexOf('data-testid="project-running-cards"');
		expect(cards).toBeGreaterThan(-1);
		expect(html.indexOf('href="/narrators/s1"')).toBeGreaterThan(cards);
		expect(html).toContain("acme-app");
		expect(html).toContain("pnpm typecheck");
		expect(activityRequests.at(-1)).toEqual(["s1"]);
		// The card shows the activity: no second, hand-built "what it is doing" line for it.
		expect(html).not.toContain("等批准编辑文件");
		expect(html).toContain(">41<");
		expect(html).toContain("999+");
		const first = html.indexOf('href="/narrators/s1"');
		const recent = html.indexOf('data-testid="project-sessions-recent"');
		expect(first).toBeGreaterThan(-1);
		expect(recent).toBeGreaterThan(first);
		expect(html.indexOf('href="/narrators/s2"')).toBeGreaterThan(recent);
	});

	test("at most 12 cards (and subscriptions) before 「显示全部」", async () => {
		const running = Array.from({ length: 15 }, (_, index) => ({
			id: `r${index}`,
			title: `running ${index}`,
			status: "working",
			group: "running" as const,
			updatedAt: new Date().toISOString(),
			owner: null,
			activity: null,
			cwd: null,
			substatus: [],
		}));
		const client = new QueryClient();
		client.setQueryData(projectOverviewKeys.sessions("p", "active"), {
			pages: [{ items: running, nextCursor: null, counts: { active: 15, all: 15, mine: 0 } }],
			pageParams: [undefined],
		});
		activityRequests.length = 0;
		const html = await render(<ProjectSessions projectId="p" phone={false} />, client);
		expect(html.match(/href="\/narrators\/r\d+"/g)).toHaveLength(12);
		expect(activityRequests.at(-1)).toHaveLength(12);
		expect(html).toContain('data-testid="project-running-show-all"');
		expect(html).toContain("显示全部 15 个");
	});

	test("nothing running: no card grid, one line", async () => {
		const client = new QueryClient();
		client.setQueryData(projectOverviewKeys.sessions("p", "active"), {
			pages: [{ items: [], nextCursor: null, counts: { active: 0, all: 1, mine: 0 } }],
			pageParams: [undefined],
		});
		const html = await render(<ProjectSessions projectId="p" phone={false} />, client);
		expect(html).not.toContain("project-running-cards");
		expect(html).toContain("没有运行中的会话");
	});
});

describe("attention", () => {
	const response: ProjectAttentionResponse = {
		entries: [
			{
				kind: "approval",
				approval: {
					id: "c1",
					agent: { id: "w1", title: "支付 SDK 迁移", status: "waiting" },
					depth: 1,
					toolName: "Bash",
					kind: "tool",
					preview: "pnpm add @acme/pay-sdk",
					questions: [],
					decisionReason: null,
					createdAt: new Date().toISOString(),
				},
				source: { kind: "team", teamId: "t1", name: "发布小组" },
			},
			{
				kind: "approval",
				approval: {
					id: "c2",
					agent: { id: "s1", title: "调研缓存方案", status: "waiting" },
					depth: 0,
					toolName: "Edit",
					kind: "tool",
					preview: "docs/adr.md",
					questions: [],
					decisionReason: null,
					createdAt: new Date().toISOString(),
				},
				source: { kind: "session", narratorId: "s1", title: "调研缓存方案", ownerName: "周宁" },
			},
		],
		more: false,
		unscanned: false,
	};

	test("cards name their team or whose session it is, with approve and deny in place", async () => {
		const client = new QueryClient();
		client.setQueryData(projectOverviewKeys.attention("p"), response);
		const html = await render(<ProjectAttention projectId="p" enabled phone={false} />, client);
		expect(html.match(/data-testid="team-attention-card"/g)).toHaveLength(2);
		expect(html).toContain('data-testid="attention-source-team"');
		expect(html).toContain("发布小组");
		expect(html).toContain("周宁的会话");
		expect(html.match(/data-testid="team-approval-approve"/g)).toHaveLength(2);
		// A plain session asks for itself: no "the worker asks".
		expect(html).toContain("调研缓存方案");
		expect(html).toContain("请求编辑文件");
		expect(html).toContain("的工作者请求运行命令");
	});

	test("no inner scroll on a desktop; on a phone the cards scroll sideways with dots", async () => {
		const client = new QueryClient();
		client.setQueryData(projectOverviewKeys.attention("p"), response);
		const desktop = await render(<ProjectAttention projectId="p" enabled phone={false} />, client);
		expect(desktop).toContain('data-attention-layout="desktop"');
		expect(desktop).not.toContain("mantine-ScrollArea");
		const phone = await render(<ProjectAttention projectId="p" enabled phone />, client);
		expect(phone).toContain('data-attention-layout="phone"');
		expect(phone).toContain("左右滑动");
	});

	test("hidden when nothing waits, and for a non-member", async () => {
		const client = new QueryClient();
		client.setQueryData(projectOverviewKeys.attention("p"), { ...response, entries: [] });
		expect(
			await render(<ProjectAttention projectId="p" enabled phone={false} />, client),
		).not.toContain("team-attention");
		const full = new QueryClient();
		full.setQueryData(projectOverviewKeys.attention("p"), response);
		expect(
			await render(<ProjectAttention projectId="p" enabled={false} phone={false} />, full),
		).not.toContain("team-attention");
	});
});

describe("project list card", () => {
	test("name, path tail, running sessions, teams, waiting badge and last activity", async () => {
		const now = new Date("2026-11-25T12:00:00Z");
		const html = await render(
			<ProjectListCard
				project={{ id: "p", name: "acme-app", gitPath: "/home/me/code/acme-app" }}
				summary={{
					projectId: "p",
					runningSessionCount: 3,
					teamCount: 2,
					waitingCount: 4,
					lastActivityAt: "2026-11-25T11:52:00Z",
					capped: false,
				}}
				now={now}
			/>,
		);
		expect(html).toContain('href="/projects/p"');
		expect(html).toContain("…/code/acme-app");
		expect(html).toContain("3 个进行中会话");
		expect(html).toContain("2 个团队");
		expect(html).toContain("4 等你");
		expect(html).toContain("8 分钟前");
		const quiet = await render(
			<ProjectListCard
				project={{ id: "q", name: "docs", gitPath: null }}
				summary={{
					projectId: "q",
					runningSessionCount: 0,
					teamCount: 0,
					waitingCount: 0,
					lastActivityAt: null,
					capped: false,
				}}
				now={now}
			/>,
			undefined,
			"en",
		);
		expect(quiet).toContain("No active sessions");
		const capped = await render(
			<ProjectListCard
				project={{ id: "c", name: "busy", gitPath: null }}
				summary={{
					projectId: "c",
					runningSessionCount: 500,
					teamCount: 0,
					waitingCount: 3,
					lastActivityAt: null,
					capped: true,
				}}
				now={now}
			/>,
		);
		expect(capped).toContain(">3+ 等你<");
		expect(quiet).not.toContain('data-testid="project-card-waiting"');
		expect(quiet).not.toContain('data-testid="project-card-teams"');
	});
});

describe("settings page", () => {
	test("seven groups; editing only with verified management permission", async () => {
		canManage = false;
		const readOnly = await render(<ProjectSettingsPage projectId="p" />);
		const groups = [...readOnly.matchAll(/data-testid="project-settings-([a-z-]+)"/g)]
			.map((match) => match[1])
			.filter((group) => !["page", "nav", "back", "crumb"].includes(group as string));
		expect(groups).toEqual([
			"read-only",
			"members",
			"skills",
			"routines",
			"commands",
			"workspace",
			"devices",
			"knowledge",
		]);
		expect(readOnly).toContain('data-skills-manager="read-only"');
		expect(readOnly).toContain('data-routines="read-only"');
		expect(readOnly).not.toContain("data-rule-editor");
		expect(readOnly).not.toContain("data-commands-editor");
		for (const href of ["/settings/workspace", "/settings/devices", "/knowledge"])
			expect(readOnly).toContain(`href="${href}"`);

		canManage = true;
		const editable = await render(<ProjectSettingsPage projectId="p" />);
		expect(editable).not.toContain("project-settings-read-only");
		expect(editable).toContain('data-skills-manager="editable"');
		expect(editable.match(/data-rule-editor/g)).toHaveLength(4);
		expect(editable).toContain("data-commands-editor");
		expect(editable).toContain("data-trait-layer");
	});
});

describe("settings page anchors", () => {
	test("#settings-<group> names a group; anything else names none", () => {
		expect(groupOfHash("#settings-members")).toBe("members");
		expect(groupOfHash("settings-knowledge")).toBe("knowledge");
		expect(groupOfHash("#settings-nope")).toBeNull();
		expect(groupOfHash("")).toBeNull();
	});
});

describe("strings", () => {
	test("every key the new project components use exists in both locales", () => {
		const files = [
			"ProjectHeader.tsx",
			"ProjectAttention.tsx",
			"ProjectTeamCards.tsx",
			"ProjectSessions.tsx",
			"ProjectListCard.tsx",
			"ProjectSettingsPage.tsx",
			"ProjectSettingsForms.tsx",
			"ProjectRoutinesList.tsx",
			"ProjectSettingsPanel.tsx",
		];
		const keys = new Set<string>();
		for (const file of files) {
			const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
			for (const match of source.matchAll(/\bt\(\s*"([^"]+)"/g)) keys.add(match[1] as string);
		}
		// Template keys: each group, view and mode.
		for (const group of [
			"members",
			"skills",
			"routines",
			"commands",
			"workspace",
			"devices",
			"knowledge",
		])
			for (const part of ["title", "description"]) keys.add(`settingsPage.groups.${group}.${part}`);
		for (const view of ["active", "all", "mine"]) {
			keys.add(`page.sessions.views.${view}`);
			keys.add(`page.sessions.empty.${view}`);
		}
		for (const mode of ["resident", "manual", "auto"])
			keys.add(`settingsPage.routines.modes.${mode}`);
		for (const key of ["inProgress", "ready", "done"]) keys.add(`page.teams.numbers.${key}`);
		for (const key of ["justNow", "minutes", "hours", "yesterday", "days", "never"])
			keys.add(`list.activity.${key}`);
		const lookup = (resources: unknown, key: string) => {
			const node = key
				.split(".")
				.reduce<unknown>(
					(n, part) => (n as Record<string, unknown> | undefined)?.[part],
					resources,
				);
			if (typeof node === "string") return node;
			const plural = (resources as Record<string, unknown>) && key.split(".");
			const parent = plural
				.slice(0, -1)
				.reduce<unknown>(
					(n, part) => (n as Record<string, unknown> | undefined)?.[part],
					resources,
				) as Record<string, unknown> | undefined;
			return parent?.[`${plural.at(-1)}_other`];
		};
		for (const [locale, resources] of [
			["en", en],
			["zh-CN", zh],
		] as const)
			for (const key of keys)
				expect({ locale, key, translated: typeof lookup(resources, key) === "string" }).toEqual({
					locale,
					key,
					translated: true,
				});
	});
});
