/**
 * An agent's `replace` of a block someone else changed after the agent read it, merged three
 * ways (design §6.5, P1b): the change from the version the agent read (`base`, the read ledger's
 * version) to what it wrote (`mine`) is applied to the block as it is now (`theirs`).
 *
 *   - Text: the strict three-way merge of `edit-text.ts` (`mergeContent`) on canonical content,
 *     inline when small and on the outline text worker otherwise. Changes that do not overlap
 *     both stay; any overlap refuses the block, naming where.
 *   - Fields the replace sets (checkbox, assignee, prerequisites, due date, alias, tags), one by
 *     one: a field the agent left as it read it is not written (someone may have changed it
 *     since); one it changed is written when nobody else changed it, and refuses the block when
 *     someone changed it to something else.
 *   - A block whose read version is no longer in its history, or which is deleted now, is
 *     refused.
 *
 * Runs behind the live session barrier (`live-barrier.ts`): `theirs` includes what people typed
 * into a live page up to now, committed by the barrier. The caller refuses the whole call when
 * any block is refused (nothing is written), and otherwise writes the merged blocks as ordinary
 * updates marked `merged` (`OUTLINE_CHANGE.MERGE` on their versions).
 */
import type { LinkTarget } from "@shared/outline";
import {
	type EditTextMerged,
	type EditTextMergeInput,
	type EditTextOverlap,
	editTextJobBytes,
} from "./edit-text";
import {
	type EditTextRunOptions,
	OUTLINE_EDIT_TEXT_LIMITS,
	OutlineEditTextError,
	processEditText,
} from "./edit-text-runner";
import { type ExtractedLink, linkKey, tagLinks } from "./links";
import { OUTLINE_TOOL_TEXT } from "./messages";
import { OUTLINE_LIMITS, type OutlineTaskJson } from "./model";
import type { OutlineBlockRow, OutlineStore, OutlineVersionRow } from "./store/port";
import type { OutlineTaskPatch } from "./write";

/** A field of a block a `replace` may set besides its text. */
export type AgentMergeField = "checkbox" | "assignee" | "depends" | "due" | "alias" | "tags";

/** What a `replace` writes to an existing block, as planned from the agent's text. */
export interface AgentReplace {
	blockId: string;
	/** The version the agent last read (`version_seq`, from the read ledger). */
	seen: number;
	/** Canonical new content. */
	content: string;
	/** The fields the text sets; absent ones are not written. */
	alias?: string;
	tags?: string[];
	task?: OutlineTaskPatch;
}

export type AgentMergeRefusal =
	/** The text changes overlap. */
	| "overlap"
	/** Both changed the same field differently. */
	| "fields"
	/** The merged text is not canonical: the two changes meet in markup. */
	| "unstable"
	/** The version the agent read is not in the block's history. */
	| "no-base"
	/** The block is deleted now. */
	| "deleted";

export type AgentMerge =
	| {
			ok: true;
			blockId: string;
			content: string;
			links: ExtractedLink[];
			/** Fields to write; the ones the agent left as it read them are dropped. */
			alias?: string;
			tags?: string[];
			task?: OutlineTaskPatch;
	  }
	| {
			ok: false;
			blockId: string;
			reason: AgentMergeRefusal;
			/** For `overlap`: where, as excerpts of the text the agent read. */
			overlaps?: string[];
			/** For `fields`: which. */
			fields?: AgentMergeField[];
	  };

/** Merge inputs per text job: within the runner's per-job byte bound, as the live session does. */
const JOB_BYTES = 192 * 1024;
/** Characters of an overlap excerpt. */
const EXCERPT_CHARS = 60;

function flat(text: string): string {
	return text.replace(/\s+/g, " ");
}

function clipEnd(text: string, max: number): string {
	const chars = Array.from(text);
	return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

function clipStart(text: string, max: number): string {
	const chars = Array.from(text);
	return chars.length <= max ? text : `…${chars.slice(chars.length - max + 1).join("")}`;
}

/** An overlap as the agent can find it in what it read: the range, or the spot (`‸`). */
export function overlapExcerpt(base: string, overlap: EditTextOverlap): string {
	if (overlap.end > overlap.start)
		return clipEnd(flat(base.slice(overlap.start, overlap.end)).trim(), EXCERPT_CHARS) || "␣";
	const half = Math.floor(EXCERPT_CHARS / 2);
	return `${clipStart(flat(base.slice(0, overlap.start)), half)}‸${clipEnd(
		flat(base.slice(overlap.start)),
		half,
	)}`;
}

function canonicalDepends(depends: readonly LinkTarget[] | null | undefined): string {
	const seen = new Set<string>();
	const out: Array<[string, string | null]> = [];
	for (const d of depends ?? []) {
		const entry: [string, string | null] = [d.target.trim(), d.label ?? null];
		const key = JSON.stringify(entry);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(entry);
	}
	return JSON.stringify(out);
}

function tagSet(keys: Iterable<string>): string {
	return JSON.stringify([...new Set(keys)].sort());
}

/** A field's value in comparable form. */
function taskField(task: OutlineTaskJson | null, field: AgentMergeField): string {
	switch (field) {
		case "checkbox":
			return task?.status ?? "";
		case "assignee":
			return task?.assignee ?? "";
		case "depends":
			return canonicalDepends(task?.depends);
		default:
			return task?.due ?? "";
	}
}

/**
 * Three-way merge of one field: `null` drops it (the agent kept what it read), `true` writes it,
 * `false` is a conflict.
 */
function mergeField(mine: string, base: string, theirs: string): boolean | null {
	if (mine === base) return null;
	return theirs === base || theirs === mine;
}

interface FieldPlan {
	alias?: string;
	tags?: string[];
	task?: OutlineTaskPatch;
	conflicts: AgentMergeField[];
}

function mergeFields(
	replace: AgentReplace,
	base: OutlineVersionRow,
	now: OutlineBlockRow,
	tags: { base: string; now: string } | undefined,
): FieldPlan {
	const plan: FieldPlan = { conflicts: [] };
	const decide = (field: AgentMergeField, mine: string, b: string, t: string) => {
		const verdict = mergeField(mine, b, t);
		if (verdict === false) plan.conflicts.push(field);
		return verdict === true;
	};
	if (
		replace.alias !== undefined &&
		decide("alias", replace.alias, base.alias ?? "", now.alias ?? "")
	)
		plan.alias = replace.alias;
	if (replace.tags !== undefined && tags) {
		const mine = tagSet(tagLinks(replace.tags).map(linkKey));
		if (decide("tags", mine, tags.base, tags.now)) plan.tags = replace.tags;
	}
	const task = replace.task;
	if (task) {
		const patch: OutlineTaskPatch = {};
		const given: Array<[AgentMergeField, keyof OutlineTaskPatch, string]> = [];
		if (task.status !== undefined) given.push(["checkbox", "status", task.status]);
		if (task.assignee !== undefined) given.push(["assignee", "assignee", task.assignee ?? ""]);
		if (task.depends !== undefined)
			given.push(["depends", "depends", canonicalDepends(task.depends)]);
		if (task.due !== undefined) given.push(["due", "due", task.due ?? ""]);
		for (const [field, key, mine] of given) {
			if (decide(field, mine, taskField(base.taskJson, field), taskField(now.taskJson, field)))
				Object.assign(patch, { [key]: task[key] });
		}
		// Task details on a block that is no longer a task: its checkbox was taken away since.
		if (Object.keys(patch).length > 0 && patch.status === undefined && now.taskJson === null) {
			if (!plan.conflicts.includes("checkbox")) plan.conflicts.push("checkbox");
		} else if (Object.keys(patch).length > 0) plan.task = patch;
	}
	return plan;
}

/** Tag link keys of blocks at a seq (`null`: now), by block. */
async function tagsAt(
	store: OutlineStore,
	blockIds: readonly string[],
	seq: number | null,
): Promise<Map<string, string>> {
	const rows = await store.listLinksAt(
		blockIds,
		seq,
		["tag"],
		blockIds.length * OUTLINE_LIMITS.maxTagsPerBlock,
	);
	const keys = new Map<string, string[]>(blockIds.map((id) => [id, []]));
	for (const row of rows) keys.get(row.fromBlockId)?.push(linkKey(row));
	return new Map([...keys].map(([id, list]) => [id, tagSet(list)]));
}

/** Text merges, cut into jobs of the runner's size. */
async function mergeTexts(
	inputs: readonly EditTextMergeInput[],
	signal: AbortSignal | undefined,
	deadline: number,
): Promise<EditTextMerged[]> {
	const out: EditTextMerged[] = [];
	let batch: EditTextMergeInput[] = [];
	let bytes = 0;
	const run = async () => {
		if (batch.length === 0) return;
		const left = deadline - Date.now();
		const tooSlow = () =>
			new AgentMergeLimitError(OUTLINE_TOOL_TEXT.edit.mergeTooSlow(AGENT_MERGE_LIMITS.timeMs));
		if (left <= 0) throw tooSlow();
		// The budget covers waiting for the text runner too (other jobs may be queued ahead):
		// past it the job is cancelled and its result dropped, whether it ran or still waits.
		const controller = new AbortController();
		const cancel = () => controller.abort();
		signal?.addEventListener("abort", cancel, { once: true });
		let timer: ReturnType<typeof setTimeout> | undefined;
		let timedOut = false;
		const expired = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				timedOut = true;
				reject(tooSlow());
				controller.abort();
			}, left);
		});
		const job = AGENT_MERGE_HOOKS.run(
			{ kind: "merge", merges: batch },
			{ signal: controller.signal, timeoutMs: Math.min(left, OUTLINE_EDIT_TEXT_LIMITS.timeoutMs) },
		);
		// Lost the race: its rejection (cancelled) has nobody to tell.
		job.catch(() => {});
		try {
			out.push(...(await Promise.race([job, expired])));
		} catch (error) {
			if (
				timedOut ||
				(error instanceof OutlineEditTextError && error.code === "OUTLINE_TEXT_TIMEOUT")
			)
				throw tooSlow();
			throw error;
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", cancel);
		}
		batch = [];
		bytes = 0;
	};
	for (const input of inputs) {
		const size = editTextJobBytes({ kind: "merge", merges: [input] });
		if (bytes + size > JOB_BYTES) await run();
		batch.push(input);
		bytes += size;
	}
	await run();
	return out;
}

/** Bounds of one call's merges, which run while the space's lane is held. */
export const AGENT_MERGE_LIMITS = {
	/** All the merges of one call: past this the call is refused, nothing written. */
	timeMs: 5_000,
};

/** Where merges run; tests replace it (a slow runner, a busy queue). */
export const AGENT_MERGE_HOOKS: {
	run: (
		job: { kind: "merge"; merges: EditTextMergeInput[] },
		options: EditTextRunOptions,
	) => Promise<EditTextMerged[]>;
} = { run: (job, options) => processEditText(job, options) };

/** The merges of one call would take too much (text or time); nothing was written. */
export class AgentMergeLimitError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AgentMergeLimitError";
	}
}

/**
 * Merge each replace onto its block as it is now. One result per replace, in order.
 *
 * Bounded before any merge: each new text at most `OUTLINE_LIMITS.maxBodyBytes`, the blocks'
 * current texts together at most `maxTheirsBytes` (what one transaction may carry besides the
 * call's other text); and all merges together within {@link AGENT_MERGE_LIMITS.timeMs}. Past
 * either it throws {@link AgentMergeLimitError}. Throws what the text runner throws otherwise
 * (`OutlineEditTextError`: busy, cancelled).
 */
export async function mergeAgentReplaces(
	store: OutlineStore,
	replaces: readonly AgentReplace[],
	options: { signal?: AbortSignal; maxTheirsBytes?: number } = {},
): Promise<AgentMerge[]> {
	if (replaces.length === 0) return [];
	const deadline = Date.now() + AGENT_MERGE_LIMITS.timeMs;
	for (const r of replaces) {
		const bytes = Buffer.byteLength(r.content, "utf8");
		if (bytes > OUTLINE_LIMITS.maxBodyBytes)
			throw new AgentMergeLimitError(
				OUTLINE_TOOL_TEXT.edit.mergeBodyTooLarge(bytes, OUTLINE_LIMITS.maxBodyBytes),
			);
	}
	const ids = replaces.map((r) => r.blockId);
	// The version valid when the agent read (a block its own commit left unchanged was recorded
	// at that commit's seq, after the version's own).
	const bases = new Map(
		(
			await store.listVersionsAtSeqs(replaces.map((r) => ({ blockId: r.blockId, seq: r.seen })))
		).map((v) => [v.blockId, v]),
	);
	const rows = new Map((await store.getBlocks(ids)).map((b) => [b.id, b]));
	const maxTheirs = options.maxTheirsBytes ?? OUTLINE_LIMITS.maxTransactionBodyBytes;
	let theirsBytes = 0;
	for (const row of rows.values()) theirsBytes += Buffer.byteLength(row.content, "utf8");
	if (theirsBytes > maxTheirs)
		throw new AgentMergeLimitError(
			OUTLINE_TOOL_TEXT.edit.mergeTooLarge(theirsBytes, Math.max(0, maxTheirs)),
		);
	const tagged = replaces.filter((r) => r.tags !== undefined);
	const tagsNow =
		tagged.length > 0
			? await tagsAt(
					store,
					tagged.map((r) => r.blockId),
					null,
				)
			: null;
	const tagsBase = new Map<string, string>();
	const bySeen = new Map<number, string[]>();
	for (const r of tagged) bySeen.set(r.seen, [...(bySeen.get(r.seen) ?? []), r.blockId]);
	for (const [seq, blockIds] of bySeen) {
		for (const [id, keys] of await tagsAt(store, blockIds, seq)) tagsBase.set(id, keys);
	}

	const results: Array<AgentMerge | undefined> = [];
	const texts: Array<{ index: number; input: EditTextMergeInput; fields: FieldPlan }> = [];
	for (const [index, replace] of replaces.entries()) {
		const base = bases.get(replace.blockId);
		const now = rows.get(replace.blockId);
		const refuse = (reason: AgentMergeRefusal, fields?: AgentMergeField[]) => {
			results[index] = {
				ok: false,
				blockId: replace.blockId,
				reason,
				...(fields ? { fields } : {}),
			};
		};
		if (!now || now.deleted) {
			refuse("deleted");
			continue;
		}
		if (!base || base.deleted || base.content === null) {
			refuse("no-base");
			continue;
		}
		const tags =
			replace.tags !== undefined
				? {
						base: tagsBase.get(replace.blockId) ?? "[]",
						now: tagsNow?.get(replace.blockId) ?? "[]",
					}
				: undefined;
		const fields = mergeFields(replace, base, now, tags);
		if (fields.conflicts.length > 0) {
			refuse("fields", fields.conflicts);
			continue;
		}
		texts.push({
			index,
			input: { base: base.content, mine: replace.content, theirs: now.content },
			fields,
		});
	}

	const merged = await mergeTexts(
		texts.map((t) => t.input),
		options.signal,
		deadline,
	);
	texts.forEach(({ index, input, fields }, k) => {
		const replace = replaces[index] as AgentReplace;
		const m = merged[k] as EditTextMerged;
		if (!m.ok) {
			results[index] =
				m.reason === "overlap"
					? {
							ok: false,
							blockId: replace.blockId,
							reason: "overlap",
							overlaps: m.overlaps.map((o) => overlapExcerpt(input.base, o)),
						}
					: { ok: false, blockId: replace.blockId, reason: "unstable" };
			return;
		}
		results[index] = {
			ok: true,
			blockId: replace.blockId,
			content: m.content,
			links: m.links,
			...(fields.alias !== undefined ? { alias: fields.alias } : {}),
			...(fields.tags !== undefined ? { tags: fields.tags } : {}),
			...(fields.task !== undefined ? { task: fields.task } : {}),
		};
	});
	return results as AgentMerge[];
}
