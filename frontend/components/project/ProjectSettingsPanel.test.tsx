import { afterEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

let canManage = false;
let projectUnavailable = false;
let accessUnavailable = false;
mock.module("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: { name?: string; path?: string }) =>
			options?.name || options?.path ? `${key}:${options.name || options.path}` : key,
	}),
}));
mock.module("@tanstack/react-router", () => ({
	Link: ({
		to,
		params,
		search,
		children,
		...rest
	}: {
		to: string;
		params?: { narratorId?: string };
		search?: { create?: boolean };
		children?: ReactNode;
	}) => (
		<a
			{...rest}
			href={
				params?.narratorId
					? to.replace("$narratorId", params.narratorId)
					: `${to}${search?.create ? "?create=true" : ""}`
			}
		>
			{children}
		</a>
	),
}));
mock.module("../../hooks/useProjects", () => ({
	useProject: () => ({
		isLoading: false,
		isError: projectUnavailable,
		data: projectUnavailable
			? undefined
			: { id: "original", name: "original-source", proxyDomain: null, chapterSettings: {} },
	}),
}));
mock.module("../../hooks/useProjectAccess", () => ({
	useProjectAccess: () => ({ data: { canManage, members: [] }, isError: accessUnavailable }),
}));
mock.module("../../hooks/useAuth", () => ({ useCurrentUser: () => ({ data: { id: "viewer" } }) }));
mock.module("./ProjectAccessPanel", () => ({
	ProjectAccessPanel: ({ projectId }: { projectId: string }) => (
		<div data-access-source={projectId}>access</div>
	),
}));
const { ProjectSettingsPanel } = await import("./ProjectSettingsPanel");
const { DashboardSessions } = await import("../dashboard/DashboardSessions");
const { NarratorListCard } = await import("../narrator/list/NarratorListCard");

afterEach(() => {
	canManage = false;
	projectUnavailable = false;
	accessUnavailable = false;
});

function render(children: ReactNode) {
	const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	query.setQueryData(["dashboard", "summary"], {
		activeProjectCount: 123,
		todayTokens: { total: 10 },
		workingNarratorCount: 1,
		waitingNarratorCount: 2,
		runningTerminalCount: 3,
		enabledScheduledTaskCount: 4,
	});
	return renderToStaticMarkup(
		<MantineProvider>
			<QueryClientProvider client={query}>{children}</QueryClientProvider>
		</MantineProvider>,
	);
}

describe("project settings panel", () => {
	test("exposes project, ACL, workspace, device and knowledge paths in read-only mode", () => {
		const html = render(<ProjectSettingsPanel projectId="original" />);
		expect(html).toContain("original-source");
		expect(html).toContain('data-access-source="original"');
		expect(html).toContain("compatibility.readOnly");
		expect(html.match(/disabled=""/g)?.length).toBe(4);
		for (const path of ["/settings/chapters", "/settings/devices", "/knowledge"])
			expect(html).toContain(`href="${path}"`);
	});
	test("only verified canManage enables the existing project editors", () => {
		canManage = true;
		const html = render(<ProjectSettingsPanel projectId="original" />);
		expect(html).toContain("compatibility.manage");
		expect(html).not.toContain('disabled=""');
		for (const key of ["compatibility.settingsTraits", "skills", "routines", "commands"])
			expect(html).toContain(key);
	});
	test("failed permission refresh does not keep stale management controls enabled", () => {
		canManage = true;
		accessUnavailable = true;
		const html = render(<ProjectSettingsPanel projectId="original" />);
		expect(html).toContain("compatibility.accessUnavailable");
		expect(html.match(/disabled=""/g)?.length).toBe(4);
	});
	test("load errors are terminal and never show an editor or spinner", () => {
		projectUnavailable = true;
		const html = render(<ProjectSettingsPanel projectId="original" />);
		expect(html).toContain("compatibility.unavailable");
		expect(html).not.toContain("compatibility.settingsTraits");
	});
	test("narrator entry lazy-loads the panel", () => {
		const entry = readFileSync(new URL("./NarratorProjectSettings.tsx", import.meta.url), "utf8");
		expect(entry).not.toMatch(/import\s+\{\s*ProjectSettingsPanel\s*\}\s+from/);
		expect(entry).toContain('import("./ProjectSettingsPanel")');
		expect(entry).toContain("<Suspense");
	});
});

describe("ordinary entry points", () => {
	test("dashboard no longer promotes project creation or project counts", () => {
		const html = render(
			<DashboardSessions
				data={
					{
						groups: {
							attention: [],
							running: [],
							recent: [
								{ narratorId: "recent-1", title: "recent", cwd: null, status: "idle", time: null },
							],
						},
						activity: new Map(),
						attention: { isError: false, hasNextPage: false },
						isLoading: false,
						// biome-ignore lint/suspicious/noExplicitAny: only the fields the view reads
					} as any
				}
			/>,
		);
		expect(html).not.toContain('href="/projects"');
		expect(html).not.toContain("newProject");
		expect(html).not.toContain("activeProjects");
		expect(html).toContain('href="/narrators"');
		expect(html).toContain('href="/narrators/recent-1"');
	});
	test.each([
		["model_unavailable", "status.narratorModelUnavailable"],
		["quota_exhausted", "status.narratorQuotaExhausted"],
	])("list status %s retains a distinct accessible label on desktop and mobile", (substatus, label) => {
		const html = render(
			<NarratorListCard
				variant="active"
				narrator={{
					id: "status-session",
					title: "Status session",
					status: "waiting",
					substatus: [substatus],
					createdAt: "2026-01-01T00:00:00Z",
				}}
				localQuery=""
				defaultModelValue="model"
				onOpen={() => {}}
				onArchive={() => {}}
			/>,
		);
		expect(html.split(`aria-label="${label}"`).length - 1).toBe(2);
	});
	test("project and legacy chapter routes have no destructive mutations or canvas mounts", () => {
		for (const path of [
			"../../routes/projects/$projectId.tsx",
			"../../routes/chapters/$chapterId.tsx",
		]) {
			const source = readFileSync(new URL(path, import.meta.url), "utf8");
			for (const forbidden of ["createNarrator", "deleteProject", "<NarraFlow", "<RulerFlow"])
				expect(source).not.toContain(forbidden);
		}
		const shell = readFileSync(new URL("../AuthenticatedAppLayout.tsx", import.meta.url), "utf8");
		expect(shell).not.toContain('filter="project"');
		expect(shell).not.toContain('to="/projects"');
	});
});
