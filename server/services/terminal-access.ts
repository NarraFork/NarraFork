/**
 * Who may use a terminal (REST `/api/terminals/:id`, the terminal WebSocket).
 *
 * A terminal owned by a narrator follows that narrator's ACL (`narrator-acl.ts`; a subagent's
 * is its ACL root's):
 *
 * - `read`: its metadata (name, directory, status). Listing a narrator's terminals is the same.
 * - `write`: everything that opens it: watching its output and scrollback, typing into it,
 *   resizing, renaming, closing, reading its process list, and creating one on the narrator.
 *   A terminal is a shell in the session's workspace, the same authority as driving it.
 *
 * A terminal without a narrator (a standalone shell, e.g. the setup wizard's) belongs to the
 * user who created it, plus admins. Its creator is remembered in memory only (there is no
 * column for it): after a restart such a terminal is admins' only. Who may create one is
 * unchanged.
 *
 * Unknown ids and refused ones get the same answer, so ids cannot be probed.
 */
import { eq } from "drizzle-orm";
import { db } from "../db";
import { narrators, terminals } from "../db/schema";
import {
	canReadNarrator,
	canWriteNarrator,
	NARRATOR_ACL_COLUMNS,
	type NarratorAccessNeed,
	type NarratorPrincipal,
} from "./narrator-acl";

/** Standalone terminals remembered per process; old entries go first past this many. */
const STANDALONE_CREATOR_LIMIT = 1_000;
const standaloneCreators = new Map<string, string>();

/** Record who created a standalone terminal (no narrator), so only they and admins use it. */
export function rememberStandaloneTerminalCreator(terminalId: string, userId: string): void {
	if (!userId) return;
	standaloneCreators.delete(terminalId);
	standaloneCreators.set(terminalId, userId);
	while (standaloneCreators.size > STANDALONE_CREATOR_LIMIT) {
		const oldest = standaloneCreators.keys().next().value;
		if (oldest === undefined) break;
		standaloneCreators.delete(oldest);
	}
}

/** Whether `principal` may use `narratorId`'s terminals with `need`. Unknown narrators: no. */
export async function narratorTerminalAccessAllowed(
	narratorId: string,
	principal: NarratorPrincipal,
	need: NarratorAccessNeed,
): Promise<boolean> {
	if (!principal.userId && !principal.isAdmin) return false;
	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: NARRATOR_ACL_COLUMNS,
	});
	if (!narrator) return false;
	return need === "write"
		? canWriteNarrator(narrator, principal)
		: canReadNarrator(narrator, principal);
}

/** Whether `principal` may use terminal `terminalId` with `need`. Unknown ids: no. */
export async function terminalAccessAllowed(
	terminalId: string,
	principal: NarratorPrincipal,
	need: NarratorAccessNeed,
): Promise<boolean> {
	if (!principal.userId && !principal.isAdmin) return false;
	const terminal = await db
		.select({ narratorId: terminals.narratorId })
		.from(terminals)
		.where(eq(terminals.id, terminalId))
		.get();
	if (!terminal) return false;
	if (terminal.narratorId)
		return narratorTerminalAccessAllowed(terminal.narratorId, principal, need);
	if (principal.isAdmin) return true;
	return standaloneCreators.get(terminalId) === principal.userId;
}

/** Tests only. */
export function resetTerminalAccessForTest(): void {
	standaloneCreators.clear();
}
