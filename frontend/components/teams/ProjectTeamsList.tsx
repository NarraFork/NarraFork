/**
 * A project's teams (docs/PROJECT_TEAMS-PLAN.md §二.11; P4): on the project home page beside the
 * sessions. Project writers can create a team, which is creating its coordinator session (P1's
 * route).
 */
import { NarratorStatusIcon } from "@frontend/components/nav/NarratorStatusIcon";
import { PinToSidebarButton } from "@frontend/components/nav/PinToSidebarButton";
import { teamsUnavailable, useCreateTeam, useProjectTeams } from "@frontend/hooks/useTeams";
import { describeApiError } from "@frontend/lib/api-error";
import {
	Alert,
	Badge,
	Button,
	Group,
	Loader,
	Modal,
	Stack,
	Text,
	UnstyledButton,
} from "@mantine/core";
import type { TeamDetail } from "@shared/project-teams";
import { IconPlus, IconUsersGroup } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { TeamCreateFields, useTeamDraft } from "./TeamCreateFields";
import { teamPinTitle } from "./team-page-model";

export function CreateTeamModal({
	projectId,
	opened,
	onClose,
	onCreated,
}: {
	projectId: string;
	opened: boolean;
	onClose: () => void;
	onCreated: (team: TeamDetail) => void;
}) {
	const { t } = useTranslation("projects");
	const create = useCreateTeam(projectId);
	const draft = useTeamDraft();
	const submit = () => {
		const payload = draft.submit();
		if (!payload) return;
		create.mutate(payload, { onSuccess: (team) => onCreated(team) });
	};
	return (
		<Modal opened={opened} onClose={onClose} title={t("teams.create.title")}>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					submit();
				}}
			>
				<Stack>
					<TeamCreateFields draft={draft} />
					{create.isError && (
						<Alert color="red" title={t("teams.create.failed")}>
							{describeApiError(create.error, t).message}
						</Alert>
					)}
					<Group justify="flex-end" gap="xs">
						<Button variant="default" onClick={onClose}>
							{t("teams.create.cancel")}
						</Button>
						<Button type="submit" loading={create.isPending} data-testid="create-team-submit">
							{t("teams.create.submit")}
						</Button>
					</Group>
				</Stack>
			</form>
		</Modal>
	);
}

/** The project page's teams section with its heading. */
export function ProjectTeamsList({
	projectId,
	canCreate,
	onOpenTeam,
	onCreated,
}: {
	projectId: string;
	canCreate: boolean;
	onOpenTeam: (teamId: string) => void;
	onCreated?: (team: TeamDetail) => void;
}) {
	const { t } = useTranslation("projects");
	const teams = useProjectTeams(projectId);
	const [creating, setCreating] = useState(false);
	const rows = teams.data?.pages.flatMap((page) => page.teams) ?? [];
	// Teams are not available on this deployment (PostgreSQL): no section, no "new team".
	if (teams.isError && teamsUnavailable(teams.error)) return null;
	return (
		<Stack gap="xs" data-testid="project-teams">
			<Group justify="space-between" gap="xs" wrap="nowrap">
				<Group gap={6} wrap="nowrap">
					<IconUsersGroup size={20} aria-hidden />
					<Text fw={600} size="lg">
						{t("teams.title")}
					</Text>
				</Group>
				{canCreate && (
					<Button
						size="xs"
						variant="light"
						leftSection={<IconPlus size={14} aria-hidden />}
						onClick={() => setCreating(true)}
						data-testid="new-team"
					>
						{t("teams.newTeam")}
					</Button>
				)}
			</Group>
			{teams.isLoading && <Loader size="sm" />}
			{teams.isError && <Alert color="red">{t("teams.loadFailed")}</Alert>}
			{teams.isSuccess && rows.length === 0 && (
				<Text size="sm" c="dimmed">
					{t("teams.noTeams")}
				</Text>
			)}
			{rows.map((team) => {
				// The list asks for active teams, but a cached page can outlive an archive.
				const pinTitle = teamPinTitle(team);
				return (
					// The pin is a sibling of the row's button, not inside it (no nested buttons).
					<Group
						key={team.id}
						gap={4}
						wrap="nowrap"
						pr={4}
						data-testid="project-team-row"
						data-team-id={team.id}
						style={{
							borderRadius: "var(--mantine-radius-sm)",
							border: "1px solid var(--mantine-color-default-border)",
						}}
					>
						<UnstyledButton
							onClick={() => onOpenTeam(team.id)}
							data-testid="project-team-open"
							px="sm"
							py="xs"
							style={{ flex: 1, minWidth: 0 }}
						>
							<Group gap={8} wrap="nowrap">
								<NarratorStatusIcon size={16} status={team.coordinatorStatus} />
								<Text size="sm" fw={500} truncate style={{ flex: 1 }}>
									{team.name || team.id}
								</Text>
								{team.access === "read" && (
									<Badge size="xs" variant="light" color="gray" tt="none">
										{t("teams.onlooker")}
									</Badge>
								)}
							</Group>
						</UnstyledButton>
						{pinTitle !== undefined && (
							<PinToSidebarButton type="team" id={team.id} title={pinTitle} size="sm" />
						)}
					</Group>
				);
			})}
			{teams.hasNextPage && (
				<Button
					size="xs"
					variant="subtle"
					loading={teams.isFetchingNextPage}
					onClick={() => void teams.fetchNextPage()}
				>
					{t("teams.loadMore")}
				</Button>
			)}
			{creating && (
				<CreateTeamModal
					projectId={projectId}
					opened
					onClose={() => setCreating(false)}
					onCreated={(team) => {
						setCreating(false);
						(onCreated ?? ((created: TeamDetail) => onOpenTeam(created.id)))(team);
					}}
				/>
			)}
		</Stack>
	);
}
