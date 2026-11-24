import { describe, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { renderToStaticMarkup } from "react-dom/server";

const navigate = mock((_options: unknown) => Promise.resolve());
const router = await import("@tanstack/react-router");
mock.module("@tanstack/react-router", () => ({ ...router, useNavigate: () => navigate }));
const reactI18next = await import("react-i18next");
mock.module("react-i18next", () => ({
	...reactI18next,
	useTranslation: () => ({
		t: (key: string, options?: { name?: string }) =>
			options?.name ? `${key}:${options.name}` : key,
	}),
}));
const { NarratorTeamBadge, teamPagePath } = await import("./NarratorTeamBadge");

const render = (props: Parameters<typeof NarratorTeamBadge>[0]) =>
	renderToStaticMarkup(
		<MantineProvider>
			<NarratorTeamBadge {...props} />
		</MantineProvider>,
	);

describe("coordinator session team badge", () => {
	test("only a session with the team trait and a project links to its team page", () => {
		const team = { traits: ["team"], title: "发布小组" };
		expect(teamPagePath(team, "coord-1", "proj-1")).toBe("/projects/proj-1/teams/coord-1");
		expect(teamPagePath(team, "coord-1", null)).toBeNull();
		expect(teamPagePath({ traits: ["standalone"] }, "n", "proj-1")).toBeNull();
		expect(teamPagePath({ traits: "team" }, "n", "proj-1")).toBeNull();
		expect(teamPagePath(undefined, "n", "proj-1")).toBeNull();
		expect(teamPagePath(team, "a/b", "p q")).toBe("/projects/p%20q/teams/a%2Fb");
	});

	test("renders a labelled link for a coordinator and nothing otherwise", () => {
		const html = render({
			narratorId: "coord-1",
			narrator: { traits: ["named", "team"], title: "发布小组" },
			projectId: "proj-1",
		});
		expect(html).toContain('data-testid="narrator-team-badge"');
		expect(html).toContain('href="/projects/proj-1/teams/coord-1"');
		expect(html).toContain(">teamBadge<");
		expect(html).toContain('aria-label="teamBadgeOpen:发布小组"');
		for (const props of [
			{ narratorId: "n", narrator: { traits: [], title: "x" }, projectId: "proj-1" },
			{ narratorId: "n", narrator: { traits: ["team"], title: "x" }, projectId: undefined },
		])
			expect(render(props)).not.toContain("narrator-team-badge");
	});

	test("the session header mounts the badge with the session's project", async () => {
		const panel = await Bun.file(new URL("../NarratorPanel.tsx", import.meta.url)).text();
		expect(panel).toContain("<NarratorTeamBadge");
		expect(panel).toMatch(
			/<NarratorTeamBadge\s+narratorId=\{narratorId\}\s+narrator=\{narrator\}\s+projectId=\{compatibilityProjectId\}/,
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
