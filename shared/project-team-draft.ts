/**
 * The fields a person types for a new team (name, base branch, brief), as Zod schemas shared by
 * the team route (`server/lib/validators/project-teams.ts`) and the dialogs that fill it
 * (`frontend/components/teams/team-draft.ts`). The new-session dialog's "start as a team" makes
 * the directory's project before the team route runs, so it validates the draft with these same
 * rules first: a draft the route would refuse never reaches the server.
 */
import { z } from "zod";
import {
	TEAM_BRANCH_MAX_LENGTH,
	TEAM_BRIEF_MAX_BYTES,
	TEAM_NAME_MAX_LENGTH,
} from "./project-teams";

const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength;

/** Reusable: valid git branch name (no flags, no special chars). */
export const gitBranchName = z.string().regex(/^[a-zA-Z0-9._\-/]+$/, "Invalid branch name");

/** The team name, which is the coordinator session's title. */
export const teamNameSchema = z.string().trim().min(1).max(TEAM_NAME_MAX_LENGTH);

/** The team brief: plain text, at most 4 KB of UTF-8. */
export const teamBriefSchema = z
	.string()
	.refine((value) => utf8Bytes(value) <= TEAM_BRIEF_MAX_BYTES, {
		message: `The team brief is limited to ${TEAM_BRIEF_MAX_BYTES} bytes`,
	});

/** A git branch name that cannot be read as an option, a range or a reflog expression. */
export const teamBaseBranchSchema = gitBranchName
	.max(TEAM_BRANCH_MAX_LENGTH)
	.refine(
		(value) =>
			!value.startsWith("-") &&
			!value.startsWith("/") &&
			!value.endsWith("/") &&
			!value.endsWith(".") &&
			!value.endsWith(".lock") &&
			!value.includes("..") &&
			!value.includes("//"),
		{ message: "Invalid branch name" },
	);
