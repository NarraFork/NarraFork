/**
 * 团队设置 from the header's 「…」 menu: the team's base branch, where new work items start
 * (`origin/<base>` or the local base; absent follows the project default, shown with what it
 * resolves to) and the brief (`PATCH …/teams/:teamId`, members; an archived team refuses). The
 * same field rules as creating a team (`shared/project-team-draft.ts`).
 */
import { useUpdateTeam } from "@frontend/hooks/useTeams";
import { describeApiError } from "@frontend/lib/api-error";
import { Alert, Button, Group, Modal, Select, Stack, Textarea, TextInput } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { teamBaseBranchSchema, teamBriefSchema } from "@shared/project-team-draft";
import type { TeamDetail, TeamSettingsPatch, TeamWorkStart } from "@shared/project-teams";
import { useState } from "react";
import { useTranslation } from "react-i18next";

const SETTINGS_ERROR_CODES = new Set([
	"TEAM_BASE_BRANCH_UNRESOLVED",
	"TEAM_PROJECT_NOT_GIT",
	"TEAM_PROJECT_CHANGED",
	"TEAM_ARCHIVED",
]);

type WorkStartChoice = TeamWorkStart | "default";

/**
 * The settings change for a work start choice: only that key is sent (the server merges it, so a
 * concurrent change of another setting is kept); `default` removes the team's own.
 */
export function workStartPatch(choice: WorkStartChoice): TeamSettingsPatch {
	return { workStart: choice === "default" ? null : choice };
}

/** The i18n key of a refused settings change, or null for a generic message. */
export function settingsErrorKey(error: unknown): string | null {
	const code = (error as { data?: { code?: unknown } } | null)?.data?.code;
	return typeof code === "string" && SETTINGS_ERROR_CODES.has(code)
		? `teams.page.settings.errors.${code}`
		: null;
}

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
	const [workStart, setWorkStart] = useState<WorkStartChoice>("default");
	// The fields start from the team each time the dialog opens, not on every refetch.
	const [shownFor, setShownFor] = useState<string | null>(null);
	const openedFor = opened && team ? team.id : null;
	if (openedFor !== shownFor) {
		setShownFor(openedFor);
		if (team && openedFor) {
			setBaseBranch(team.baseBranch);
			setBrief(team.brief);
			setWorkStart(team.settings.workStart ?? "default");
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
	const shownBase = baseBranch.trim() || team?.baseBranch || "main";
	const briefError = !teamBriefSchema.safeParse(brief).success
		? t("teams.create.briefTooLong")
		: null;
	// The server checks a new base resolves in the project's repository: its refusal is shown on
	// the field itself (and goes once the field is edited).
	const refusalKey = settingsErrorKey(update.error);
	const refusalText = update.isError
		? refusalKey
			? t(refusalKey, { branch: update.variables?.baseBranch ?? baseBranch })
			: describeApiError(update.error, t).message
		: null;
	const refusedBase =
		update.isError &&
		refusalKey === "teams.page.settings.errors.TEAM_BASE_BRANCH_UNRESOLVED" &&
		update.variables?.baseBranch === baseBranch.trim();
	const save = () => {
		if (!team || branchError || briefError) return;
		const patch: { baseBranch?: string; brief?: string; settings?: TeamSettingsPatch } = {};
		if (baseBranch.trim() && baseBranch.trim() !== team.baseBranch)
			patch.baseBranch = baseBranch.trim();
		if (brief !== team.brief) patch.brief = brief;
		if (workStart !== (team.settings.workStart ?? "default"))
			patch.settings = workStartPatch(workStart);
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
					error={branchError ?? (refusedBase ? refusalText : null)}
					data-testid="team-settings-base"
				/>
				<Select
					label={t("teams.page.settings.workStart.label")}
					description={t("teams.page.settings.workStart.description")}
					value={workStart}
					allowDeselect={false}
					onChange={(value) => setWorkStart((value as WorkStartChoice | null) ?? "default")}
					data={[
						{
							value: "default",
							label: team?.workStartDefault
								? t("teams.page.settings.workStart.default", {
										mode: t(`teams.page.settings.workStart.${team.workStartDefault}`, {
											base: shownBase,
										}),
									})
								: t("teams.page.settings.workStart.defaultChecking"),
						},
						{
							value: "remote",
							label: t("teams.page.settings.workStart.remote", { base: shownBase }),
						},
						{
							value: "local",
							label: t("teams.page.settings.workStart.local", { base: shownBase }),
						},
					]}
					data-testid="team-settings-work-start"
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
				{update.isError && !refusedBase && (
					<Alert color="red" title={t("teams.page.settings.failed")}>
						{refusalText}
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
