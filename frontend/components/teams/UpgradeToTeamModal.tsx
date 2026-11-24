/**
 * Upgrade an existing session to a team (the session overflow menu's 升级为团队): the session
 * becomes the coordinator of a new team of its project, keeping its conversation, working
 * directory and sharing (`POST /api/projects/:projectId/teams` with `fromNarratorId`). Rendered
 * by the narrator panel outside the menu's dropdown, which unmounts on close.
 *
 * Also `teamErrorMessage`: the upgrade and disband refusals have their own codes; each gets a
 * sentence in the reader's language, anything else the usual API error text.
 */
import { useUpgradeToTeam } from "@frontend/hooks/useTeams";
import type { UpgradeToTeamPayload } from "@frontend/lib/api/teams";
import { describeApiError } from "@frontend/lib/api-error";
import { Alert, Button, Group, Modal, Stack, Text, Textarea, TextInput } from "@mantine/core";
import {
	TEAM_BRANCH_MAX_LENGTH,
	TEAM_NAME_MAX_LENGTH,
	type TeamDetail,
} from "@shared/project-teams";
import { useState } from "react";
import { useTranslation } from "react-i18next";

type Translate = ReturnType<typeof useTranslation>["t"];

/** The reader's sentence for an upgrade (`scope: "upgrade"`) or disband refusal. */
export function teamErrorMessage(
	error: unknown,
	t: Translate,
	scope: "upgrade" | "disband",
): string {
	const code = (error as { data?: { code?: unknown } } | null)?.data?.code;
	if (typeof code === "string" && /^[A-Z_]+$/.test(code)) {
		const text = t(`teams.${scope}.errors.${code}`, { defaultValue: "" });
		if (text) return text;
	}
	return describeApiError(error, t).message;
}

/** The request body: the session, plus only the fields the person filled in. */
export function buildUpgradePayload(
	narratorId: string,
	fields: { name: string; baseBranch: string; brief: string },
): UpgradeToTeamPayload {
	return {
		fromNarratorId: narratorId,
		...(fields.name.trim() ? { name: fields.name.trim() } : {}),
		...(fields.baseBranch.trim() ? { baseBranch: fields.baseBranch.trim() } : {}),
		...(fields.brief.trim() ? { brief: fields.brief } : {}),
	};
}

export function UpgradeToTeamModal({
	projectId,
	narratorId,
	title,
	opened,
	onClose,
	onUpgraded,
}: {
	projectId: string;
	narratorId: string;
	/** The session's title, the default team name. */
	title: string | null;
	opened: boolean;
	onClose: () => void;
	onUpgraded: (team: TeamDetail) => void;
}) {
	const { t } = useTranslation("projects");
	const upgrade = useUpgradeToTeam(projectId);
	const [name, setName] = useState("");
	const [baseBranch, setBaseBranch] = useState("");
	const [brief, setBrief] = useState("");
	const submit = () => {
		upgrade.mutate(buildUpgradePayload(narratorId, { name, baseBranch, brief }), {
			onSuccess: (team) => onUpgraded(team),
		});
	};
	return (
		<Modal opened={opened} onClose={onClose} title={t("teams.upgrade.title")}>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					submit();
				}}
			>
				<Stack>
					<Text size="sm">{t("teams.upgrade.intro")}</Text>
					<TextInput
						label={t("teams.upgrade.name")}
						description={t("teams.upgrade.nameDescription")}
						placeholder={title ?? undefined}
						value={name}
						maxLength={TEAM_NAME_MAX_LENGTH}
						onChange={(event) => setName(event.currentTarget.value)}
						data-autofocus
						data-testid="upgrade-team-name"
					/>
					<TextInput
						label={t("teams.create.baseBranch")}
						description={t("teams.create.baseBranchDescription")}
						value={baseBranch}
						maxLength={TEAM_BRANCH_MAX_LENGTH}
						onChange={(event) => setBaseBranch(event.currentTarget.value)}
						styles={{ input: { fontFamily: "var(--mantine-font-family-monospace)" } }}
					/>
					<Textarea
						label={t("teams.create.brief")}
						description={t("teams.create.briefDescription")}
						value={brief}
						autosize
						minRows={3}
						maxRows={8}
						onChange={(event) => setBrief(event.currentTarget.value)}
					/>
					{upgrade.isError && (
						<Alert color="red" title={t("teams.upgrade.failed")} data-testid="upgrade-team-error">
							{teamErrorMessage(upgrade.error, t, "upgrade")}
						</Alert>
					)}
					<Group justify="flex-end" gap="xs">
						<Button variant="default" onClick={onClose}>
							{t("teams.create.cancel")}
						</Button>
						<Button type="submit" loading={upgrade.isPending} data-testid="upgrade-team-submit">
							{t("teams.upgrade.submit")}
						</Button>
					</Group>
				</Stack>
			</form>
		</Modal>
	);
}
