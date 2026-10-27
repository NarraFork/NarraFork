/** One outline space: its pages in order, and search within it (`OutlineSpaceHome`). */
import { Container } from "@mantine/core";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import { OutlineView } from "../../../components/outline/OutlineView";
import { outlineRouterLink, useOutlineRouterNavigate } from "../../../lib/outline-router";

export const Route = createFileRoute("/outline/$spaceId/")({ component: OutlineSpaceRoute });

function OutlineSpaceRoute() {
	const { spaceId } = Route.useParams();
	const navigate = useOutlineRouterNavigate();
	const target = useMemo(() => ({ kind: "space" as const, spaceId }), [spaceId]);
	return (
		<Container size="lg" py="md" px={0}>
			<OutlineView target={target} onNavigate={navigate} renderLink={outlineRouterLink} />
		</Container>
	);
}
