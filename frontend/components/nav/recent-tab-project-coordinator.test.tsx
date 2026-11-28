/**
 * Two sidebar details that tell tabs apart:
 * - a project tab's hover card shows its directory, the sessions running or waiting there and
 *   its teams (runtime state from `recent-tab-projects.ts`), not only the name;
 * - a coordinator's session tab, which can sit next to its team's tab with the same title, is
 *   labelled "coordinator" in the row and in its card. It stays a session tab.
 */
import { describe, expect, test } from "bun:test";
import { isCoordinatorSessionTab, type RecentTab } from "@frontend/hooks/recent-tabs-utils";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import commonEn from "../../locales/en/common.json";
import navEn from "../../locales/en/nav.json";
import commonZh from "../../locales/zh-CN/common.json";
import navZh from "../../locales/zh-CN/nav.json";
import { RecentTabDetails } from "./RecentTabDetailCard";
import { RecentTabTitle } from "./RecentTabs";

async function render(node: ReactNode, lng: "en" | "zh-CN" = "en"): Promise<string> {
	const i18n = createInstance();
	await i18n.init({
		lng,
		fallbackLng: "en",
		initImmediate: false,
		interpolation: { escapeValue: false },
		resources: {
			en: { common: commonEn, nav: navEn },
			"zh-CN": { common: commonZh, nav: navZh },
		},
	});
	return renderToStaticMarkup(
		<QueryClientProvider client={new QueryClient()}>
			<I18nextProvider i18n={i18n}>
				<MantineProvider>{node}</MantineProvider>
			</I18nextProvider>
		</QueryClientProvider>,
	);
}

const project: RecentTab = { type: "project", id: "p1", title: "Acme App", lastVisitedAt: 1 };

describe("a project tab's card", () => {
	test("shows the directory, running and waiting sessions and teams", async () => {
		const html = await render(
			<RecentTabDetails
				tab={{
					...project,
					projectPath: "/repos/acme-app",
					activeSessionCount: 3,
					waitingSessionCount: 1,
					teamCount: 2,
				}}
			/>,
		);
		expect(html).toContain("Acme App");
		expect(html).toContain("/repos/acme-app");
		expect(html).toContain("3 session(s) running");
		expect(html).toContain("1 waiting for input or approval");
		expect(html).toContain("2 team(s)");
	});

	test("says when nothing runs, and marks capped counts as lower bounds", async () => {
		const idle = await render(
			<RecentTabDetails
				tab={{ ...project, projectPath: "/r", activeSessionCount: 0, teamCount: 0 }}
			/>,
			"zh-CN",
		);
		expect(idle).toContain("没有进行中的会话");
		expect(idle).not.toContain("个团队");
		const capped = await render(
			<RecentTabDetails
				tab={{
					...project,
					activeSessionCount: 200,
					teamCount: 1,
					projectCountsCapped: true,
				}}
			/>,
		);
		expect(capped).toContain("200+ session(s) running");
	});

	test("without runtime state (not read yet, or unreadable) only the name", async () => {
		const html = await render(
			<RecentTabDetails tab={{ ...project, projectPath: null, activeSessionCount: null }} />,
		);
		expect(html).toContain("Acme App");
		expect(html).not.toContain("running");
		expect(html).not.toContain('data-testid="recent-tab-project-path"');
	});
});

describe("a coordinator's session tab", () => {
	const coordinator: RecentTab = {
		type: "narrator",
		id: "c1",
		title: "Release crew",
		lastVisitedAt: 1,
		teamSession: true,
	};

	test("only a narrator tab of a team session is a coordinator tab", () => {
		expect(isCoordinatorSessionTab(coordinator)).toBe(true);
		expect(isCoordinatorSessionTab({ ...coordinator, teamSession: false })).toBe(false);
		expect(isCoordinatorSessionTab({ ...coordinator, teamSession: undefined })).toBe(false);
		// Its subagents are subagent tabs; the team's own tab is a team tab.
		expect(isCoordinatorSessionTab({ ...coordinator, type: "subagent" })).toBe(false);
		expect(isCoordinatorSessionTab({ ...coordinator, type: "team" })).toBe(false);
	});

	test("the row is labelled coordinator; the team tab and plain sessions are not", async () => {
		const zh = await render(<RecentTabTitle tab={coordinator} />, "zh-CN");
		expect(zh).toContain("Release crew");
		expect(zh).toContain('data-testid="recent-tab-coordinator-label"');
		expect(zh).toContain("协调者");
		const en = await render(<RecentTabTitle tab={coordinator} />);
		expect(en).toContain("coordinator");
		for (const tab of [
			{ ...coordinator, type: "team" as const },
			{ ...coordinator, teamSession: false },
		]) {
			const html = await render(<RecentTabTitle tab={tab} />);
			expect(html).toContain("Release crew");
			expect(html).not.toContain("recent-tab-coordinator-label");
		}
	});

	test("its card says it is the team's coordinator session", async () => {
		const html = await render(<RecentTabDetails tab={coordinator} />);
		expect(html).toContain("The coordinator session of a team.");
	});
});

describe("a team tab (R2)", () => {
	const team: RecentTab = {
		type: "team",
		id: "t1",
		title: "发布小组",
		lastVisitedAt: 1,
		status: "working",
		pendingApprovalCount: 2,
		readyItemCount: 1,
	};

	test("an amber count at the row's end sums the calls and the items to accept", async () => {
		const html = await render(<RecentTabTitle tab={team} />, "zh-CN");
		expect(html).toContain('data-testid="team-tab-pending"');
		expect(html).toContain('aria-label="3 项等你处理"');
		expect(html).toMatch(/data-testid="team-tab-pending"[^>]*>3</);
		const none = await render(
			<RecentTabTitle tab={{ ...team, pendingApprovalCount: null, readyItemCount: null }} />,
		);
		expect(none).not.toContain("team-tab-pending");
	});

	test("its card lists the calls and the items ready to merge apart", async () => {
		const html = await render(<RecentTabDetails tab={team} />, "zh-CN");
		expect(html).toContain("2 项待批");
		expect(html).toContain("1 项可以合并");
	});
});
