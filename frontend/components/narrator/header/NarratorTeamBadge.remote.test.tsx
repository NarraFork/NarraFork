import { expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import type { AnyRouter } from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";

// The Remote Access router (`frontend/remote/route-tree.tsx`) registers no team page, so
// the badge would lead to its unsupported-page screen.
mock.module("@frontend/lib/build-target", () => ({ REMOTE_BUILD: true }));
const router = await import("@tanstack/react-router");
const root = router.createRootRoute();
const appRouter = router.createRouter({
	routeTree: root.addChildren([
		router.createRoute({ getParentRoute: () => root, path: "narrators/$narratorId" }),
	]),
	history: router.createMemoryHistory({ initialEntries: ["/narrators/coord-1"] }),
}) as unknown as AnyRouter;
mock.module("@tanstack/react-router", () => ({ ...router, useRouter: () => appRouter }));
mock.module("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const { NarratorTeamBadge, useNarratorTeamBadge } = await import("./NarratorTeamBadge");

test("the Remote Access build shows no team badge and budgets none", () => {
	let target: ReturnType<typeof useNarratorTeamBadge> | undefined;
	function Harness() {
		target = useNarratorTeamBadge({
			narratorId: "coord-1",
			narrator: { traits: ["team"], title: "发布小组" },
			projectId: "proj-1",
		});
		return target ? <NarratorTeamBadge target={target} /> : null;
	}
	const html = renderToStaticMarkup(
		<MantineProvider>
			<Harness />
		</MantineProvider>,
	);
	expect(target).toBeNull();
	expect(html).not.toContain("narrator-team-badge");
});
