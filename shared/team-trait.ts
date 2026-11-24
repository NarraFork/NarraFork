/**
 * The team coordinator trait, in a dependency-free leaf module.
 *
 * `server/lib/narrator-utils.ts` is part of the database read worker's module graph
 * (`server/lib/db-worker/__tests__/module-boundary.test.ts` allowlists every file in it), so
 * it must not import `shared/project-teams.ts` and its whole team model. Both that module and
 * `narrator-utils` re-export from here; keep this file free of imports.
 */

/**
 * Trait marking a team coordinator: the narrator that IS a project team, whose id is the team's
 * id. Always written with its `project_teams` row in one transaction: at creation, when a session
 * is upgraded to a team, and removed with the row when the team is disbanded and the session kept
 * (`server/services/teams/team-conversion.ts`).
 */
export const TEAM_TRAIT = "team";

/** Whether a narrator's traits (as the API returns them) mark it as a team coordinator. */
export function hasTeamTrait(traits: unknown): boolean {
	return Array.isArray(traits) && traits.includes(TEAM_TRAIT);
}
