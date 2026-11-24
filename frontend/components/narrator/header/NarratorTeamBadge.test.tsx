import { afterAll, describe, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import type { AnyRouter } from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { installCanvasStub } from "../vlist/measure/test-canvas-stub";

const disposeCanvas = installCanvasStub({ widthRatio: 0.6 });
afterAll(() => disposeCanvas());

const router = await import("@tanstack/react-router");
let currentRouter: AnyRouter | null = null;
mock.module("@tanstack/react-router", () => ({ ...router, useRouter: () => currentRouter }));
const reactI18next = await import("react-i18next");
mock.module("react-i18next", () => ({
	...reactI18next,
	useTranslation: () => ({
		t: (key: string, options?: { name?: string }) =>
			options?.name ? `${key}:${options.name}` : key === "teamBadge" ? "Team" : key,
	}),
}));
const { NarratorTeamBadge, useNarratorTeamBadge } = await import("./NarratorTeamBadge");
const { headerBadgeLayoutWidth } = await import("./header-title-width");

/** A router mounted under `basepath`, currently showing `path` (router space, no prefix). */
function routerAt(path: string, basepath = ""): AnyRouter {
	const root = router.createRootRoute();
	const routes = ["projects/$projectId/teams/$teamId", "narrators/$narratorId"].map((p) =>
		router.createRoute({ getParentRoute: () => root, path: p }),
	);
	return router.createRouter({
		routeTree: root.addChildren(routes),
		history: router.createMemoryHistory({ initialEntries: [`${basepath}${path}`] }),
		basepath,
	}) as unknown as AnyRouter;
}

type HookProps = Parameters<typeof useNarratorTeamBadge>[0];
const coordinator: HookProps = {
	narratorId: "coord-1",
	narrator: { traits: ["named", "team"], title: "发布小组" },
	projectId: "proj-1",
};

function Harness(props: HookProps) {
	const target = useNarratorTeamBadge(props);
	return target ? <NarratorTeamBadge target={target} /> : null;
}

function render(props: HookProps, at: AnyRouter | null = routerAt("/narrators/coord-1")) {
	currentRouter = at;
	return renderToStaticMarkup(
		<MantineProvider>
			<Harness {...props} />
		</MantineProvider>,
	);
}

describe("coordinator session team badge", () => {
	test("renders a labelled, fixed-width link for a coordinator and nothing otherwise", () => {
		const html = render(coordinator);
		expect(html).toContain('data-testid="narrator-team-badge"');
		expect(html).toContain('href="/projects/proj-1/teams/coord-1"');
		expect(html).toContain(">Team<");
		expect(html).toContain('aria-label="teamBadgeOpen:发布小组"');
		// Painted at exactly the width the header budgets.
		expect(html).toContain(`width:${headerBadgeLayoutWidth("Team", 12)}px`);
		for (const props of [
			{ narratorId: "n", narrator: { traits: [], title: "x" }, projectId: "proj-1" },
			{ narratorId: "n", narrator: { traits: "team", title: "x" }, projectId: "proj-1" },
			{ narratorId: "n", narrator: { traits: ["team"], title: "x" }, projectId: undefined },
			{ narratorId: "n", narrator: undefined, projectId: "proj-1" },
			{ ...coordinator, enabled: false },
		])
			expect(render(props)).not.toContain("narrator-team-badge");
	});

	test("path segments are encoded in the href", () => {
		const html = render({ ...coordinator, narratorId: "a/b", projectId: "p q" });
		expect(html).toContain('href="/projects/p%20q/teams/a%2Fb"');
	});

	test("outside a router there is nowhere to go, so no badge", () => {
		expect(render(coordinator, null)).not.toContain("narrator-team-badge");
	});

	test("hidden on the team page itself, compared in router-path space", () => {
		const hidden = "narrator-team-badge";
		expect(render(coordinator, routerAt("/projects/proj-1/teams/coord-1"))).not.toContain(hidden);
		expect(render(coordinator, routerAt("/projects/proj-1/teams/coord-1/"))).not.toContain(hidden);
		// Another team's page still links to this one.
		expect(render(coordinator, routerAt("/projects/proj-1/teams/other"))).toContain(
			'href="/projects/proj-1/teams/coord-1"',
		);
	});

	test("under a reverse-proxy subpath the href carries the prefix and the page check holds", () => {
		const html = render(coordinator, routerAt("/narrators/coord-1", "/nf"));
		expect(html).toContain('href="/nf/projects/proj-1/teams/coord-1"');
		// On the prefixed team page (`/nf/projects/…`) the router path is unprefixed: hidden.
		expect(render(coordinator, routerAt("/projects/proj-1/teams/coord-1", "/nf"))).not.toContain(
			"narrator-team-badge",
		);
		const deep = render(coordinator, routerAt("/narrators/coord-1", "/proxy/7778"));
		expect(deep).toContain('href="/proxy/7778/projects/proj-1/teams/coord-1"');
	});

	test("the session header budgets and mounts the badge with the session's project", async () => {
		const panel = await Bun.file(new URL("../NarratorPanel.tsx", import.meta.url)).text();
		expect(panel).toMatch(
			/useNarratorTeamBadge\(\{\s*narratorId,\s*narrator,\s*projectId: compatibilityProjectId,\s*enabled: !REMOTE_BUILD && !isWorkspacePreview,\s*\}\)/,
		);
		expect(panel).toContain("titleBadgeWidth={teamBadge?.width ?? 0}");
		expect(panel).toMatch(
			/\{teamBadge && headerLayout\.showTitleBadge && \(\s*<NarratorTeamBadge target=\{teamBadge\} \/>\s*\)\}/,
		);
		for (const locale of ["en", "zh-CN"]) {
			const resources = await Bun.file(
				new URL(`../../../locales/${locale}/narrator.json`, import.meta.url),
			).json();
			expect(resources.teamBadge).toBeString();
			expect(resources.teamBadgeOpen).toContain("{{name}}");
		}
	});
});
