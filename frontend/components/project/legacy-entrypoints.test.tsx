import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
	buildNarratorListQueryOptions,
	getNarratorListState,
} from "../narrator/list/narrator-list-utils";

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
const { ProjectCompatibilityPanel } = await import("./ProjectCompatibilityPanel");
const { LegacyResourceRecovery } = await import("./LegacyResourceRecovery");
const { api } = await import("../../lib/api");
const { QuickActions } = await import("../dashboard/QuickActions");
const { StatsRow } = await import("../dashboard/StatsRow");
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

describe("compatibility settings shell", () => {
	test("exposes original source, ACL, workspace, device and knowledge paths in read-only mode", () => {
		const html = render(<ProjectCompatibilityPanel projectId="original" />);
		expect(html).toContain("original-source");
		expect(html).toContain('data-access-source="original"');
		expect(html).toContain("compatibility.readOnly");
		expect(html.match(/disabled=""/g)?.length).toBe(4);
		for (const path of ["/settings/chapters", "/settings/devices", "/knowledge"])
			expect(html).toContain(`href="${path}"`);
	});
	test("resource recovery is directly reachable without a primary session and does not mutate on render", () => {
		const wake = spyOn(api, "wakeChapter");
		const create = spyOn(api, "createChapter");
		const remove = spyOn(api, "deleteChapter");
		try {
			const html = render(
				<LegacyResourceRecovery chapterId="empty-resource" projectId="original" status="dormant" />,
			);
			expect(html).toContain("compatibility.recovery");
			expect(wake).not.toHaveBeenCalled();
			expect(create).not.toHaveBeenCalled();
			expect(remove).not.toHaveBeenCalled();
		} finally {
			wake.mockRestore();
			create.mockRestore();
			remove.mockRestore();
		}
	});
	test("only verified canManage enables the existing project editors", () => {
		canManage = true;
		const html = render(<ProjectCompatibilityPanel projectId="original" />);
		expect(html).toContain("compatibility.manage");
		expect(html).not.toContain('disabled=""');
		for (const key of ["compatibility.settingsTraits", "skills", "routines", "commands"])
			expect(html).toContain(key);
	});
	test("failed permission refresh does not keep stale management controls enabled", () => {
		canManage = true;
		accessUnavailable = true;
		const html = render(<ProjectCompatibilityPanel projectId="original" />);
		expect(html).toContain("compatibility.accessUnavailable");
		expect(html.match(/disabled=""/g)?.length).toBe(4);
	});
	test("load errors are terminal and never show an editor or spinner", () => {
		projectUnavailable = true;
		const html = render(<ProjectCompatibilityPanel projectId="original" />);
		expect(html).toContain("compatibility.unavailable");
		expect(html).not.toContain("compatibility.settingsTraits");
	});
});

describe("ordinary entry points and retained legacy sessions", () => {
	test.each([
		undefined,
		"archived",
	])("list status %s retains all legacy sessions and existing filters", (status) => {
		const options = buildNarratorListQueryOptions(
			getNarratorListState({
				filter: "chapter",
				hasContainers: true,
				hasRunningContainers: true,
				hasTerminals: true,
				hasViewers: true,
				sortBy: "createdAt",
				sortOrder: "asc",
			}),
			status,
		);
		expect(options).toMatchObject({
			standalone: "all",
			filter: "chapter",
			hasContainers: true,
			hasRunningContainers: true,
			hasTerminals: true,
			hasViewers: true,
			sortBy: "createdAt",
			sortOrder: "asc",
		});
		expect(options.status).toBe(status);
	});
	test("dashboard no longer promotes project creation or project counts", () => {
		const html = render(
			<>
				<QuickActions />
				<StatsRow />
			</>,
		);
		expect(html).not.toContain('href="/projects"');
		expect(html).not.toContain("newProject");
		expect(html).not.toContain("activeProjects");
		expect(html).toContain('href="/narrators"');
		expect(html).toContain("newSession");
		expect(html).toContain('href="/narrators?create=true"');
	});
	test("legacy chapter-bound cards remain visible on desktop/mobile and archived deep links target the narrator", () => {
		const sideEffect = mock(() => {});
		const narrator = {
			id: "old-session",
			title: "old-visible-session",
			status: "idle",
			cwd: "/old-worktree",
			createdAt: "2026-01-01T00:00:00Z",
			chapter: {
				id: "old-chapter",
				title: "old-resource",
				projectId: "original",
				projectName: "old-project",
				status: "dormant",
				role: "branch",
			},
		};
		const active = render(
			<NarratorListCard
				variant="active"
				narrator={narrator}
				localQuery=""
				defaultModelValue="model"
				onOpen={sideEffect}
				onArchive={sideEffect}
			/>,
		);
		expect(active.match(/>old-visible-session</g)?.length).toBe(2);
		expect(active.match(/\/old-worktree/g)?.length).toBe(2);
		const archived = render(
			<NarratorListCard
				variant="archived"
				narrator={narrator}
				localQuery=""
				defaultModelValue="model"
				onUnarchive={sideEffect}
				onDelete={sideEffect}
			/>,
		);
		expect(archived).toContain('href="/narrators/old-session"');
		expect(sideEffect).not.toHaveBeenCalled();
	});
	test("detail routes do not duplicate header compatibility entry or eagerly import legacy settings", () => {
		const entry = readFileSync(
			new URL("./NarratorCompatibilityEntry.tsx", import.meta.url),
			"utf8",
		);
		expect(entry).not.toMatch(/import\s+\{\s*ProjectCompatibilityPanel\s*\}\s+from/);
		expect(entry).toContain('import("./ProjectCompatibilityPanel")');
		expect(entry).toContain("<Suspense");
		const detail = readFileSync(
			new URL("../../routes/narrators/$narratorId.tsx", import.meta.url),
			"utf8",
		);
		expect(detail).not.toContain("NarratorCompatibilityEntry");
	});
	test("retired routes have no create/delete/worktree-cleanup mutations or canvas mounts", () => {
		for (const path of [
			"../../routes/projects/$projectId.tsx",
			"../../routes/chapters/$chapterId.tsx",
		]) {
			const source = readFileSync(new URL(path, import.meta.url), "utf8");
			for (const forbidden of [
				"createNarrator",
				"createChapter",
				"deleteProject",
				"deleteChapter",
				"ChapterCleanupModal",
				"<NarraFlow",
				"<RulerFlow",
			])
				expect(source).not.toContain(forbidden);
		}
		const shell = readFileSync(new URL("../AppRootLayout.tsx", import.meta.url), "utf8");
		expect(shell).not.toContain('filter="project"');
		expect(shell).not.toContain('to="/projects"');
	});
});
