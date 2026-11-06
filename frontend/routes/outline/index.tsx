/**
 * Outline home: search across every readable space, the pages visited recently in this
 * browser, and the spaces the reader can open (`components/outline/OutlineHome.tsx`, with its
 * links as real URLs), under an entry to the reader's reports (P2 PR 11).
 */
import { Container } from "@mantine/core";
import { createFileRoute } from "@tanstack/react-router";
import { OutlineReportEntry } from "../../components/outline/digest/OutlineReportEntry";
import { OutlineView } from "../../components/outline/OutlineView";
import { OutlineNavProvider } from "../../components/outline/outline-nav";
import {
	outlineRouterLink,
	useOutlineRouterHrefNavigate,
	useOutlineRouterNavigate,
} from "../../lib/outline-router";

export const Route = createFileRoute("/outline/")({ component: OutlineHomeRoute });

const HOME = { kind: "home" } as const;

function OutlineHomeRoute() {
	const navigate = useOutlineRouterNavigate();
	const navigateHref = useOutlineRouterHrefNavigate();
	return (
		<Container size="lg" py="md" px={0}>
			<OutlineView
				target={HOME}
				onNavigate={navigate}
				renderLink={outlineRouterLink}
				homeHeader={
					<OutlineNavProvider
						onNavigate={navigate}
						renderLink={outlineRouterLink}
						onNavigateHref={navigateHref}
					>
						<OutlineReportEntry />
					</OutlineNavProvider>
				}
			/>
		</Container>
	);
}
