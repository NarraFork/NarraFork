/**
 * The "团队 / Team" marker in a coordinator session's header: the session IS a project team
 * (`team` trait), and the badge leads to its team page `/projects/$projectId/teams/$teamId`
 * (the team id is the coordinator's narrator id).
 *
 * Split in two so the header can budget the badge before it paints:
 * - {@link useNarratorTeamBadge} decides whether the badge shows and returns its fixed width;
 *   the panel hands that width to `resolveHeaderLayoutAfterTitle`, so tools move into the
 *   overflow menu instead of the badge pushing overflow / close past the row edge.
 * - {@link NarratorTeamBadge} paints exactly that box.
 *
 * Everything route-shaped goes through the router, so a reverse-proxy subpath works:
 * the native anchor's href (Ctrl / middle click, open in new tab) is the router's public,
 * basepath-prefixed href, and "am I on the team page" compares router paths, never the
 * prefixed `window.location.pathname`.
 *
 * Not shown:
 * - in the Remote Access build, whose router has no team page (the click would land on its
 *   unsupported-page screen);
 * - outside a router (nowhere to navigate to);
 * - on the team page itself, where the panel is that team's conversation.
 */
import { REMOTE_BUILD } from "@frontend/lib/build-target";
import { Badge, Tooltip } from "@mantine/core";
import { hasTeamTrait } from "@shared/team-trait";
import { IconUsersGroup } from "@tabler/icons-react";
import { type AnyRouter, useRouter } from "@tanstack/react-router";
import { type MouseEvent, useCallback, useMemo, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { headerBadgeLayoutWidth } from "./header-title-width";

const TEAM_ROUTE = "/projects/$projectId/teams/$teamId";
/** `IconUsersGroup size={12}` in the badge's left section. */
const TEAM_BADGE_ICON_PX = 12;

export interface NarratorTeamBadgeTarget {
	projectId: string;
	teamId: string;
	/** Public, basepath-prefixed href for the native anchor. */
	href: string;
	/** Visible badge text. */
	text: string;
	/** Tooltip / accessible name. */
	label: string;
	/** Fixed box width; the header layout budgets exactly this. */
	width: number;
}

function stripTrailingSlash(path: string): string {
	return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/** The router's current path (basepath already removed), or null outside a router. */
function useRouterPathname(router: AnyRouter | null | undefined): string | null {
	const subscribe = useCallback(
		(onChange: () => void) => {
			if (!router) return () => {};
			// `onBeforeLoad` fires once `state.location` points at the new path; `onResolved`
			// covers navigations that settle without a fresh load.
			const offLoad = router.subscribe("onBeforeLoad", onChange);
			const offResolved = router.subscribe("onResolved", onChange);
			return () => {
				offLoad();
				offResolved();
			};
		},
		[router],
	);
	const read = () => router?.state.location.pathname ?? null;
	return useSyncExternalStore(subscribe, read, read);
}

/** Whether (and how) the session header shows the team badge. */
export function useNarratorTeamBadge({
	narratorId,
	narrator,
	projectId,
	enabled = true,
}: {
	narratorId: string;
	narrator: { traits?: unknown; title?: string | null } | null | undefined;
	projectId: string | null | undefined;
	/** False where the header shows no badges (workspace preview). */
	enabled?: boolean;
}): NarratorTeamBadgeTarget | null {
	const { t } = useTranslation("narrator");
	// No warning outside a router: such hosts simply get no badge.
	const router = useRouter({ warn: false });
	const pathname = useRouterPathname(router);
	const isTeam = hasTeamTrait(narrator?.traits);
	const location = useMemo(() => {
		if (REMOTE_BUILD || !enabled || !router || !projectId || !isTeam) return null;
		return router.buildLocation({
			to: TEAM_ROUTE,
			params: { projectId, teamId: narratorId },
		});
	}, [enabled, router, projectId, isTeam, narratorId]);
	const text = t("teamBadge");
	const width = useMemo(() => headerBadgeLayoutWidth(text, TEAM_BADGE_ICON_PX), [text]);
	if (!location || !router || !projectId) return null;
	if (pathname !== null && stripTrailingSlash(pathname) === stripTrailingSlash(location.pathname))
		return null;
	return {
		projectId,
		teamId: narratorId,
		href: router.history.createHref(location.publicHref),
		text,
		label: t("teamBadgeOpen", { name: narrator?.title || t("untitled") }),
		width,
	};
}

export function NarratorTeamBadge({ target }: { target: NarratorTeamBadgeTarget }) {
	const router = useRouter({ warn: false });
	const open = (event: MouseEvent<HTMLAnchorElement>) => {
		// Keep modified clicks (new tab / window) to the browser.
		if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0)
			return;
		if (!router) return;
		event.preventDefault();
		void router.navigate({
			to: TEAM_ROUTE,
			params: { projectId: target.projectId, teamId: target.teamId },
		});
	};
	return (
		<Tooltip label={target.label} openDelay={300}>
			<Badge
				component="a"
				href={target.href}
				onClick={open}
				aria-label={target.label}
				data-testid="narrator-team-badge"
				size="sm"
				radius="sm"
				variant="light"
				leftSection={<IconUsersGroup size={TEAM_BADGE_ICON_PX} aria-hidden />}
				// Exactly the budgeted box in px (not Mantine's rem-scaled `w`), so the header
				// arithmetic and the paint agree.
				style={{
					width: target.width,
					flex: "0 0 auto",
					cursor: "pointer",
					textTransform: "none",
				}}
			>
				{target.text}
			</Badge>
		</Tooltip>
	);
}
