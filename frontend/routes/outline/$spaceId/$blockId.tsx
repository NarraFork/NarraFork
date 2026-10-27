/**
 * An outline page, or any block of one focused as a page: the outline surface with the URL as
 * its props, as the main panel of a dock where sessions and other outline panels open beside it
 * (`components/outline-dock/OutlinePageDock.tsx`; the page alone on a phone).
 *
 * Everything that says what is shown lives in the URL: the focused block is the path, `asOf`
 * the commit the page is shown at, `view` the facts or all view. The surface's navigations
 * become history entries, so browser back and forward walk focus and time; its links are real
 * anchors to those URLs.
 */
import { Box } from "@mantine/core";
import { createFileRoute } from "@tanstack/react-router";
import { OutlinePageDock } from "../../../components/outline-dock/OutlinePageDock";
import { useMobileViewport } from "../../../hooks/useMobileViewport";
import { useOutlineRouterNavigate } from "../../../lib/outline-router";
import { parseOutlineBlockSearch } from "../../../lib/outline-view";
import { APP_SHELL_FULL_BLEED_HEIGHT } from "../../../lib/safe-area";

export const Route = createFileRoute("/outline/$spaceId/$blockId")({
	component: OutlineBlockRoute,
	validateSearch: parseOutlineBlockSearch,
});

function OutlineBlockRoute() {
	const { spaceId, blockId } = Route.useParams();
	const search = Route.useSearch();
	const navigate = useOutlineRouterNavigate();
	const isMobile = useMobileViewport();
	const page = (
		<OutlinePageDock
			spaceId={spaceId}
			blockId={blockId}
			view={search.view}
			asOf={search.asOf}
			onNavigate={navigate}
		/>
	);
	if (isMobile) return page;
	// The dock fills the app shell's main area edge to edge, like a session page.
	return (
		<Box
			h={APP_SHELL_FULL_BLEED_HEIGHT}
			mx="calc(var(--mantine-spacing-md) * -1)"
			my="calc(var(--mantine-spacing-md) * -1)"
			style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}
		>
			{page}
		</Box>
	);
}
