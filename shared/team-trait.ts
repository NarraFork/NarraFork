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
 * id. Set at creation with its `project_teams` row and never toggled.
 */
export const TEAM_TRAIT = "team";

/** Whether a narrator's traits (as the API returns them) mark it as a team coordinator. */
export function hasTeamTrait(traits: unknown): boolean {
	return Array.isArray(traits) && traits.includes(TEAM_TRAIT);
}
