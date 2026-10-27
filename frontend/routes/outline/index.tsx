/**
 * Outline home: search across every readable space, the pages visited recently in this
 * browser, and the spaces the reader can open (`components/outline/OutlineHome.tsx`, with its
 * links as real URLs).
 */
import { Container } from "@mantine/core";
import { createFileRoute } from "@tanstack/react-router";
import { OutlineView } from "../../components/outline/OutlineView";
import { outlineRouterLink, useOutlineRouterNavigate } from "../../lib/outline-router";

export const Route = createFileRoute("/outline/")({ component: OutlineHomeRoute });

const HOME = { kind: "home" } as const;

function OutlineHomeRoute() {
	const navigate = useOutlineRouterNavigate();
	return (
		<Container size="lg" py="md" px={0}>
			<OutlineView target={HOME} onNavigate={navigate} renderLink={outlineRouterLink} />
		</Container>
	);
}
