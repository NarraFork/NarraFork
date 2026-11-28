/**
 * 解散团队 (disband the team), opened from the header's 「…」 menu and from the wrap-up card: a
 * confirmation that says what goes (the team's work items and activity history) and what stays
 * (the coordinator's session and its conversation), then `POST …/teams/:teamId/disband`. The
 * server decides who may (the session's owner or an admin) and refuses while work is live or the
 * coordinator busy; the refusal is shown in the dialog. After success the caller opens the
 * session.
 */
import { useDisbandTeam } from "@frontend/hooks/useTeams";
import { Alert, Button, Group, Modal, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";
import { teamErrorMessage } from "./UpgradeToTeamModal";

export function TeamDisbandDialog({
	projectId,
	teamId,
	opened,
	onClose,
	onDisbanded,
}: {
	projectId: string;
	teamId: string;
	opened: boolean;
	onClose: () => void;
	onDisbanded: (narratorId: string) => void;
}) {
	const { t } = useTranslation("projects");
	const disband = useDisbandTeam(projectId, teamId);
	const close = () => {
		onClose();
		disband.reset();
	};
	const confirm = () =>
		disband.mutate(undefined, {
			onSuccess: ({ narratorId }) => {
				onClose();
				notifications.show({ color: "green", message: t("teams.disband.done") });
				onDisbanded(narratorId);
			},
		});
	return (
		<Modal opened={opened} onClose={close} title={t("teams.disband.title")} size="sm">
			<Stack>
				<Text size="sm">{t("teams.disband.confirm")}</Text>
				{disband.isError && (
					<Alert color="red" title={t("teams.disband.failed")} data-testid="team-disband-error">
						{teamErrorMessage(disband.error, t, "disband")}
					</Alert>
				)}
				<Group justify="flex-end" gap="xs">
					<Button variant="default" onClick={close}>
						{t("teams.create.cancel")}
					</Button>
					<Button
						color="red"
						loading={disband.isPending}
						onClick={confirm}
						data-testid="team-disband-confirm"
					>
						{t("teams.disband.confirmButton")}
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}
