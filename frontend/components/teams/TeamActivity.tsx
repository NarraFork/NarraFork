/**
 * The right column's 「动态」 (the redesign R): the team's events (`team_work_events`: every state
 * change, review, return, sync, cleanup, check-in and decision) as a quiet chronological list,
 * newest first, the same density as the work list and no cards: the time, who, what, the work
 * item, and the event's note below. Agent-written text is shown as plain text.
 */
import { useTeamActivity } from "@frontend/hooks/useTeams";
import { formatSmartTime } from "@frontend/lib/format";
import { Alert, Box, Button, Group, Loader, Stack, Text } from "@mantine/core";
import type { TeamActivityEvent } from "@shared/project-teams";
import { useTranslation } from "react-i18next";
import { eventLabelKey, eventNote } from "./team-page-model";
import { TABULAR } from "./team-page-ui";

export function ActivityLine({
	event,
	showItem = true,
}: {
	event: TeamActivityEvent;
	/** Off inside a work item's own timeline, where the item is known. */
	showItem?: boolean;
}) {
	const { t } = useTranslation("projects");
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
	const labelKey = eventLabelKey(event.kind);
	return (
		<Group
			gap={10}
			wrap="nowrap"
			align="flex-start"
			px={10}
			py={6}
			data-testid="team-event"
			data-kind={event.kind}
		>
			<Text
				size="xs"
				c="dimmed"
				title={event.createdAt}
				style={{ ...TABULAR, flexShrink: 0, width: 64, paddingTop: 2 }}
			>
				{formatSmartTime(event.createdAt)}
			</Text>
			<Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
				<Text size="sm" style={{ overflowWrap: "anywhere" }}>
					<Text component="span" inherit c="dimmed">
						{actor}
					</Text>{" "}
					{/* An unknown kind reads as the generic headline; its name stays a tooltip. */}
					<Text component="span" inherit title={labelKey === "other" ? event.kind : undefined}>
						{t(`teams.event.${labelKey}`)}
					</Text>
					{showItem && event.workItemTitle && (
						<Text component="span" inherit fw={500}>
							{" · "}
							{event.workItemTitle}
						</Text>
					)}
				</Text>
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
			</Stack>
		</Group>
	);
}

export function TeamActivity({ projectId, teamId }: { projectId: string; teamId: string }) {
	const { t } = useTranslation("projects");
	const pages = useTeamActivity(projectId, teamId);
	const events = pages.data?.pages.flatMap((page) => page.events) ?? [];
	return (
		<Stack gap={0} data-testid="team-activity">
			{pages.isLoading && <Loader size="sm" m="sm" />}
			{pages.isError && <Alert color="red">{t("teams.activity.loadFailed")}</Alert>}
			{pages.isSuccess && events.length === 0 && (
				<Text size="sm" c="dimmed" p="sm">
					{t("teams.activity.empty")}
				</Text>
			)}
			{events.map((event) => (
				<ActivityLine key={event.id} event={event} />
			))}
			{pages.hasNextPage && (
				<Box p={6}>
					<Button
						size="xs"
						variant="subtle"
						loading={pages.isFetchingNextPage}
						onClick={() => void pages.fetchNextPage()}
					>
						{t("teams.loadMore")}
					</Button>
				</Box>
			)}
		</Stack>
	);
}
