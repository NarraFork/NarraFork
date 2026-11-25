/**
 * Whether a narrator is a session of a team tree (a coordinator, or a subagent whose ACL root is
 * one), remembered per narrator id (M1). The IM gateway asks this before sending anything to a
 * chat; team-ness changes only through a few explicit paths, so the answer is cached, at most
 * {@link TEAM_SESSION_MEMO_LIMIT} ids, oldest dropped first.
 *
 * Forgotten when a narrator is deleted (`narrator:deleted`); wholesale after a session is turned
 * into a team or its team is disbanded (`team-conversion.ts`: the change reaches the session's
 * subagents too, whose ids are not listed anywhere cheap), and after a data import or a clear
 * (`data-portability.ts`): those replace rows wholesale, and an id could come back as a different
 * kind of session. Every path calls {@link forgetTeamSessions} after its commit.
 */
import { eventBus } from "../../lib/event-bus";
import { hotOnce, hotSafe } from "../../lib/hot-safe";
import { teamIdOfNarrator } from "./team-membership";

export const TEAM_SESSION_MEMO_LIMIT = 2000;

const memo = hotSafe("narrafork.teams.sessionMemo", () => new Map<string, boolean>());

export function isTeamSessionCached(narratorId: string): boolean {
	const known = memo.get(narratorId);
	if (known !== undefined) return known;
	const team = !!teamIdOfNarrator(narratorId);
	if (memo.size >= TEAM_SESSION_MEMO_LIMIT) {
		const oldest = memo.keys().next().value;
		if (oldest !== undefined) memo.delete(oldest);
	}
	memo.set(narratorId, team);
	return team;
}

/** Forget one narrator, or everything (no id). */
export function forgetTeamSessions(narratorId?: string): void {
	if (narratorId === undefined) memo.clear();
	else memo.delete(narratorId);
}

/** How many narrators are remembered (tests). */
export function teamSessionMemoSize(): number {
	return memo.size;
}

if (hotOnce("narrafork.teams.sessionMemo.listeners")) {
	eventBus.on("narrator:deleted", (event) => forgetTeamSessions(event.narratorId));
}
