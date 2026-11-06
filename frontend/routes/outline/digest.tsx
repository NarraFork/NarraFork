/**
 * `/outline/digest?d=<YYYY-MM-DD|today>&space=<spaceId>`: the person's reports (汇报, P2 PR 11),
 * browsed by day and filtered by space (`components/outline/digest/OutlineDigestPage.tsx`). The
 * static `digest` segment wins over `$spaceId`, as `ref` does.
 */
import { Container } from "@mantine/core";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { OutlineDigestPage } from "../../components/outline/digest/OutlineDigestPage";
import { OutlineGate } from "../../components/outline/OutlineGate";
import { OutlineNavProvider } from "../../components/outline/outline-nav";
import {
	outlineRouterLink,
	useOutlineRouterHrefNavigate,
	useOutlineRouterNavigate,
} from "../../lib/outline-router";

const DAY = /^(?:\d{4}-\d{2}-\d{2}|today)$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;

export const Route = createFileRoute("/outline/digest")({
	component: OutlineDigestRoute,
	validateSearch: (search: Record<string, unknown>) => ({
		d: typeof search.d === "string" && DAY.test(search.d) ? search.d : undefined,
		space: typeof search.space === "string" && ID.test(search.space) ? search.space : undefined,
	}),
});

function OutlineDigestRoute() {
	const search = Route.useSearch();
	const navigate = useNavigate();
	const navigateOutline = useOutlineRouterNavigate();
	const navigateHref = useOutlineRouterHrefNavigate();
	const select = useCallback(
		(next: { d?: string; space?: string }) =>
			void navigate({ to: "/outline/digest", search: { d: next.d, space: next.space } }),
		[navigate],
	);
	return (
		<Container size="lg" py="md" px={0}>
			<OutlineGate>
				<OutlineNavProvider
					onNavigate={navigateOutline}
					renderLink={outlineRouterLink}
					onNavigateHref={navigateHref}
				>
					<OutlineDigestPage day={search.d} space={search.space} onSelect={select} />
				</OutlineNavProvider>
			</OutlineGate>
		</Container>
	);
}
