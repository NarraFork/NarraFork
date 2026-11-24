/**
 * The "团队 / Team" marker in a coordinator session's header: the session IS a project team
 * (`team` trait), and the badge leads to its team page `/projects/$projectId/teams/$teamId`
 * (the team id is the coordinator's narrator id).
 *
 * Plain navigation through `useNavigate` (which the panel already uses) rather than `Link` or
 * router-state hooks, so hosts and tests that provide only the navigate function keep working.
 * Not shown on the team page itself, where the panel is that team's conversation.
 */
import { Badge, Tooltip } from "@mantine/core";
import { hasTeamTrait } from "@shared/project-teams";
import { IconUsersGroup } from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import type { MouseEvent } from "react";
import { useTranslation } from "react-i18next";

/** The team page path of a coordinator, or null when the session is no team or has no project. */
export function teamPagePath(
	narrator: { traits?: unknown } | null | undefined,
	narratorId: string,
	projectId: string | null | undefined,
): string | null {
	if (!projectId || !hasTeamTrait(narrator?.traits)) return null;
	return `/projects/${encodeURIComponent(projectId)}/teams/${encodeURIComponent(narratorId)}`;
}

function currentPathname(): string {
	return typeof window === "undefined" ? "" : window.location.pathname;
}

export function NarratorTeamBadge({
	narratorId,
	narrator,
	projectId,
}: {
	narratorId: string;
	narrator: { traits?: unknown; title?: string | null } | null | undefined;
	projectId: string | null | undefined;
}) {
	const { t } = useTranslation("narrator");
	const navigate = useNavigate();
	const href = teamPagePath(narrator, narratorId, projectId);
	if (!href || !projectId || currentPathname() === href) return null;
	const label = t("teamBadgeOpen", { name: narrator?.title || t("untitled") });
	const open = (event: MouseEvent<HTMLAnchorElement>) => {
		// Keep modified clicks (new tab / window) to the browser.
		if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0)
			return;
		event.preventDefault();
		void navigate({
			to: "/projects/$projectId/teams/$teamId",
			params: { projectId, teamId: narratorId },
		});
	};
	return (
		<Tooltip label={label} openDelay={300}>
			<Badge
				component="a"
				href={href}
				onClick={open}
				aria-label={label}
				data-testid="narrator-team-badge"
				size="sm"
				radius="sm"
				variant="light"
				leftSection={<IconUsersGroup size={12} aria-hidden />}
				style={{ flex: "0 0 auto", cursor: "pointer", textTransform: "none" }}
			>
				{t("teamBadge")}
			</Badge>
		</Tooltip>
	);
}
