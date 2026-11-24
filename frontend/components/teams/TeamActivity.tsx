/**
 * The team's activity (docs/PROJECT_TEAMS-PLAN.md §二.4 `team_work_events`, §二.14 "决定替人做了
 * 要说"; P4): every state change, review, sync, cleanup, check-in and decision, newest first, with
 * the person or agent behind it. Agent-written text is shown as plain text.
 */
import { useTeamActivity } from "@frontend/hooks/useTeams";
import { formatSmartTime } from "@frontend/lib/format";
import { Alert, Button, Group, Loader, Stack, Text, ThemeIcon } from "@mantine/core";
import type { TeamActivityEvent } from "@shared/project-teams";
import { IconRobot, IconSettings, IconUser } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { eventLabelKey, eventNote } from "./team-page-model";

const ACTOR_ICON = { person: IconUser, agent: IconRobot, system: IconSettings } as const;

function ActivityRow({ event }: { event: TeamActivityEvent }) {
	const { t } = useTranslation("projects");
	const Icon = ACTOR_ICON[event.actorKind] ?? IconSettings;
	const actor =
		event.actorKind === "system"
			? t("teams.activity.system")
			: (event.actorName ??
				t(
					event.actorKind === "person"
						? "teams.activity.unknownPerson"
						: "teams.activity.unknownAgent",
				));
	const note = eventNote(event);
	return (
		<Group
			gap="xs"
			wrap="nowrap"
			align="flex-start"
			data-testid="team-event"
			data-kind={event.kind}
		>
			<ThemeIcon size={22} radius="xl" variant="light" color="gray" style={{ flexShrink: 0 }}>
				<Icon size={14} aria-hidden />
			</ThemeIcon>
			<Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
				<Group gap={6} justify="space-between" wrap="nowrap">
					<Text size="sm" fw={500} style={{ minWidth: 0, overflowWrap: "anywhere" }}>
						{t(`teams.event.${eventLabelKey(event.kind)}`, { kind: event.kind })}
					</Text>
					<Text size="xs" c="dimmed" style={{ flexShrink: 0 }} title={event.createdAt}>
						{formatSmartTime(event.createdAt)}
					</Text>
				</Group>
				{event.workItemTitle && (
					<Text size="xs" style={{ overflowWrap: "anywhere" }}>
						{event.workItemTitle}
					</Text>
				)}
				{note && (
					<Text
						size="xs"
						c="dimmed"
						style={{ overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}
						data-testid="team-event-note"
					>
						{t(`teams.eventNote.${note.key}`, note.values)}
					</Text>
				)}
				{event.detailOmitted && (
					<Text size="xs" c="dimmed" fs="italic">
						{t("teams.activity.detailOmitted")}
					</Text>
				)}
				<Text size="xs" c="dimmed" truncate>
					{actor}
				</Text>
			</Stack>
		</Group>
	);
}

export function TeamActivity({ projectId, teamId }: { projectId: string; teamId: string }) {
	const { t } = useTranslation("projects");
	const pages = useTeamActivity(projectId, teamId);
	const events = pages.data?.pages.flatMap((page) => page.events) ?? [];
	return (
		<Stack gap="sm" data-testid="team-activity">
			{pages.isLoading && <Loader size="sm" />}
			{pages.isError && <Alert color="red">{t("teams.activity.loadFailed")}</Alert>}
			{pages.isSuccess && events.length === 0 && (
				<Text size="sm" c="dimmed">
					{t("teams.activity.empty")}
				</Text>
			)}
			{events.map((event) => (
				<ActivityRow key={event.id} event={event} />
			))}
			{pages.hasNextPage && (
				<Button
					size="xs"
					variant="subtle"
					loading={pages.isFetchingNextPage}
					onClick={() => void pages.fetchNextPage()}
				>
					{t("teams.loadMore")}
				</Button>
			)}
		</Stack>
	);
}
