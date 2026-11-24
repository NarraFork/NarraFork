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
import { Alert, Button, Group, Modal, Stack, Text } from "@mantine/core";
import type { TeamDetail } from "@shared/project-teams";
import { useTranslation } from "react-i18next";
import { TeamCreateFields, useTeamDraft } from "./TeamCreateFields";

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

/**
 * The request body: the session, plus the fields that change something. The name is sent only
 * when it differs from the session's title, so an untouched (prefilled) name keeps the title even
 * if the session is renamed meanwhile.
 */
export function buildUpgradePayload(
	narratorId: string,
	fields: { name: string; baseBranch: string; brief: string },
	title: string | null = null,
): UpgradeToTeamPayload {
	const name = fields.name.trim();
	return {
		fromNarratorId: narratorId,
		...(name && name !== (title ?? "").trim() ? { name } : {}),
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
	/** The session's title, prefilled as the team name. */
	title: string | null;
	opened: boolean;
	onClose: () => void;
	onUpgraded: (team: TeamDetail) => void;
}) {
	const { t } = useTranslation("projects");
	const upgrade = useUpgradeToTeam(projectId);
	// The same fields and client checks as creating a team (`checkTeamDraft`); the name starts as
	// the session's title, a real value rather than a placeholder.
	const draft = useTeamDraft({ initialName: title ?? "" });
	const submit = () => {
		if (!draft.submit()) return;
		upgrade.mutate(buildUpgradePayload(narratorId, draft, title), {
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
					<TeamCreateFields draft={draft} />
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
