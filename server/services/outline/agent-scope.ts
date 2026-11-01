/**
 * The outline as an agent working in a session sees it: the spaces it works in, which spaces it
 * may read and write, how its references resolve and how spaces are named to it. The agent tools
 * (`agent-read.ts`, `agent-edit.ts`) go through this and nothing else for access.
 *
 *   - READ: what the session may read (`session-scope.ts`): everyone who can read the session
 *     can read whatever the agent reads. The person running the turn decides only the personal
 *     space, and a turn with no person behind it reads nothing personal. That covers other
 *     spaces too (other projects', other sessions'): the agent names them by key, finds them in
 *     the overview of every readable space, or searches them all.
 *   - WRITE: what the person running the turn may write (`access.ts`), in spaces the session may
 *     also read (an edit resolves its addresses there and reports back from there). A turn with
 *     no person behind it writes nothing. In read-only and strict plan mode only the session's
 *     own space is written: planning notes stay possible, shared spaces stay untouched.
 *
 * SPACE NAMES
 * -----------
 * A space is named by its key (`Kx81mPqa`) or by one of three words for the session's own
 * spaces: `project` (its main project's), `session` (its working notes; a subagent shares its
 * root's) and `personal` (the acting person's own). A space the session may not read is never
 * found by either, so a reference into it reads as "nothing matches", exactly like a reference
 * to nothing. Bare ids, aliases and titles are looked up in the own spaces only; a block of any
 * other space is addressed as `key/sid`, which is how reads label it.
 *
 * One scope serves one tool call; verdicts are memoized for its length only (the session read
 * scope caches across calls itself).
 */
import { canAgentWriteSpace, type OutlinePrincipal } from "./access";
import {
	readNarratorTitle,
	readNonAdminUserIds,
	readProjectName,
	readUserExists,
} from "./access-reads";
import { OUTLINE_TOOL_TEXT } from "./messages";
import { type OutlineResolution, resolveAddress } from "./resolve";
import { canSessionReadSpace, listSessionReadableSpaces } from "./session-scope";
import {
	ensurePersonalSpace,
	ensureProjectSpace,
	ensureSessionSpace,
	findPersonalSpace,
	type NarratorSpaces,
	resolveNarratorSpaces,
} from "./spaces";
import { outlineStore } from "./store";
import type { OutlineSpaceRow, OutlineStore } from "./store/port";

export interface OutlineAgentContext {
	narratorId: string;
	/** The person this turn runs for; null for routine and system turns. */
	userId: string | null;
	/** Writes are limited to the session's own space (read-only or strict plan mode). */
	sessionSpaceOnly?: boolean;
}

/** Words standing for the session's own spaces. */
export const OUTLINE_SPACE_WORDS = ["project", "session", "personal"] as const;
export type OutlineSpaceWord = (typeof OUTLINE_SPACE_WORDS)[number];

function isSpaceWord(name: string): name is OutlineSpaceWord {
	return (OUTLINE_SPACE_WORDS as readonly string[]).includes(name);
}

/** Why an agent may not write a space. */
export type OutlineWriteRefusal = "no-person" | "plan-or-read-only" | "no-permission";

/** A readable space and, for one of the session's own, the word that names it. */
export interface OutlineReadableSpace {
	space: OutlineSpaceRow;
	word: OutlineSpaceWord | null;
}

/** A reference to a space as a whole: `key/`, `project/`, or `/` for the default space. */
export function spaceRootName(ref: string): string | null {
	const t = ref.trim();
	if (t === "/" || t === "") return "";
	const m = /^([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/$/.exec(t);
	return m ? (m[1] as string) : null;
}

/** A reference as written, without `[[…]]`, a display text or the brackets of a read's label. */
export function bareReference(ref: string): string {
	let t = ref.trim();
	if (t.startsWith("[[") && t.endsWith("]]")) {
		t = t.slice(2, -2);
		const bar = t.indexOf("|");
		if (bar >= 0) t = t.slice(0, bar);
	} else if (/^\[[^[\]]+\]$/.test(t)) t = t.slice(1, -1);
	return t.trim();
}

/**
 * What a space that does not exist yet will be, for deciding access before creating it: access
 * depends only on its kind and owner.
 */
function pendingSpace(
	scope:
		| { kind: "project"; projectId: string }
		| { kind: "personal"; ownerUserId: string }
		| { kind: "session"; narratorId: string },
): OutlineSpaceRow {
	return {
		id: `pending:${scope.kind}`,
		key: "",
		kind: scope.kind,
		projectId: scope.kind === "project" ? scope.projectId : null,
		narratorId: scope.kind === "session" ? scope.narratorId : null,
		ownerUserId: scope.kind === "personal" ? scope.ownerUserId : null,
		nextSeq: 1,
		createdAt: "",
	};
}

export class OutlineAgentScope {
	private readonly readable = new Map<string, Promise<boolean>>();
	private readonly byKey = new Map<string, Promise<OutlineSpaceRow | null>>();
	private personalSpace: OutlineSpaceRow | null | undefined;
	private principalValue: Promise<OutlinePrincipal | null> | undefined;

	private constructor(
		readonly ctx: OutlineAgentContext,
		private spaces: NarratorSpaces | null,
	) {}

	/** The configured outline store (the one the space and access modules use too). */
	get store(): OutlineStore {
		return outlineStore;
	}

	static async open(ctx: OutlineAgentContext): Promise<OutlineAgentScope> {
		return new OutlineAgentScope(ctx, await resolveNarratorSpaces(ctx.narratorId));
	}

	/** The same turn's scope opened afresh, with nothing memoized: after access changed. */
	async reopen(): Promise<OutlineAgentScope> {
		return await OutlineAgentScope.open(this.ctx);
	}

	get narratorId(): string {
		return this.ctx.narratorId;
	}

	/** The narrator whose session space this is (the root, for a subagent). */
	get rootNarratorId(): string | null {
		return this.spaces?.rootNarratorId ?? null;
	}

	get session(): OutlineSpaceRow | null {
		return this.spaces?.session ?? null;
	}

	get project(): OutlineSpaceRow | null {
		return this.spaces?.project ?? null;
	}

	get projectId(): string | null {
		return this.spaces?.projectId ?? null;
	}

	/** Whether the session may read the space (memoized for this scope). */
	async canRead(space: OutlineSpaceRow): Promise<boolean> {
		let verdict = this.readable.get(space.id);
		if (!verdict) {
			verdict = canSessionReadSpace(this.ctx.narratorId, space, {
				executingUserId: this.ctx.userId,
			});
			this.readable.set(space.id, verdict);
		}
		return await verdict;
	}

	/** The acting person's personal space, if it exists and the session may read it. */
	async personal(): Promise<OutlineSpaceRow | null> {
		if (this.personalSpace === undefined) {
			const space = this.ctx.userId ? await findPersonalSpace(this.ctx.userId) : null;
			this.personalSpace = space && (await this.canRead(space)) ? space : null;
		}
		return this.personalSpace;
	}

	/** The session's own spaces that exist and are readable: project, session, personal. */
	async ownSpaces(): Promise<Array<{ word: OutlineSpaceWord; space: OutlineSpaceRow }>> {
		const out: Array<{ word: OutlineSpaceWord; space: OutlineSpaceRow }> = [];
		if (this.project && (await this.canRead(this.project))) {
			out.push({ word: "project", space: this.project });
		}
		if (this.session) out.push({ word: "session", space: this.session });
		const personal = await this.personal();
		if (personal) out.push({ word: "personal", space: personal });
		return out;
	}

	/** Where bare names are looked up first: the main project's space, else the session's. */
	async contextSpace(): Promise<OutlineSpaceRow | null> {
		if (this.project && (await this.canRead(this.project))) return this.project;
		return this.session;
	}

	/** A readable space by key, or null (unknown, or not readable). */
	async spaceByKey(key: string): Promise<OutlineSpaceRow | null> {
		let found = this.byKey.get(key);
		if (!found) {
			found = (async () => {
				const space = await this.store.getSpaceByKey(key);
				return space && (await this.canRead(space)) ? space : null;
			})();
			this.byKey.set(key, found);
		}
		return await found;
	}

	/** A readable space by key or word, or null (unknown, not readable, or not created yet). */
	async space(name: string): Promise<OutlineSpaceRow | null> {
		if (!isSpaceWord(name)) return await this.spaceByKey(name);
		const own = await this.ownSpaces();
		return own.find((entry) => entry.word === name)?.space ?? null;
	}

	/**
	 * Whether the space is one of the session's own: its main project's, its session space (its
	 * root's) or the acting person's personal space. Bare names are looked up only in them, so
	 * reads label blocks of any other space `key/sid`.
	 */
	isOwnSpace(space: OutlineSpaceRow): boolean {
		switch (space.kind) {
			case "project":
				return space.projectId !== null && space.projectId === this.projectId;
			case "session":
				return space.narratorId !== null && space.narratorId === this.rootNarratorId;
			case "personal":
				return space.ownerUserId !== null && space.ownerUserId === this.ctx.userId;
			default:
				return false;
		}
	}

	/**
	 * Every space the session may read, at most `limit`: its own first (as {@link ownSpaces}
	 * orders them), then other projects' and other sessions' (`listSessionReadableSpaces`).
	 * `cut` says why the list stopped short: `limit`, more are readable; `candidates`, the
	 * listing judged all it may and cannot tell.
	 */
	async readableSpaces(limit: number): Promise<{
		spaces: OutlineReadableSpace[];
		cut: "limit" | "candidates" | null;
		complete: boolean;
	}> {
		const own = await this.ownSpaces();
		const listed = await listSessionReadableSpaces(this.ctx.narratorId, {
			executingUserId: this.ctx.userId,
			limit,
		});
		const ownIds = new Set(own.map((entry) => entry.space.id));
		const spaces: OutlineReadableSpace[] = own.map((entry) => ({ ...entry }));
		for (const space of listed.spaces) {
			if (ownIds.has(space.id)) continue;
			// A verdict the listing reached is the one a read by key gets: remember it.
			this.readable.set(space.id, Promise.resolve(true));
			spaces.push({ space, word: null });
		}
		const cut = spaces.length > limit ? "limit" : listed.cut;
		return { spaces: spaces.slice(0, limit), cut, complete: cut === null };
	}

	/**
	 * One of the session's own spaces to write to, created if it does not exist yet, but only
	 * when the session could read it and this turn could write it (checked on what the space
	 * would be). `missing` when the session has no such space: no main project, no person.
	 */
	async ownSpaceForWrite(
		word: OutlineSpaceWord,
	): Promise<{ space: OutlineSpaceRow } | { refusal: OutlineWriteRefusal | "missing" }> {
		const userId = this.ctx.userId;
		let existing: OutlineSpaceRow | null;
		let pending: OutlineSpaceRow | null = null;
		switch (word) {
			case "session":
				existing = this.session;
				if (!existing && this.rootNarratorId) {
					pending = pendingSpace({ kind: "session", narratorId: this.rootNarratorId });
				}
				break;
			case "project":
				existing = this.project;
				if (!existing && this.projectId) {
					pending = pendingSpace({ kind: "project", projectId: this.projectId });
				}
				break;
			case "personal":
				existing = userId ? await findPersonalSpace(userId) : null;
				if (!existing && userId) pending = pendingSpace({ kind: "personal", ownerUserId: userId });
				break;
		}
		const candidate = existing ?? pending;
		if (!candidate || !(await this.canRead(candidate))) return { refusal: "missing" };
		const refusal = await this.writeRefusal(candidate);
		if (refusal) return { refusal };
		if (existing) return { space: existing };
		let created: OutlineSpaceRow;
		switch (word) {
			case "session":
				created = await ensureSessionSpace(this.narratorId);
				if (this.spaces) this.spaces = { ...this.spaces, session: created };
				break;
			case "project":
				created = await ensureProjectSpace(this.projectId as string);
				if (this.spaces) this.spaces = { ...this.spaces, project: created };
				break;
			case "personal":
				created = await ensurePersonalSpace(userId as string);
				this.personalSpace = created;
				break;
		}
		return { space: created };
	}

	/**
	 * Resolve a reference within what the session may read (see `resolve.ts` for the order).
	 * A `key/` or `word/` prefix names the space; bare names are looked up in `context` (by
	 * default {@link contextSpace}) first, then in the session's other spaces.
	 */
	async resolve(ref: string, context?: OutlineSpaceRow | null): Promise<OutlineResolution> {
		let text = bareReference(ref);
		const readable = new Set((await this.ownSpaces()).map((own) => own.space.id));
		const slash = text.indexOf("/");
		if (slash > 0) {
			const space = await this.space(text.slice(0, slash));
			if (space) {
				readable.add(space.id);
				text = `${space.key}${text.slice(slash)}`;
			}
		}
		const contextSpace = context === undefined ? await this.contextSpace() : context;
		if (contextSpace) readable.add(contextSpace.id);
		return await resolveAddress(text, {
			spaceId: contextSpace?.id ?? null,
			readableSpaceIds: [...readable],
			store: this.store,
		});
	}

	/** The person this turn runs for, with their role; null when there is none. */
	principal(): Promise<OutlinePrincipal | null> {
		this.principalValue ??= (async () => {
			const userId = this.ctx.userId;
			if (!userId || !(await readUserExists(userId))) return null;
			const nonAdmins = await readNonAdminUserIds([userId]);
			return { userId, isAdmin: !nonAdmins.has(userId) };
		})();
		return this.principalValue;
	}

	/** Whether this turn may write the space; the reason when it may not. */
	async writeRefusal(space: OutlineSpaceRow): Promise<OutlineWriteRefusal | null> {
		const principal = await this.principal();
		if (!principal) return "no-person";
		const ownSession =
			space.kind === "session" &&
			space.narratorId !== null &&
			space.narratorId === this.rootNarratorId;
		if (this.ctx.sessionSpaceOnly && !ownSession) return "plan-or-read-only";
		return (await canAgentWriteSpace(principal, space)) ? null : "no-permission";
	}

	/** How the space is named to the agent: its key and what it is. */
	async describe(space: OutlineSpaceRow): Promise<string> {
		return `${space.key} · ${await this.spaceName(space)}`;
	}

	/**
	 * How a block of the space is addressed to the agent: its sid in an own space (where a bare
	 * id is looked up), `key/sid` in any other.
	 */
	addressIn(space: OutlineSpaceRow): (sid: string) => string {
		const prefix = this.isOwnSpace(space) ? "" : `${space.key}/`;
		return (sid) => `${prefix}${sid}`;
	}

	/** What a read or an edit's result puts after a block's bullet: `[` its address `]`. */
	labelIn(space: OutlineSpaceRow): (sid: string) => string {
		const address = this.addressIn(space);
		return (sid) => `[${address(sid)}]`;
	}

	private async spaceName(space: OutlineSpaceRow): Promise<string> {
		switch (space.kind) {
			case "project": {
				const name = space.projectId ? await readProjectName(space.projectId) : null;
				const main = space.id === this.project?.id;
				return OUTLINE_TOOL_TEXT.spaceName.project(name, main);
			}
			case "session": {
				if (space.narratorId && space.narratorId === this.rootNarratorId) {
					return OUTLINE_TOOL_TEXT.spaceName.ownSession;
				}
				const title = space.narratorId ? await readNarratorTitle(space.narratorId) : null;
				return OUTLINE_TOOL_TEXT.spaceName.session(title);
			}
			case "personal":
				return space.ownerUserId && space.ownerUserId === this.ctx.userId
					? OUTLINE_TOOL_TEXT.spaceName.ownPersonal
					: OUTLINE_TOOL_TEXT.spaceName.personal;
			default:
				return space.kind;
		}
	}
}
