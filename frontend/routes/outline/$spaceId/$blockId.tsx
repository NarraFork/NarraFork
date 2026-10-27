/**
 * An outline page, or any block of one focused as a page: the outline surface
 * (`OutlineSurface`) with the URL as its props.
 *
 * Everything that says what is shown lives in the URL: the focused block is the path, `asOf`
 * the commit the page is shown at, `view` the facts or all view. The surface's navigations
 * become history entries, so browser back and forward walk focus and time; its links are real
 * anchors to those URLs.
 */
import { createFileRoute } from "@tanstack/react-router";
import { OutlineSurface } from "../../../components/outline/OutlineSurface";
import { outlineRouterLink, useOutlineRouterNavigate } from "../../../lib/outline-router";
import { parseOutlineBlockSearch } from "../../../lib/outline-view";

export const Route = createFileRoute("/outline/$spaceId/$blockId")({
	component: OutlineBlockRoute,
	validateSearch: parseOutlineBlockSearch,
});

function OutlineBlockRoute() {
	const { spaceId, blockId } = Route.useParams();
	const search = Route.useSearch();
	const navigate = useOutlineRouterNavigate();
	return (
		<OutlineSurface
			spaceId={spaceId}
			blockId={blockId}
			view={search.view}
			asOf={search.asOf}
			onNavigate={navigate}
			renderLink={outlineRouterLink}
		/>
	);
}
