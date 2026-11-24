/**
 * The fields of a new team (name, base branch, brief): the project page's "new team" dialog and
 * the new-session dialog's "start as a team" both fill the team route's body with them.
 *
 * Kept free of query hooks and router imports, so the new-session dialog can render them without
 * pulling the team page's data layer into its bundle.
 */
import type { CreateTeamPayload } from "@frontend/lib/api/teams";
import { Stack, Textarea, TextInput } from "@mantine/core";
import { TEAM_BRANCH_MAX_LENGTH, TEAM_NAME_MAX_LENGTH } from "@shared/project-teams";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { checkTeamDraft } from "./team-draft";

export interface TeamDraft {
	name: string;
	baseBranch: string;
	brief: string;
	setName: (value: string) => void;
	setBaseBranch: (value: string) => void;
	setBrief: (value: string) => void;
	/** Shown once a submit was attempted with a draft the team route would refuse. */
	nameError: string | null;
	baseBranchError: string | null;
	briefError: string | null;
	/**
	 * Marks the draft as submitted and returns the route body, or null while a field breaks the
	 * route's own rules (`checkTeamDraft`): then nothing may be sent.
	 */
	submit: () => CreateTeamPayload | null;
	reset: () => void;
}

export function useTeamDraft(): TeamDraft {
	const { t } = useTranslation("projects");
	const [name, setName] = useState("");
	const [baseBranch, setBaseBranch] = useState("");
	const [brief, setBrief] = useState("");
	const [touched, setTouched] = useState(false);
	const check = checkTeamDraft({ name, baseBranch, brief });
	const errors = touched && !check.ok ? check.errors : {};
	return {
		name,
		baseBranch,
		brief,
		setName,
		setBaseBranch,
		setBrief,
		nameError:
			errors.name === "required"
				? t("teams.create.nameRequired")
				: errors.name
					? t("teams.create.nameInvalid", { max: TEAM_NAME_MAX_LENGTH })
					: null,
		baseBranchError: errors.baseBranch ? t("teams.create.baseBranchInvalid") : null,
		briefError: errors.brief ? t("teams.create.briefTooLong") : null,
		submit: () => {
			setTouched(true);
			return check.ok ? check.payload : null;
		},
		reset: () => {
			setName("");
			setBaseBranch("");
			setBrief("");
			setTouched(false);
		},
	};
}

export function TeamCreateFields({
	draft,
	autoFocus = true,
}: {
	draft: TeamDraft;
	autoFocus?: boolean;
}) {
	const { t } = useTranslation("projects");
	return (
		<Stack>
			<TextInput
				label={t("teams.create.name")}
				description={t("teams.create.nameDescription")}
				placeholder={t("teams.create.namePlaceholder")}
				value={draft.name}
				maxLength={TEAM_NAME_MAX_LENGTH}
				onChange={(event) => draft.setName(event.currentTarget.value)}
				error={draft.nameError}
				data-autofocus={autoFocus || undefined}
				data-testid="create-team-name"
			/>
			<TextInput
				label={t("teams.create.baseBranch")}
				description={t("teams.create.baseBranchDescription")}
				value={draft.baseBranch}
				maxLength={TEAM_BRANCH_MAX_LENGTH}
				onChange={(event) => draft.setBaseBranch(event.currentTarget.value)}
				error={draft.baseBranchError}
				styles={{ input: { fontFamily: "var(--mantine-font-family-monospace)" } }}
				data-testid="create-team-base-branch"
			/>
			<Textarea
				label={t("teams.create.brief")}
				description={t("teams.create.briefDescription")}
				value={draft.brief}
				autosize
				minRows={3}
				maxRows={8}
				onChange={(event) => draft.setBrief(event.currentTarget.value)}
				error={draft.briefError}
				data-testid="create-team-brief"
			/>
		</Stack>
	);
}
