/**
 * What an outline tool call did, as data for the reader (`metadata.display`, version 1).
 *
 * An outline tool's result is written for the model: English, block ids in brackets, no titles
 * beside the ids of what it changed. The transcript used to show that text (and the call's input)
 * as the card's body. The server knows, at the moment it writes, what the reader wants instead —
 * the titles of the blocks it touched, a task's checkbox before and after, the blocks it created,
 * the space's name — so it stores that beside the result, and the card renders it as a list of
 * changes with titled outline links and status chips. The model-facing result is unchanged and
 * never derived from this.
 *
 * Bounded at the source ({@link OUTLINE_TOOL_DISPLAY_LIMITS}): a few hundred bytes for a typical
 * call, never more than {@link OUTLINE_TOOL_DISPLAY_LIMITS.bytes}, so it stays small in the tool
 * call's JSON and in every list that reads it. Read back defensively ({@link readOutlineEditDisplay}
 * and friends): a row written by another version, or edited by hand, cannot break a card.
 *
 * Zero DOM, no server imports (reachable from `shared/pretext-layout/tool-detail.ts`).
 */
import { clipNoticeLine } from "./outline-task-notice";

/** A task's checkbox status, as the outline stores it. */
export type OutlineDisplayStatus = "todo" | "doing" | "done" | "cancelled";

/** A block a call touched: its address and its title then. */
export interface OutlineDisplayRef {
	/** `key/sid`: what its outline link opens. */
	address: string;
	/** Its title when the call ran: one plain line (empty when it had none). */
	title: string;
}

/** The space a call wrote or read. */
export interface OutlineDisplaySpace {
	key: string;
	kind: string;
	/** The project's name, or the session's title (not for this session's own notes). */
	name?: string;
	/** This session's own notes, or the personal space of the person it works for. */
	own?: true;
}

/** A block an add created. */
export interface OutlineDisplayCreated extends OutlineDisplayRef {
	/** 0 for a block added directly under the parent, 1 under one of those, and so on. */
	depth: number;
	/** Its checkbox, when it is a task. */
	status?: OutlineDisplayStatus;
}

/** One edit of an OutlineEdit call, as it was written. */
export type OutlineEditDisplayOp =
	| {
			op: "add";
			/** Null: new pages at the top of the space. */
			parent: OutlineDisplayRef | null;
			created: OutlineDisplayCreated[];
			/** Created blocks not listed. */
			more?: number;
			held?: true;
	  }
	| {
			op: "set";
			target: OutlineDisplayRef;
			/** The checkbox before and after (null: no checkbox). */
			status?: { from: OutlineDisplayStatus | null; to: OutlineDisplayStatus | null };
			/** The new assignee (null: none). */
			assignee?: { to: string | null };
			/** The new alias (null: none). */
			alias?: { to: string | null };
			held?: true;
	  }
	| { op: "replace"; target: OutlineDisplayRef; merged?: true; held?: true }
	| {
			op: "move";
			target: OutlineDisplayRef;
			/** Null: made a page. */
			to: OutlineDisplayRef | null;
			held?: true;
	  }
	| {
			op: "delete";
			target: OutlineDisplayRef;
			/** Blocks under it that went with it. */
			under?: number;
			held?: true;
	  };

/** OutlineEdit's `metadata.display`. */
export interface OutlineEditDisplay {
	v: 1;
	space: OutlineDisplaySpace;
	ops: OutlineEditDisplayOp[];
	/** Edits not listed. */
	more?: number;
	/**
	 * What the whole call did, counted before any edit was left out of `ops` (held edits not
	 * counted: they wrote nothing yet): the figures of the card's header.
	 */
	totals: OutlineEditDisplayTotals;
	/** The change the call's held edits wait in, and who decides it. */
	pending?: { label: string; decider?: string };
}

/** Tasks ticked done, blocks added, blocks deleted (with what was under them). */
export interface OutlineEditDisplayTotals {
	done: number;
	added: number;
	removed: number;
}

/** OutlineRead's `metadata.display`. */
export interface OutlineReadDisplay {
	v: 1;
	space: OutlineDisplaySpace;
}

/** A question an Ask call named (withdrawn, or answered for the person). */
export interface OutlineAskDisplayQuestion {
	address: string;
	alias?: string;
	title: string;
}

/** Ask's `metadata.display`. */
export interface OutlineAskDisplay {
	v: 1;
	/** The space the questions were asked in (a call that asked). */
	space?: OutlineDisplaySpace;
	/** The block they were asked under (a call that asked). */
	under?: OutlineDisplayRef;
	/** The questions a withdraw or an answer written down named. */
	questions: OutlineAskDisplayQuestion[];
}

export const OUTLINE_TOOL_DISPLAY_LIMITS = {
	/** Edits listed; the rest are counted. */
	ops: 40,
	/** Blocks listed per add; the rest are counted. */
	created: 12,
	/** Characters of a title. */
	titleChars: 80,
	/** Characters of a name, an assignee or an alias. */
	nameChars: 60,
	/** Edits counted into the totals at most (a call makes at most 200). */
	countedOps: 1000,
	/** A total stored figure at most (beyond what any call can do; a larger one is forged). */
	maxTotal: 1_000_000,
	/** Questions listed. */
	questions: 20,
	/** UTF-8 bytes of the JSON at most: past it, edits are dropped from the end and counted. */
	bytes: 8192,
} as const;

const STATUSES = new Set<string>(["todo", "doing", "done", "cancelled"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown, max: number): string | undefined {
	return typeof value === "string" ? clipNoticeLine(value, max) : undefined;
}

function count(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function status(value: unknown): OutlineDisplayStatus | null {
	return typeof value === "string" && STATUSES.has(value) ? (value as OutlineDisplayStatus) : null;
}

/** A ref as a display keeps it, or null when it names no block. */
export function boundOutlineDisplayRef(raw: unknown): OutlineDisplayRef | null {
	if (!isRecord(raw)) return null;
	const address = str(raw.address, 200);
	if (!address) return null;
	return { address, title: str(raw.title, OUTLINE_TOOL_DISPLAY_LIMITS.titleChars) ?? "" };
}

function boundSpace(raw: unknown): OutlineDisplaySpace | null {
	if (!isRecord(raw)) return null;
	const key = str(raw.key, 64);
	const kind = str(raw.kind, 32);
	if (!key || !kind) return null;
	const name = str(raw.name, OUTLINE_TOOL_DISPLAY_LIMITS.nameChars);
	return { key, kind, ...(name ? { name } : {}), ...(raw.own === true ? { own: true } : {}) };
}

function boundTo(raw: unknown): { to: string | null } | undefined {
	if (!isRecord(raw) || !("to" in raw)) return undefined;
	return { to: str(raw.to, OUTLINE_TOOL_DISPLAY_LIMITS.nameChars) || null };
}

function boundOp(raw: unknown): OutlineEditDisplayOp | null {
	if (!isRecord(raw)) return null;
	const held = raw.held === true ? { held: true as const } : {};
	switch (raw.op) {
		case "add": {
			const parent = raw.parent === null ? null : boundOutlineDisplayRef(raw.parent);
			if (raw.parent !== null && !parent) return null;
			const list = Array.isArray(raw.created) ? raw.created : [];
			const created: OutlineDisplayCreated[] = [];
			for (const item of list.slice(0, OUTLINE_TOOL_DISPLAY_LIMITS.created)) {
				const ref = boundOutlineDisplayRef(item);
				if (!ref) continue;
				const rec = item as Record<string, unknown>;
				const depth = typeof rec.depth === "number" && rec.depth > 0 ? Math.min(8, rec.depth) : 0;
				const box = status(rec.status);
				created.push({ ...ref, depth: Math.floor(depth), ...(box ? { status: box } : {}) });
			}
			const more = (count(raw.more) ?? 0) + Math.max(0, list.length - created.length);
			return { op: "add", parent, created, ...(more > 0 ? { more } : {}), ...held };
		}
		case "set": {
			const target = boundOutlineDisplayRef(raw.target);
			if (!target) return null;
			const box = isRecord(raw.status)
				? { from: status(raw.status.from), to: status(raw.status.to) }
				: undefined;
			const assignee = boundTo(raw.assignee);
			const alias = boundTo(raw.alias);
			return {
				op: "set",
				target,
				...(box ? { status: box } : {}),
				...(assignee ? { assignee } : {}),
				...(alias ? { alias } : {}),
				...held,
			};
		}
		case "replace": {
			const target = boundOutlineDisplayRef(raw.target);
			if (!target) return null;
			return { op: "replace", target, ...(raw.merged === true ? { merged: true } : {}), ...held };
		}
		case "move": {
			const target = boundOutlineDisplayRef(raw.target);
			if (!target) return null;
			const to = raw.to === null ? null : boundOutlineDisplayRef(raw.to);
			if (raw.to !== null && !to) return null;
			return { op: "move", target, to, ...held };
		}
		case "delete": {
			const target = boundOutlineDisplayRef(raw.target);
			if (!target) return null;
			const under = count(raw.under);
			return { op: "delete", target, ...(under ? { under } : {}), ...held };
		}
		default:
			return null;
	}
}

function bytesOf(value: unknown): number {
	return new TextEncoder().encode(JSON.stringify(value)).length;
}

/**
 * An OutlineEdit display as it is stored and read: strings clipped, lists capped, unknown fields
 * dropped, and edits dropped from the end (and counted) until the JSON fits
 * {@link OUTLINE_TOOL_DISPLAY_LIMITS.bytes}. Null when it is not one.
 */
export function boundOutlineEditDisplay(raw: unknown): OutlineEditDisplay | null {
	if (!isRecord(raw) || raw.v !== 1) return null;
	const space = boundSpace(raw.space);
	if (!space || !Array.isArray(raw.ops)) return null;
	const ops: OutlineEditDisplayOp[] = [];
	const all: OutlineEditDisplayOp[] = [];
	let dropped = 0;
	for (const item of raw.ops.slice(0, OUTLINE_TOOL_DISPLAY_LIMITS.countedOps)) {
		const op = boundOp(item);
		if (op) all.push(op);
		if (op && ops.length < OUTLINE_TOOL_DISPLAY_LIMITS.ops) ops.push(op);
		else dropped++;
	}
	dropped += Math.max(0, raw.ops.length - OUTLINE_TOOL_DISPLAY_LIMITS.countedOps);
	// Counted over every edit the call made (the writer passes them all), before any is left
	// out; a stored display carries its totals and keeps them.
	const totals = boundTotals(raw.totals) ?? countOps(all);
	const pending = isRecord(raw.pending) ? str(raw.pending.label, 40) : undefined;
	const decider = isRecord(raw.pending)
		? str(raw.pending.decider, OUTLINE_TOOL_DISPLAY_LIMITS.nameChars)
		: undefined;
	const display: OutlineEditDisplay = {
		v: 1,
		space,
		ops,
		totals,
		...(pending ? { pending: { label: pending, ...(decider ? { decider } : {}) } } : {}),
	};
	let more = (count(raw.more) ?? 0) + dropped;
	if (more > 0) display.more = more;
	while (display.ops.length > 0 && bytesOf(display) > OUTLINE_TOOL_DISPLAY_LIMITS.bytes) {
		display.ops.pop();
		more++;
		display.more = more;
	}
	return display;
}

/** OutlineEdit's display off a call's metadata, or null (a call written before it existed). */
export function readOutlineEditDisplay(
	metadata: Record<string, unknown> | null | undefined,
): OutlineEditDisplay | null {
	return boundOutlineEditDisplay(metadata?.display);
}

/** OutlineRead's display off a call's metadata, or null. */
export function readOutlineReadDisplay(
	metadata: Record<string, unknown> | null | undefined,
): OutlineReadDisplay | null {
	const raw = metadata?.display;
	if (!isRecord(raw) || raw.v !== 1) return null;
	const space = boundSpace(raw.space);
	return space ? { v: 1, space } : null;
}

/** An Ask display (withdrawn questions, answers written down) as stored and read, or null. */
export function boundOutlineAskDisplay(raw: unknown): OutlineAskDisplay | null {
	if (!isRecord(raw) || raw.v !== 1) return null;
	const questions: OutlineAskDisplayQuestion[] = [];
	const list = Array.isArray(raw.questions) ? raw.questions : [];
	for (const item of list.slice(0, OUTLINE_TOOL_DISPLAY_LIMITS.questions)) {
		const ref = boundOutlineDisplayRef(item);
		if (!ref) continue;
		const alias = str((item as Record<string, unknown>).alias, 32);
		questions.push({ address: ref.address, title: ref.title, ...(alias ? { alias } : {}) });
	}
	const space = boundSpace(raw.space);
	const under = boundOutlineDisplayRef(raw.under);
	return { v: 1, ...(space ? { space } : {}), ...(under ? { under } : {}), questions };
}

/** Ask's display off a call's metadata, or null. */
export function readOutlineAskDisplay(
	metadata: Record<string, unknown> | null | undefined,
): OutlineAskDisplay | null {
	return boundOutlineAskDisplay(metadata?.display);
}

/** The space any outline tool's display names (`display.space`), or null. */
export function readOutlineDisplaySpace(
	metadata: Record<string, unknown> | null | undefined,
): OutlineDisplaySpace | null {
	const raw = metadata?.display;
	return isRecord(raw) && raw.v === 1 ? boundSpace(raw.space) : null;
}

/** The figures a header shows for an edit: tasks ticked done, blocks added and deleted. */
export function outlineEditDisplayCounts(display: OutlineEditDisplay): OutlineEditDisplayTotals {
	return display.totals;
}

function boundTotals(raw: unknown): OutlineEditDisplayTotals | null {
	if (!isRecord(raw)) return null;
	// No more than a call can have done (200 edits, each touching at most the rows one write
	// takes): a forged figure falls back to counting the listed edits.
	const n = (value: unknown) =>
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= 0 &&
		value <= OUTLINE_TOOL_DISPLAY_LIMITS.maxTotal
			? value
			: null;
	const done = n(raw.done);
	const added = n(raw.added);
	const removed = n(raw.removed);
	return done === null || added === null || removed === null ? null : { done, added, removed };
}

function countOps(ops: readonly OutlineEditDisplayOp[]): OutlineEditDisplayTotals {
	let done = 0;
	let added = 0;
	let removed = 0;
	for (const op of ops) {
		// A held edit wrote nothing yet: it waits for a person's confirmation.
		if (op.held) continue;
		if (op.op === "set" && op.status?.to === "done" && op.status.from !== "done") done++;
		else if (op.op === "add") added += op.created.length + (op.more ?? 0);
		else if (op.op === "delete") removed += 1 + (op.under ?? 0);
	}
	return { done, added, removed };
}
