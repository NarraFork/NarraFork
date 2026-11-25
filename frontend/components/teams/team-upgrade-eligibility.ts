/**
 * Whether the session overflow menu offers 升级为团队 (upgrade to a team). The server decides
 * (`teams/team-conversion.ts`: owner or admin, idle, a local Git checkout of the project, a ceiling
 * that can start subagents); this only hides the entry where it can never succeed: a session that
 * is already a team, of a kind that is never one, archived, or with no known project.
 */

/** Session kinds (traits) that never become a team coordinator; `team` is one already. */
export const TEAM_UPGRADE_EXCLUDED_TRAITS = [
	"team",
	"bot",
	"knowledge-steward",
	"setup",
	"modeltrace",
	"ask-in-passing",
	"scheduled",
] as const;

export interface TeamUpgradeCandidate {
	type?: unknown;
	status?: unknown;
	traits?: unknown;
	scheduledTaskId?: unknown;
	hiddenFromLists?: unknown;
	oauthPolicySnapshotJson?: unknown;
}

export function canOfferTeamUpgrade(
	narrator: TeamUpgradeCandidate | null | undefined,
	projectId: string | null | undefined,
): boolean {
	if (!narrator || !projectId) return false;
	if (narrator.type !== "primary" || narrator.status === "archived") return false;
	if (narrator.scheduledTaskId || narrator.hiddenFromLists) return false;
	if (narrator.oauthPolicySnapshotJson !== null && narrator.oauthPolicySnapshotJson !== undefined)
		return false;
	const traits = Array.isArray(narrator.traits) ? narrator.traits : [];
	return !TEAM_UPGRADE_EXCLUDED_TRAITS.some((trait) => traits.includes(trait));
}
