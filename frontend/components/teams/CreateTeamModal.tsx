/**
 * The 「新团队」 dialog (docs/PROJECT_TEAMS-PLAN.md P1): a name, the base branch and the brief, then
 * the team's coordinator session is created through the team route. Opened from the project
 * page's header and its dashed 「新团队」 card (R2).
 */
import { useCreateTeam } from "@frontend/hooks/useTeams";
import { describeApiError } from "@frontend/lib/api-error";
import { Alert, Button, Group, Modal, Stack } from "@mantine/core";
import type { TeamDetail } from "@shared/project-teams";
import { useTranslation } from "react-i18next";
import { TeamCreateFields, useTeamDraft } from "./TeamCreateFields";

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
