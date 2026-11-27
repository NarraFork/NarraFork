/**
 * The project list page (R2) with the real Mantine: the title, the search box and 「新建项目」
 * stay available while the list loads (skeleton); an empty list says so; loaded projects are
 * cards in the list's order — projects with something waiting on you first, then by the most
 * recent activity — each with its waiting badge and numbers from the one summary request.
 */
import { afterEach, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import type { ProjectListSummary } from "@shared/project-overview";
import type { ComponentType, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

let loading = true;
let projects: Record<string, unknown>[] = [];
let summaries: ProjectListSummary[] | undefined;
const summaryRequests: boolean[] = [];

mock.module("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: { count?: number }) =>
			options?.count === undefined ? key : `${key}:${options.count}`,
		i18n: { language: "en", resolvedLanguage: "en" },
	}),
}));
mock.module("@tanstack/react-router", () => ({
	createFileRoute: () => (options: { component: ComponentType }) => ({ options }),
	Link: ({
		children,
		params,
		...rest
	}: {
		children?: ReactNode;
		params?: { projectId?: string };
	}) => (
		<a href={`/projects/${params?.projectId ?? ""}`} {...rest}>
			{children}
		</a>
	),
}));
mock.module("../../frontend/hooks/useProjects", () => ({
	useProjects: () => ({ data: loading ? undefined : projects, isLoading: loading }),
	useHiddenProjectExistence: () => ({ data: { hasHidden: false } }),
	useCreateProject: () => ({ isPending: false, error: null, reset: mock(), mutate: mock() }),
	useCreateProjectStream: () => ({
		isPending: false,
		error: null,
		cloneProgress: "",
		needsAuth: false,
		reset: mock(),
		mutate: mock(),
		retryWithCredentials: mock(),
	}),
}));
mock.module("../../frontend/hooks/useProjectOverview", () => ({
	useProjectSummaries: (enabled: boolean) => {
		summaryRequests.push(enabled);
		return { data: summaries ? { summaries } : undefined };
	},
}));
mock.module("../../frontend/hooks/usePlatform", () => ({ usePlatform: () => "linux" }));
mock.module("../../frontend/hooks/useSetupWizardGuard", () => ({
	useSetupWizardGuard: () => () => true,
}));

const { Route } = await import("../../frontend/routes/projects/index");
const Page = Route.options.component as ComponentType;
const render = () =>
	renderToStaticMarkup(
		<MantineProvider>
			<Page />
		</MantineProvider>,
	);

afterEach(() => {
	loading = true;
	projects = [];
	summaries = undefined;
	summaryRequests.length = 0;
});

test("title and 新建项目 stay available during the first load; an empty list says so", () => {
	const first = render();
	expect(first).toContain("title");
	expect(first).toContain("newProject");
	expect(first).toContain('data-testid="project-list-skeleton"');
	// No summary request before there is a list.
	expect(summaryRequests.every((enabled) => !enabled)).toBe(true);

	loading = false;
	const empty = render();
	expect(empty).toContain("newProject");
	expect(empty).not.toContain('data-testid="project-list-skeleton"');
	expect(empty).toContain("noProjects");
});

test("cards: waiting first, then the most recent activity; badge and numbers from the summary", () => {
	loading = false;
	const project = (id: string, updatedAt: string) => ({
		id,
		name: id,
		gitPath: `/home/me/code/${id}`,
		status: "active",
		updatedAt,
	});
	projects = [
		project("recent", "2026-11-25T10:00:00Z"),
		project("old-waiting", "2026-10-01T00:00:00Z"),
		project("quiet", "2026-11-24T00:00:00Z"),
	];
	const summary = (projectId: string, waitingCount: number, lastActivityAt: string) => ({
		projectId,
		runningSessionCount: projectId === "recent" ? 3 : 0,
		teamCount: projectId === "recent" ? 2 : 0,
		waitingCount,
		lastActivityAt,
		capped: false,
	});
	summaries = [
		summary("recent", 0, "2026-11-25T10:00:00Z"),
		summary("old-waiting", 4, "2026-10-01T00:00:00Z"),
		summary("quiet", 0, "2026-11-24T00:00:00Z"),
	];
	const html = render();
	expect(summaryRequests).toContain(true);
	const order = [...html.matchAll(/data-project-id="([^"]+)"/g)].map((match) => match[1]);
	expect(order).toEqual(["old-waiting", "recent", "quiet"]);
	expect(html.match(/data-testid="project-card-waiting"/g)).toHaveLength(1);
	expect(html).toContain("page.waitingBadge:4");
	expect(html).toContain("list.runningSessions:3");
	expect(html).toContain("list.teams:2");
	expect(html).toContain("…/code/recent");
	expect(html).toContain("list.subtitle");
});
