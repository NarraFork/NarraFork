/**
 * 团队设置 from the header's 「…」 menu: the team's base branch and brief (`PATCH …/teams/:teamId`,
 * members; an archived team refuses). The same field rules as creating a team
 * (`shared/project-team-draft.ts`).
 */
import { useUpdateTeam } from "@frontend/hooks/useTeams";
import { describeApiError } from "@frontend/lib/api-error";
import { Alert, Button, Group, Modal, Stack, Textarea, TextInput } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { teamBaseBranchSchema, teamBriefSchema } from "@shared/project-team-draft";
import type { TeamDetail } from "@shared/project-teams";
import { useState } from "react";
import { useTranslation } from "react-i18next";

export function TeamSettingsModal({
	projectId,
	team,
	opened,
	onClose,
}: {
	projectId: string;
	team: TeamDetail | undefined;
	opened: boolean;
	onClose: () => void;
}) {
	const { t } = useTranslation("projects");
	const update = useUpdateTeam(projectId, team?.id ?? "");
	const [baseBranch, setBaseBranch] = useState("");
	const [brief, setBrief] = useState("");
	// The fields start from the team each time the dialog opens, not on every refetch.
	const [shownFor, setShownFor] = useState<string | null>(null);
	const openedFor = opened && team ? team.id : null;
	if (openedFor !== shownFor) {
		setShownFor(openedFor);
		if (team && openedFor) {
			setBaseBranch(team.baseBranch);
			setBrief(team.brief);
		}
	}
	const close = () => {
		update.reset();
		onClose();
	};
	const branchError =
		baseBranch.trim() && !teamBaseBranchSchema.safeParse(baseBranch.trim()).success
			? t("teams.create.baseBranchInvalid")
			: null;
	const briefError = !teamBriefSchema.safeParse(brief).success
		? t("teams.create.briefTooLong")
		: null;
	const save = () => {
		if (!team || branchError || briefError) return;
		const patch: { baseBranch?: string; brief?: string } = {};
		if (baseBranch.trim() && baseBranch.trim() !== team.baseBranch)
			patch.baseBranch = baseBranch.trim();
		if (brief !== team.brief) patch.brief = brief;
		if (Object.keys(patch).length === 0) {
			close();
			return;
		}
		update.mutate(patch, {
			onSuccess: () => {
				notifications.show({ color: "green", message: t("teams.page.settings.saved") });
				close();
			},
		});
	};
	return (
		<Modal opened={opened} onClose={close} title={t("teams.page.settings.title")} size="md">
			<Stack>
				<TextInput
					label={t("teams.create.baseBranch")}
					description={t("teams.create.baseBranchDescription")}
					value={baseBranch}
					onChange={(event) => setBaseBranch(event.currentTarget.value)}
					error={branchError}
					data-testid="team-settings-base"
				/>
				<Textarea
					label={t("teams.create.brief")}
					description={t("teams.create.briefDescription")}
					autosize
					minRows={3}
					maxRows={10}
					value={brief}
					onChange={(event) => setBrief(event.currentTarget.value)}
					error={briefError}
					data-testid="team-settings-brief"
				/>
				{update.isError && (
					<Alert color="red" title={t("teams.page.settings.failed")}>
						{describeApiError(update.error, t).message}
					</Alert>
				)}
				<Group justify="flex-end" gap="xs">
					<Button variant="default" onClick={close}>
						{t("teams.create.cancel")}
					</Button>
					<Button
						loading={update.isPending}
						disabled={!!branchError || !!briefError}
						onClick={save}
						data-testid="team-settings-save"
					>
						{t("teams.page.settings.save")}
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}
