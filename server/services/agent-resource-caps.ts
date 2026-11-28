/**
 * Caps on the long-lived resources agents open (Project Teams S2, plan §二.3 and T6).
 *
 * A subagent may hold at most {@link SUBAGENT_TERMINAL_LIMIT} running terminals and
 * {@link SUBAGENT_BROWSER_SESSION_LIMIT} browser sessions; a whole team tree (the ACL root and
 * every subagent judged on it) at most {@link TEAM_BROWSER_SESSION_LIMIT} browser sessions,
 * counted only when one of its subagents launches; and the process at most
 * {@link PROCESS_BROWSER_SESSION_LIMIT} agent-launched browser sessions, for everyone. Over a
 * cap the launch or create is refused with a message saying what to close; nothing already
 * open is touched.
 *
 * Primary narrators' terminals are not capped (people open them by hand too) and a primary's
 * browser launches meet only the process cap, so nothing changes for sessions without
 * subagents.
 *
 * Reads are primary-key or indexed and bounded; counting browser sessions reads the in-memory
 * session registry. Concurrent creates of one owner are serialized so two calls cannot both
 * pass the check and exceed the cap.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db";
import { narrators, terminals } from "../db/schema";
import { ValidationError } from "../lib/errors";

/** Running terminals one subagent may hold. */
export const SUBAGENT_TERMINAL_LIMIT = 3;
/** Browser sessions one subagent may hold. */
export const SUBAGENT_BROWSER_SESSION_LIMIT = 2;
/** Browser sessions a team tree (ACL root and its subagents) may hold when a subagent launches. */
export const TEAM_BROWSER_SESSION_LIMIT = 6;
/**
 * Agent-launched browser sessions in the whole process. Each is a Chrome tab costing roughly
 * 100-300 MB; 20 leaves room for three full teams (3 × 6) plus a couple of primaries' sessions
 * while keeping a runaway fan-out from exhausting the host's memory.
 */
export const PROCESS_BROWSER_SESSION_LIMIT = 20;

interface OwnerRow {
	id: string;
	type: string;
	status: string;
	parentNarratorId: string | null;
	aclRootNarratorId: string | null;
}

async function loadOwner(narratorId: string): Promise<OwnerRow | undefined> {
	return db
		.select({
			id: narrators.id,
			type: narrators.type,
			status: narrators.status,
			parentNarratorId: narrators.parentNarratorId,
			aclRootNarratorId: narrators.aclRootNarratorId,
		})
		.from(narrators)
		.where(eq(narrators.id, narratorId))
		.get();
}

/** The tree a narrator belongs to: its ACL root, or itself for a root. */
function teamRootOfRow(row: OwnerRow): string {
	return row.aclRootNarratorId ?? (row.type === "subagent" ? row.parentNarratorId : null) ?? row.id;
}

function isRetired(row: OwnerRow | undefined): boolean {
	return row?.type === "subagent" && row.status === "archived";
}

/**
 * An archived subagent: nobody drives it, so it gets no new terminal or browser session, and
 * one that finished opening after the archive is closed again by its caller.
 */
export async function isRetiredSubagent(narratorId: string): Promise<boolean> {
	return isRetired(await loadOwner(narratorId));
}

const RETIRED_MESSAGE = "This subagent is archived; it cannot open terminals or browser sessions.";

// ── Per-owner serialization ──

const chains = new Map<string, Promise<unknown>>();

/** Run `work` after every earlier call with the same key has settled. */
async function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
	const previous = chains.get(key) ?? Promise.resolve();
	const next = previous.catch(() => {}).then(work);
	chains.set(key, next);
	try {
		return await next;
	} finally {
		if (chains.get(key) === next) chains.delete(key);
	}
}

// ── Terminals ──

export function subagentTerminalLimitMessage(limit = SUBAGENT_TERMINAL_LIMIT): string {
	return (
		`This subagent already has ${limit} running terminals, the most a subagent may hold. ` +
		"Reuse one (Terminal action 'list'), or end one first: write Ctrl-C ('\\x03') and then " +
		"'exit\\n' to its shell."
	);
}

/**
 * Create a terminal for `narratorId` under the subagent cap. Primaries and terminals without
 * a narrator are created as before. The count and the create run serialized per narrator. An
 * archived subagent gets none; one archived while its shell was starting has it closed again
 * (`discard`) and the create fails.
 */
export async function withTerminalSlot<T>(
	narratorId: string | undefined,
	create: () => Promise<T>,
	discard: (created: T) => Promise<unknown>,
): Promise<T> {
	if (!narratorId) return create();
	return serialized(`terminal:${narratorId}`, async () => {
		const owner = await loadOwner(narratorId);
		if (isRetired(owner)) throw new ValidationError(RETIRED_MESSAGE, "SUBAGENT_ARCHIVED");
		if (owner?.type === "subagent") {
			const running = await db
				.select({ id: terminals.id })
				.from(terminals)
				.where(
					and(
						eq(terminals.narratorId, narratorId),
						eq(terminals.status, "running"),
						isNull(terminals.worktreeResourceId),
					),
				)
				.limit(SUBAGENT_TERMINAL_LIMIT)
				.all();
			if (running.length >= SUBAGENT_TERMINAL_LIMIT)
				throw new ValidationError(subagentTerminalLimitMessage(), "SUBAGENT_TERMINAL_LIMIT");
		}
		const created = await create();
		if (owner?.type === "subagent" && (await isRetiredSubagent(narratorId))) {
			await discard(created).catch(() => {});
			throw new ValidationError(RETIRED_MESSAGE, "SUBAGENT_ARCHIVED");
		}
		return created;
	});
}

// ── Browser sessions ──

/** Per-narrator browser session counts, read from the live session registry. */
export type BrowserSessionCounts = ReadonlyMap<string, number>;

interface PendingLaunch {
	narratorId: string;
	rootId: string;
}

/** Launches admitted but not yet registered as sessions (the tab is still opening). */
const pending = new Set<PendingLaunch>();
/** Team roots learned for narrators holding sessions; a narrator's ACL root never changes. */
const rootCache = new Map<string, string>();

export interface BrowserLaunchSlot {
	/** Call once the launch registered its session or failed. */
	release(): void;
}

export class BrowserSessionLimitError extends ValidationError {
	constructor(message: string) {
		super(message, "BROWSER_SESSION_LIMIT");
	}
}

function countFor(counts: BrowserSessionCounts, narratorId: string): number {
	let total = counts.get(narratorId) ?? 0;
	for (const launch of pending) if (launch.narratorId === narratorId) total++;
	return total;
}

function teamCount(counts: BrowserSessionCounts, rootId: string): number {
	let total = 0;
	for (const [narratorId, count] of counts)
		if (rootCache.get(narratorId) === rootId) total += count;
	for (const launch of pending) if (launch.rootId === rootId) total++;
	return total;
}

function processCount(counts: BrowserSessionCounts): number {
	let total = pending.size;
	for (const count of counts.values()) total += count;
	return total;
}

/** Learn the team roots of narrators holding sessions that this module has not seen yet. */
async function learnRoots(narratorIds: readonly string[]): Promise<void> {
	const unknown = narratorIds.filter((id) => !rootCache.has(id));
	if (unknown.length === 0) return;
	// Bounded by the process cap: only narrators that hold a live session are asked for.
	const rows = await db
		.select({
			id: narrators.id,
			type: narrators.type,
			status: narrators.status,
			parentNarratorId: narrators.parentNarratorId,
			aclRootNarratorId: narrators.aclRootNarratorId,
		})
		.from(narrators)
		.where(inArray(narrators.id, unknown.slice(0, PROCESS_BROWSER_SESSION_LIMIT * 2)))
		.all();
	for (const row of rows) rootCache.set(row.id, teamRootOfRow(row));
}

/** Forget roots of narrators that hold nothing any more, so the cache stays bounded. */
function pruneRoots(counts: BrowserSessionCounts): void {
	for (const narratorId of rootCache.keys()) {
		if ((counts.get(narratorId) ?? 0) > 0) continue;
		if ([...pending].some((launch) => launch.narratorId === narratorId)) continue;
		rootCache.delete(narratorId);
	}
}

/**
 * Admit one browser launch for `narratorId`, or throw {@link BrowserSessionLimitError} saying
 * which cap it would pass. `readCounts` returns the live per-narrator session counts; it is
 * read again after the only await, so the check and the reservation happen together.
 */
export async function reserveBrowserLaunch(
	narratorId: string,
	readCounts: () => BrowserSessionCounts,
	options: { headless?: boolean } = {},
): Promise<BrowserLaunchSlot> {
	const owner = await loadOwner(narratorId);
	if (isRetired(owner)) throw new BrowserSessionLimitError(RETIRED_MESSAGE);
	// A headed session may open as a tab in the person's own browser, with their sign-ins;
	// nobody watches a subagent's tab, so subagents browse headless only.
	if (owner?.type === "subagent" && options.headless === false)
		throw new BrowserSessionLimitError(
			"Subagents use headless browser sessions only; launch again without headless: false.",
		);
	const rootId = owner ? teamRootOfRow(owner) : narratorId;
	rootCache.set(narratorId, rootId);
	const subagent = owner?.type === "subagent";
	if (subagent) await learnRoots([...readCounts().keys()]);
	// From here to the reservation there is no await: concurrent launches see each other.
	const counts = readCounts();
	pruneRoots(counts);
	if (processCount(counts) >= PROCESS_BROWSER_SESSION_LIMIT)
		throw new BrowserSessionLimitError(
			`NarraFork already has ${PROCESS_BROWSER_SESSION_LIMIT} browser sessions open, the most ` +
				"it allows at once. Close a session you no longer need (Browser action 'close'), or " +
				"wait for idle sessions to expire, then launch again.",
		);
	if (subagent) {
		if (countFor(counts, narratorId) >= SUBAGENT_BROWSER_SESSION_LIMIT)
			throw new BrowserSessionLimitError(
				`This subagent already has ${SUBAGENT_BROWSER_SESSION_LIMIT} browser sessions, the ` +
					"most a subagent may hold. Reuse one (Browser action 'list_sessions' and 'navigate'), " +
					"or close one (Browser action 'close') before launching another.",
			);
		if (teamCount(counts, rootId) >= TEAM_BROWSER_SESSION_LIMIT)
			throw new BrowserSessionLimitError(
				`This team already has ${TEAM_BROWSER_SESSION_LIMIT} browser sessions open across its ` +
					"agents, the most a team may hold. Reuse a session you have, or report that the " +
					"browser is unavailable until another agent closes one.",
			);
	}
	const launch: PendingLaunch = { narratorId, rootId };
	pending.add(launch);
	return {
		release() {
			pending.delete(launch);
		},
	};
}

/** Whether a launch for this narrator is admitted and still opening its tab. */
export function hasPendingBrowserLaunch(narratorId: string): boolean {
	for (const launch of pending) if (launch.narratorId === narratorId) return true;
	return false;
}

/** Tests only. */
export function resetAgentResourceCapsForTest(): void {
	pending.clear();
	rootCache.clear();
	chains.clear();
}
