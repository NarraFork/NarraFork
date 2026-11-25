/**
 * The team page top bar's menu with 解散团队 (disband the team): a confirmation that says what
 * goes (the team's work items and activity history) and what stays (the coordinator's session
 * and its conversation), then `POST …/teams/:teamId/disband`. The server decides who may (the
 * session's owner or an admin) and refuses while work is live or the coordinator busy; the
 * refusal is shown in the dialog. After success the caller opens the session.
 */
import { useDisbandTeam } from "@frontend/hooks/useTeams";
import { ActionIcon, Alert, Button, Group, Menu, Modal, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconDotsVertical, IconUsersMinus } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { teamErrorMessage } from "./UpgradeToTeamModal";

export function TeamDisbandMenu({
	projectId,
	teamId,
	onDisbanded,
}: {
	projectId: string;
	teamId: string;
	onDisbanded: (narratorId: string) => void;
}) {
	const { t } = useTranslation("projects");
	const [confirming, setConfirming] = useState(false);
	const disband = useDisbandTeam(projectId, teamId);
	const close = () => {
		setConfirming(false);
		disband.reset();
	};
	const confirm = () =>
		disband.mutate(undefined, {
			onSuccess: ({ narratorId }) => {
				setConfirming(false);
				notifications.show({ color: "green", message: t("teams.disband.done") });
				onDisbanded(narratorId);
			},
		});
	return (
		<>
			<Menu position="bottom-end" shadow="md" withinPortal>
				<Menu.Target>
					<ActionIcon
						size={30}
						variant="subtle"
						color="gray"
						aria-label={t("teams.disband.menu")}
						data-testid="team-more-menu"
					>
						<IconDotsVertical size={16} aria-hidden />
					</ActionIcon>
				</Menu.Target>
				<Menu.Dropdown>
					<Menu.Item
						color="red"
						leftSection={<IconUsersMinus size={14} />}
						onClick={() => setConfirming(true)}
						data-testid="team-disband"
					>
						{t("teams.disband.menu")}
					</Menu.Item>
				</Menu.Dropdown>
			</Menu>
			<Modal opened={confirming} onClose={close} title={t("teams.disband.title")} size="sm">
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
		</>
	);
}
