/**
 * A new team's typed fields checked by the team route's own rules (`shared/project-team-draft.ts`)
 * before anything is sent. The new-session dialog makes the directory's project before calling
 * the team route, so a draft the route would refuse must stop here, not after that first write.
 *
 * Pure and free of React and Mantine, so it is unit-tested directly.
 */
import type { CreateTeamPayload } from "@frontend/lib/api/teams";
import { teamBaseBranchSchema, teamBriefSchema, teamNameSchema } from "@shared/project-team-draft";

export interface TeamDraftInput {
	name: string;
	baseBranch: string;
	brief: string;
}

/** Which field is wrong; the dialog turns each into its own message. */
export interface TeamDraftErrors {
	name?: "required" | "invalid";
	baseBranch?: "invalid";
	brief?: "tooLong";
}

export type TeamDraftCheck =
	| { ok: true; payload: CreateTeamPayload }
	| { ok: false; errors: TeamDraftErrors };

/** The route body for a draft, or the fields the route would refuse. */
export function checkTeamDraft(draft: TeamDraftInput): TeamDraftCheck {
	const errors: TeamDraftErrors = {};
	const name = draft.name.trim();
	const baseBranch = draft.baseBranch.trim();
	if (!name) errors.name = "required";
	else if (!teamNameSchema.safeParse(name).success) errors.name = "invalid";
	// Empty uses the project's default branch, which the server checks itself.
	if (baseBranch && !teamBaseBranchSchema.safeParse(baseBranch).success)
		errors.baseBranch = "invalid";
	const brief = draft.brief.trim() ? draft.brief : "";
	if (brief && !teamBriefSchema.safeParse(brief).success) errors.brief = "tooLong";
	if (errors.name || errors.baseBranch || errors.brief) return { ok: false, errors };
	return {
		ok: true,
		payload: {
			name,
			...(baseBranch ? { baseBranch } : {}),
			...(brief ? { brief } : {}),
		},
	};
}
