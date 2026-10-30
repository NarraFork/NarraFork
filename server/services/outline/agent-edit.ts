/**
 * `OutlineEdit`: an agent's edits to one space become one commit.
 *
 * HOW A CALL IS WRITTEN
 * ---------------------
 *   1. Locate every address the edits name (`agent-scope.ts`: readable spaces only). `/` is the
 *      default space for new pages: the main project's when this turn may write it, else the
 *      session's own. All edits of a call must land in one space, which this turn must be
 *      allowed to write.
 *   2. Parse the markdown and texts (`edit-text.ts`, on a worker when large): read annotations
 *      and the ids a read puts after bullets are dropped, out-of-dialect structure becomes child
 *      blocks, and what was split, converted or kept as text comes back as notes.
 *   3. Resolve the links: `[[alias or title]]` that names one readable block becomes
 *      `[[key/sid]]`, as does a reference to a block added by the same call; a display text that
 *      repeats the target's title is dropped; anything else stays as written and is reported.
 *      `alias:: Q?` takes the next free number of that prefix in the space.
 *   4. Check what the agent read (the read ledger): a block it is changing that someone else
 *      changed after the agent last read it is merged when the edit is the block's only one and
 *      a `replace` (`agent-merge.ts`: the agent's change from the version it read, applied to
 *      the block as it is now; text changes that do not overlap and fields only one side
 *      changed). Anything else is a conflict: an overlap, a field both changed, or a move,
 *      delete or set of such a block. Two more refuse a call: a replace or delete of a block the
 *      agent has not read (the ledger lives in memory: nothing is read after a restart) whose
 *      latest version someone else wrote; and a delete of a block with live descendants someone
 *      else wrote since the agent read them (or that it never read), or with more of them than
 *      are checked. Those blocks are shown in full and then count as read, so the same edit goes
 *      through once the agent has seen them. One conflict refuses the whole call, reported with
 *      each conflicting block's current text and where it conflicts; nothing is written. This
 *      and the write run behind the live session barrier (`live-barrier.ts`), so edits still in
 *      a page's live session count as changes: they are committed first and merged with.
 *   5. Write one transaction with provenance (this narrator as actor, the turn's person as
 *      responsible, the message and tool call), content handed over already normalized. Merged
 *      blocks are ordinary updates marked `merged` (`OUTLINE_CHANGE.MERGE` on their versions),
 *      so the timeline replays them and a revert undoes them like any other commit.
 *
 * The result lists each edit's outcome with the addresses of new blocks, the notes, and hints
 * about the space (a page with the same title already exists); merged blocks are shown as they
 * now read, as a read shows them, and the ledger moves to the version written. Everything it
 * shows comes from the space being written, which the session may read.
 */

import { NotFoundError } from "@server/lib/errors";
import {
	type BodyRef,
	isAlias,
	type OutlineNote,
	parseAliasValue,
	TASK_BOX,
} from "@shared/outline";
import { readDisplayNames } from "./access-reads";
import {
	type AgentMerge,
	AgentMergeLimitError,
	type AgentReplace,
	mergeAgentReplaces,
} from "./agent-merge";
import { blockLinesForAgent, type OutlineToolOutput } from "./agent-read";
import {
	type OutlineAgentScope,
	type OutlineSpaceWord,
	type OutlineWriteRefusal,
	spaceRootName,
} from "./agent-scope";
import {
	EDIT_LABEL_RE,
	type EditTextItem,
	type EditTextParsed,
	type EditTextTarget,
} from "./edit-text";
import { OutlineEditTextError, processEditText } from "./edit-text-runner";
import {
	OutlineBusyError,
	OutlineConflictError,
	OutlineTaskClaimedError,
	OutlineWriteError,
} from "./errors";
import { newOutlineSid } from "./keys";
import { linkDisplayTitle } from "./link-display";
import { withOutlineLiveBarrier } from "./live-barrier";
import { OUTLINE_TOOL_TEXT } from "./messages";
import { OUTLINE_CHANGE, OUTLINE_LIMITS } from "./model";
import { forgetOutlineReads, recordOutlineReads, seenOutlineVersion } from "./read-ledger";
import type { OutlineResolvedBlock } from "./resolve";
import type {
	OutlineBlockMeta,
	OutlineBlockRow,
	OutlineCommitRow,
	OutlineSpaceRow,
	OutlineStore,
} from "./store/port";
import type { OutlineNode } from "./tree";
import {
	type OutlineBlockRef,
	type OutlineCanonicalContent,
	type OutlineOp,
	type OutlinePosition,
	type OutlineTaskInput,
	type OutlineTaskPatch,
	type OutlineWriteResult,
	writeOutline,
} from "./write";

/** A checkbox as written: the box character, the status, or `none` for no checkbox. */
export type OutlineCheckbox =
	| " "
	| "/"
	| "x"
	| "-"
	| "todo"
	| "doing"
	| "done"
	| "cancelled"
	| "none";

export type OutlineEditRequest =
	| { add: string; markdown: string; after?: string }
	| { replace: string; text: string }
	| { move: string; to: string; after?: string }
	| { delete: string }
	| { set: string; checkbox?: OutlineCheckbox; assignee?: string | null; alias?: string | null };

export interface OutlineEditInput {
	edits: OutlineEditRequest[];
	/** Commit summary for the timeline. */
	message?: string;
}

export interface OutlineEditProvenance {
	messageId: string | null;
	toolCallId: string | null;
	signal?: AbortSignal;
}

export const OUTLINE_EDIT_LIMITS = {
	maxEdits: OUTLINE_LIMITS.maxOps,
	/** Distinct link targets one call resolves; the rest stay as written. */
	maxReferences: 100,
	/** Ids copied from a read one call checks. */
	maxLabels: 500,
	/** Aliases of one prefix read to number the next one. */
	maxAliasesScanned: 2000,
	/** New pages checked for an existing page with the same title. */
	maxPageHints: 5,
	/** Characters of a conflicting block's current text shown. */
	maxConflictChars: 400,
	/** UTF-8 bytes of merged blocks' text a result shows; the rest are named only. */
	maxMergedBytes: 32 * 1024,
	/** Blocks under the blocks one call deletes that are checked for changes; more refuse it. */
	maxDeletedChecked: OUTLINE_LIMITS.maxRowsTouched,
	/** Conflicting blocks a result lists; the rest are counted. */
	maxConflictsListed: 50,
	/** UTF-8 bytes of conflicting blocks' current text a result shows in full (see below). */
	maxConflictShownBytes: 32 * 1024,
} as const;

/** Change flags that leave out every version of an actor (`findLastWrites`). */
const ALL_CHANGES = 0x7fffffff;
/** Change flags of a move: anyone's moves and page changes say nothing about the text. */
const MOVES = OUTLINE_CHANGE.MOVE | OUTLINE_CHANGE.PAGE;
/**
 * Change flags of the agent's own versions that leave the text as it was (moves, page changes,
 * checkbox and properties): they do not tell that it knows the text, and are left out.
 */
const OWN_NOT_TEXT =
	OUTLINE_CHANGE.MOVE | OUTLINE_CHANGE.PAGE | OUTLINE_CHANGE.TASK | OUTLINE_CHANGE.PROPS;

const STATUS_OF: Record<Exclude<OutlineCheckbox, "none">, OutlineTaskInput["status"]> = {
	" ": "todo",
	"/": "doing",
	x: "done",
	"-": "cancelled",
	todo: "todo",
	doing: "doing",
	done: "done",
	cancelled: "cancelled",
};

type EditKind = "add" | "replace" | "move" | "delete" | "set";

function kindOf(request: OutlineEditRequest): EditKind {
	if ("add" in request) return "add";
	if ("replace" in request) return "replace";
	if ("move" in request) return "move";
	if ("delete" in request) return "delete";
	return "set";
}

function targetOf(request: OutlineEditRequest): string {
	if ("add" in request) return request.add;
	if ("replace" in request) return request.replace;
	if ("move" in request) return request.move;
	if ("delete" in request) return request.delete;
	return request.set;
}

type Located =
	| { kind: "block"; block: OutlineResolvedBlock }
	| { kind: "root"; space: OutlineSpaceRow };

/** One item of an add or replace, with the sid it will get and its final content. */
interface PlannedItem {
	item: EditTextItem;
	sid: string;
	content: string;
	links: OutlineCanonicalContent["links"];
	alias?: string;
	children: PlannedItem[];
}

interface EditState {
	index: number;
	request: OutlineEditRequest;
	kind: EditKind;
	problems: string[];
	notes: string[];
	located?: Located;
	parent?: Located;
	after?: OutlineResolvedBlock;
	items?: PlannedItem[];
	/** For set: the alias asked for (`Q?` resolved later). */
	alias?: string | null;
	opIndexes: number[];
}

function clip(text: string, max = 80): string {
	const flat = text.replace(/\s+/g, " ").trim();
	const chars = Array.from(flat);
	return chars.length <= max ? flat : `${chars.slice(0, max - 1).join("")}…`;
}

function label(edit: EditState): string {
	return OUTLINE_TOOL_TEXT.edit.label(edit.index + 1, edit.kind, clip(targetOf(edit.request), 60));
}

function refusalText(refusal: OutlineWriteRefusal | "missing", space: string): string {
	switch (refusal) {
		case "no-person":
			return OUTLINE_TOOL_TEXT.edit.noPerson;
		case "plan-or-read-only":
			return OUTLINE_TOOL_TEXT.edit.sessionOnly;
		case "no-permission":
			return OUTLINE_TOOL_TEXT.edit.noPermission(space);
		case "missing":
			return OUTLINE_TOOL_TEXT.noSuchSpace(space);
	}
}

/** Where an address points: a block (live), or a space as a whole (`key/`, `word/`, `/`). */
async function locate(
	scope: OutlineAgentScope,
	ref: string,
	allowRoot: boolean,
	notes: string[],
): Promise<Located | { problem: string }> {
	const root = allowRoot ? spaceRootName(ref) : null;
	if (root !== null) {
		if (root === "") {
			const project = await scope.ownSpaceForWrite("project");
			if ("space" in project) return { kind: "root", space: project.space };
			const session = await scope.ownSpaceForWrite("session");
			if ("space" in session) {
				if (scope.projectId) notes.push(OUTLINE_TOOL_TEXT.edit.defaultToSession);
				return { kind: "root", space: session.space };
			}
			return { problem: refusalText(session.refusal, "session/") };
		}
		if (root === "project" || root === "session" || root === "personal") {
			const own = await scope.ownSpaceForWrite(root as OutlineSpaceWord);
			return "space" in own
				? { kind: "root", space: own.space }
				: { problem: refusalText(own.refusal, `${root}/`) };
		}
		const space = await scope.spaceByKey(root);
		return space ? { kind: "root", space } : { problem: OUTLINE_TOOL_TEXT.noSuchSpace(`${root}/`) };
	}
	const resolution = await scope.resolve(ref);
	if (resolution.status === "not_found") return { problem: OUTLINE_TOOL_TEXT.notFound(ref) };
	if (resolution.status === "ambiguous") {
		return {
			problem: OUTLINE_TOOL_TEXT.edit.ambiguous(
				ref,
				resolution.candidates.map((c) => `${c.address} ${clip(c.title, 40)}`),
			),
		};
	}
	if (resolution.block.deleted) {
		return { problem: OUTLINE_TOOL_TEXT.edit.deletedBlock(resolution.block.address) };
	}
	return { kind: "block", block: resolution.block };
}

function spaceIdOf(located: Located): string {
	return located.kind === "root" ? located.space.id : located.block.spaceId;
}

/** Labels a read may have put after bullets in the texts: candidates for `[sid]` stripping. */
function labelCandidates(texts: readonly string[]): string[] {
	const out = new Set<string>();
	const lineRe = new RegExp(
		`^[ \\t]*(?:(?:[-*+]|\\d{1,9}[.)])[ \\t]+)?${EDIT_LABEL_RE.source.slice(1)}`,
		"gm",
	);
	for (const text of texts) {
		for (const m of text.matchAll(lineRe)) {
			if (out.size >= OUTLINE_EDIT_LIMITS.maxLabels) return [...out];
			out.add(m[1] as string);
		}
	}
	return [...out];
}

/** Which candidate labels name existing blocks of readable spaces. */
async function knownLabels(
	scope: OutlineAgentScope,
	candidates: readonly string[],
	target: OutlineSpaceRow,
): Promise<string[]> {
	if (candidates.length === 0) return [];
	const known: string[] = [];
	const bare = candidates.filter((c) => !c.includes("/"));
	const keyed = new Map<string, string[]>();
	for (const c of candidates) {
		const slash = c.indexOf("/");
		if (slash < 0) continue;
		const list = keyed.get(c.slice(0, slash)) ?? [];
		list.push(c.slice(slash + 1));
		keyed.set(c.slice(0, slash), list);
	}
	if (bare.length > 0) {
		const spaces = new Map<string, OutlineSpaceRow>([[target.id, target]]);
		for (const own of await scope.ownSpaces()) spaces.set(own.space.id, own.space);
		const found = new Set<string>();
		for (const space of spaces.values()) {
			for (const meta of await scope.store.getBlockMetas(space.id, { sids: bare })) {
				found.add(meta.sid);
			}
		}
		known.push(...bare.filter((sid) => found.has(sid)));
	}
	for (const [key, sids] of keyed) {
		const space = await scope.spaceByKey(key);
		if (!space) continue;
		for (const meta of await scope.store.getBlockMetas(space.id, { sids })) {
			known.push(`${key}/${meta.sid}`);
		}
	}
	return known;
}

function walk(items: readonly EditTextItem[], visit: (item: EditTextItem) => void): void {
	for (const item of items) {
		visit(item);
		walk(item.children, visit);
	}
}

function walkPlanned(items: readonly PlannedItem[], visit: (item: PlannedItem) => void): void {
	for (const item of items) {
		visit(item);
		walkPlanned(item.children, visit);
	}
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeAssignee(value: string | null | undefined): string | null | undefined {
	if (value === undefined || value === null) return value;
	const t = value.trim().replace(/^@/, "");
	return t === "" ? null : t;
}

function noteLine(edit: EditState, note: OutlineNote): string {
	return OUTLINE_TOOL_TEXT.edit.parseNote(edit.index + 1, note.line, note.message);
}

export async function outlineEdit(
	scope: OutlineAgentScope,
	input: OutlineEditInput,
	provenance: OutlineEditProvenance,
): Promise<OutlineToolOutput> {
	const meta = { tool: "OutlineEdit" } as Record<string, unknown>;
	const globalNotes: string[] = [];
	const edits: EditState[] = input.edits.map((request, index) => ({
		index,
		request,
		kind: kindOf(request),
		problems: [],
		notes: [],
		opIndexes: [],
	}));
	const failed = (problems: string[]): OutlineToolOutput => ({
		output: [OUTLINE_TOOL_TEXT.edit.nothingWritten, ...problems.map((p) => `- ${p}`)].join("\n"),
		isError: true,
		metadata: { ...meta, commit: null },
	});

	// 1. Locate.
	for (const edit of edits) {
		const r = edit.request;
		const at = async (ref: string, allowRoot: boolean): Promise<Located | undefined> => {
			const located = await locate(scope, ref, allowRoot, edit.notes);
			if ("problem" in located) {
				edit.problems.push(located.problem);
				return undefined;
			}
			return located;
		};
		if ("add" in r) {
			edit.parent = await at(r.add, true);
			if (r.after !== undefined) {
				const after = await at(r.after, false);
				if (after?.kind === "block") edit.after = after.block;
			}
		} else if ("move" in r) {
			edit.located = await at(r.move, false);
			edit.parent = await at(r.to, true);
			if (r.after !== undefined) {
				const after = await at(r.after, false);
				if (after?.kind === "block") edit.after = after.block;
			}
		} else {
			edit.located = await at(targetOf(r), false);
		}
	}
	const located = edits.flatMap((edit) =>
		[edit.located, edit.parent].filter((l): l is Located => l !== undefined),
	);
	for (const edit of edits) if (edit.after) located.push({ kind: "block", block: edit.after });
	const problems = edits.flatMap((edit) => edit.problems.map((p) => `${label(edit)}: ${p}`));
	if (problems.length > 0) return failed(problems);

	const spaceIds = [...new Set(located.map(spaceIdOf))];
	if (spaceIds.length !== 1) {
		const keys: string[] = [];
		for (const l of located) {
			const key = l.kind === "root" ? l.space.key : l.block.spaceKey;
			if (!keys.includes(key)) keys.push(key);
		}
		return failed([OUTLINE_TOOL_TEXT.edit.oneSpace(keys)]);
	}
	const rootSpace = located.find((l) => l.kind === "root");
	const space =
		rootSpace?.kind === "root"
			? rootSpace.space
			: await scope.space((located[0] as { block: OutlineResolvedBlock }).block.spaceKey);
	if (!space) return failed([OUTLINE_TOOL_TEXT.noSuchSpace(spaceIds[0] as string)]);
	const spaceText = await scope.describe(space);
	meta.space = { key: space.key, kind: space.kind };
	const refusal = await scope.writeRefusal(space);
	if (refusal) return failed([refusalText(refusal, spaceText)]);

	// 2. Parse.
	const texts: Array<{ edit: EditState; text: string; mode: "outline" | "item" }> = [];
	for (const edit of edits) {
		const r = edit.request;
		if ("add" in r) texts.push({ edit, text: r.markdown, mode: "outline" });
		else if ("replace" in r) texts.push({ edit, text: r.text, mode: "item" });
	}
	let parsed: EditTextParsed[] = [];
	try {
		const labels = await knownLabels(scope, labelCandidates(texts.map((t) => t.text)), space);
		parsed = await processEditText(
			{ kind: "parse", inputs: texts.map((t) => ({ mode: t.mode, text: t.text })), labels },
			{ signal: provenance.signal },
		);
	} catch (error) {
		if (error instanceof OutlineEditTextError) return failed([error.message]);
		throw error;
	}

	// New items get their sids now, so the call's own links can point at them.
	const usedSids = new Set<string>();
	const drawSid = () => {
		let sid = newOutlineSid();
		while (usedSids.has(sid)) sid = newOutlineSid();
		usedSids.add(sid);
		return sid;
	};
	const plan = (item: EditTextItem): PlannedItem => ({
		item,
		sid: drawSid(),
		content: item.content,
		links: item.links,
		children: item.children.map(plan),
	});
	texts.forEach(({ edit }, k) => {
		const result = parsed[k];
		if (!result) return;
		for (const n of result.notes) edit.notes.push(noteLine(edit, n));
		if (edit.kind === "add" && result.items.length === 0) {
			edit.problems.push(OUTLINE_TOOL_TEXT.edit.nothingToAdd);
		}
		if (edit.kind === "replace" && result.items.length !== 1) {
			edit.problems.push(OUTLINE_TOOL_TEXT.edit.replaceOneBlock(result.items.length));
		}
		const labels: string[] = [];
		walk(result.items, (item) => {
			if (item.label !== undefined) labels.push(item.label);
		});
		if (edit.kind === "add" && labels.length > 0) {
			edit.notes.push(OUTLINE_TOOL_TEXT.edit.labelsIgnored(edit.index + 1, labels));
		}
		const own = edit.located?.kind === "block" ? edit.located.block : undefined;
		if (edit.kind === "replace" && labels.some((l) => own && l !== own.sid && l !== own.address)) {
			edit.notes.push(OUTLINE_TOOL_TEXT.edit.labelsIgnored(edit.index + 1, labels));
		}
		edit.items = result.items.map(plan);
	});
	const parseProblems = edits.flatMap((edit) => edit.problems.map((p) => `${label(edit)}: ${p}`));
	if (parseProblems.length > 0) return failed(parseProblems);

	// 3. Links.
	const allPlanned: PlannedItem[] = [];
	for (const edit of edits) if (edit.items) walkPlanned(edit.items, (p) => allPlanned.push(p));
	const byAlias = new Map<string, PlannedItem>();
	const byTitle = new Map<string, PlannedItem | null>();
	for (const p of allPlanned) {
		const alias = p.item.props.alias;
		if (alias && isAlias(alias)) byAlias.set(alias, p);
		const title = p.item.title;
		if (title) byTitle.set(title, byTitle.has(title) ? null : p);
	}
	const refsToResolve = new Set<string>();
	for (const p of allPlanned) {
		for (const ref of p.item.refs) refsToResolve.add(ref.ref);
		for (const dep of p.item.props.depends ?? []) refsToResolve.add(dep.target);
	}
	const targets: Record<string, EditTextTarget> = {};
	let resolved = 0;
	let skipped = 0;
	for (const ref of refsToResolve) {
		const own = byAlias.get(ref) ?? byTitle.get(ref) ?? undefined;
		if (own) {
			targets[ref] = {
				ref: `${space.key}/${own.sid}`,
				title: linkDisplayTitle(own.item.title),
			};
			continue;
		}
		if (resolved >= OUTLINE_EDIT_LIMITS.maxReferences) {
			skipped++;
			continue;
		}
		resolved++;
		const r = await scope.resolve(ref, space);
		if (r.status === "found") {
			targets[ref] = {
				ref: r.block.address,
				title: r.block.deleted ? null : linkDisplayTitle(r.block.title),
			};
			if (r.block.deleted)
				globalNotes.push(OUTLINE_TOOL_TEXT.edit.linkToDeleted(ref, r.block.address));
		} else if (r.status === "ambiguous") {
			globalNotes.push(
				OUTLINE_TOOL_TEXT.edit.linkAmbiguous(
					ref,
					r.candidates.map((c) => c.address),
				),
			);
		} else {
			globalNotes.push(OUTLINE_TOOL_TEXT.edit.linkNotFound(ref));
		}
	}
	if (skipped > 0) globalNotes.push(OUTLINE_TOOL_TEXT.edit.tooManyLinks(skipped));

	const needsRewrite = (refs: readonly BodyRef[]) =>
		refs.some((ref) => {
			const t = Object.hasOwn(targets, ref.ref) ? targets[ref.ref] : undefined;
			return (
				t !== undefined && (t.ref !== ref.ref || (ref.label !== null && ref.label === t.title))
			);
		});
	const rewriteContents = [
		...new Set(allPlanned.filter((p) => needsRewrite(p.item.refs)).map((p) => p.content)),
	];
	if (rewriteContents.length > 0) {
		try {
			const rewritten = await processEditText(
				{ kind: "rewrite", contents: rewriteContents, targets },
				{ signal: provenance.signal },
			);
			const byContent = new Map(rewriteContents.map((c, i) => [c, rewritten[i]]));
			for (const p of allPlanned) {
				const r = byContent.get(p.content);
				if (r) {
					p.content = r.content;
					p.links = r.links;
				}
			}
		} catch (error) {
			if (error instanceof OutlineEditTextError) return failed([error.message]);
			throw error;
		}
	}
	const dependsOf = (item: EditTextItem) =>
		item.props.depends?.map((dep) => {
			const t = Object.hasOwn(targets, dep.target) ? targets[dep.target] : undefined;
			if (!t) return dep;
			return {
				target: t.ref,
				label: dep.label !== null && dep.label === t.title ? null : dep.label,
			};
		});

	// Aliases: `Q?` takes the next free number of its prefix.
	const autoPrefixes = new Map<string, number>();
	const wantAuto = (value: string | undefined | null): string | null => {
		if (!value) return null;
		const parsedAlias = parseAliasValue(value);
		return parsedAlias?.kind === "auto" ? parsedAlias.prefix : null;
	};
	const literal: string[] = [];
	for (const p of allPlanned) {
		const prefix = wantAuto(p.item.props.alias);
		if (prefix !== null) autoPrefixes.set(prefix, 0);
		else if (p.item.props.alias) literal.push(p.item.props.alias);
	}
	for (const edit of edits) {
		const r = edit.request;
		if ("set" in r && typeof r.alias === "string") {
			const prefix = wantAuto(r.alias);
			if (prefix !== null) autoPrefixes.set(prefix, 0);
			else if (r.alias.trim()) literal.push(r.alias.trim());
		}
	}
	for (const prefix of autoPrefixes.keys()) {
		const existing = await scope.store.listAliasRange(
			space.id,
			{ from: `${prefix}0`, to: `${prefix}:` },
			OUTLINE_EDIT_LIMITS.maxAliasesScanned + 1,
		);
		if (existing.length > OUTLINE_EDIT_LIMITS.maxAliasesScanned) {
			return failed([OUTLINE_TOOL_TEXT.edit.tooManyAliases(prefix)]);
		}
		const numbered = new RegExp(`^${escapeRegExp(prefix)}(\\d+)$`);
		let max = 0;
		for (const alias of [...existing, ...literal]) {
			const m = numbered.exec(alias);
			if (m) max = Math.max(max, Number(m[1]));
		}
		autoPrefixes.set(prefix, max);
	}
	const nextAlias = (value: string): string => {
		const prefix = wantAuto(value);
		if (prefix === null) return value.trim();
		const n = (autoPrefixes.get(prefix) ?? 0) + 1;
		autoPrefixes.set(prefix, n);
		return `${prefix}${n}`;
	};
	for (const p of allPlanned) {
		if (p.item.props.alias) p.alias = nextAlias(p.item.props.alias);
	}
	for (const edit of edits) {
		const r = edit.request;
		if ("set" in r && r.alias !== undefined) {
			edit.alias = r.alias === null || r.alias.trim() === "" ? null : nextAlias(r.alias);
		}
	}

	// Hints, read before the barrier (it holds the space's live sessions while it runs): a new
	// page whose title another page of the space already has.
	const hints: string[] = [];
	let hinted = 0;
	for (const edit of edits) {
		if (edit.kind !== "add" || edit.parent?.kind !== "root") continue;
		for (const p of edit.items ?? []) {
			if (hinted >= OUTLINE_EDIT_LIMITS.maxPageHints || !p.item.title) continue;
			hinted++;
			const r = await scope.resolve(p.item.title, space);
			const same = r.status === "found" ? [r.block] : r.status === "ambiguous" ? r.candidates : [];
			const pages = same.filter((b) => b.isPage && b.spaceId === space.id);
			if (pages.length > 0) {
				hints.push(
					OUTLINE_TOOL_TEXT.edit.samePageTitle(
						clip(p.item.title, 60),
						pages.map((b) => b.address),
					),
				);
			}
		}
	}

	// The fields a replace sets besides its text (the ones its text leaves out keep their value).
	const replaceFields = (p: PlannedItem): Omit<AgentReplace, "blockId" | "seen" | "content"> => {
		const props = p.item.props;
		const depends = dependsOf(p.item);
		const task: OutlineTaskPatch | undefined =
			p.item.task || depends?.length || props.due
				? {
						...(p.item.task ? { status: p.item.task.status } : {}),
						...(p.item.task?.assignee ? { assignee: p.item.task.assignee } : {}),
						...(depends?.length ? { depends } : {}),
						...(props.due ? { due: props.due } : {}),
					}
				: undefined;
		return {
			...(p.alias !== undefined ? { alias: p.alias } : {}),
			...(props.tags?.length ? { tags: props.tags.map((t) => t.target) } : {}),
			...(task ? { task } : {}),
		};
	};

	// 4–5 run behind the live session barrier: unflushed live edits of the space are committed
	// first, so a block someone is typing into counts as changed since the agent read it (and
	// what they typed is merged with), and nothing lands in the space between these checks and
	// the write. Only the checks, the merges, the write and reading back what was merged run
	// there; reporting reads afterwards.
	let outcome:
		| { conflicts: ChangedSinceRead[] }
		| { writeConflict: OutlineConflictError }
		| { written: OutlineWriteResult; merged: MergedBlock[] }
		| { output: OutlineToolOutput };
	try {
		outcome = await withOutlineLiveBarrier(space.id, async () => {
			// 4. What the agent read.
			const existingIds = [
				...new Set(
					edits.flatMap((edit) => (edit.located?.kind === "block" ? [edit.located.block.id] : [])),
				),
			];
			const current = new Map(
				(await scope.store.getBlockMetas(space.id, { ids: existingIds })).map((m) => [m.id, m]),
			);
			const seenOf = (blockId: string) => seenOutlineVersion(scope.narratorId, blockId);
			const editsOf = new Map<string, EditState[]>();
			for (const edit of edits) {
				if (edit.located?.kind !== "block") continue;
				const id = edit.located.block.id;
				editsOf.set(id, [...(editsOf.get(id) ?? []), edit]);
			}
			// What a delete takes with it: its live descendants, which the agent may not have read.
			const deleted = [...editsOf.entries()]
				.filter(([, list]) => list.some((e) => e.kind === "delete"))
				.map(([id]) => id);
			const under = await liveDescendants(
				scope.store,
				space.id,
				deleted,
				OUTLINE_EDIT_LIMITS.maxDeletedChecked,
			);
			// Who wrote what the agent is changing or deleting, since it read it: any version after
			// its read by someone else (its own versions left out: a move of its own writes a page
			// change for every block under the moved one, which says nothing about what others
			// wrote). A block it never read (or not since a restart): the latest version that
			// changed more than where the block sits (anyone's moves are left out, and the agent's
			// own moves, checkboxes and properties), when someone else wrote it, or the agent merged
			// it with what someone else wrote. Past the scan bound of either read: assume someone
			// else did.
			const replacedOrDeleted = (blockId: string) =>
				(editsOf.get(blockId) ?? []).some((e) => e.kind === "replace" || e.kind === "delete");
			const underIds = new Set(under.blocks.map((b) => b.meta.id));
			const candidates = new Map<string, OutlineBlockMeta>();
			for (const m of current.values()) candidates.set(m.id, m);
			for (const b of under.blocks)
				if (!candidates.has(b.meta.id)) candidates.set(b.meta.id, b.meta);
			const checkedSinceRead: Array<{ blockId: string; afterSeq: number }> = [];
			const checkedUnread: Array<{ blockId: string; afterSeq: number }> = [];
			for (const m of candidates.values()) {
				const seen = seenOf(m.id);
				if (seen !== undefined) {
					if (m.versionSeq > seen) checkedSinceRead.push({ blockId: m.id, afterSeq: seen });
				} else if (underIds.has(m.id) || replacedOrDeleted(m.id)) {
					checkedUnread.push({ blockId: m.id, afterSeq: 0 });
				}
			}
			const self = { actorKind: "agent" as const, actorId: scope.narratorId };
			const byOthersSince = new Map(
				checkedSinceRead.length === 0
					? []
					: (
							await scope.store.findLastWrites(checkedSinceRead, { ...self, flags: ALL_CHANGES })
						).map((r) => [r.blockId, r.fromSeq]),
			);
			const lastWrite = new Map(
				checkedUnread.length === 0
					? []
					: (
							await scope.store.findLastWrites(checkedUnread, {
								...self,
								flags: OWN_NOT_TEXT,
								anyoneFlags: MOVES,
							})
						).map((r) => [r.blockId, r]),
			);
			const seqs = [
				...byOthersSince.values(),
				...[...lastWrite.values()].map((r) => r.fromSeq),
			].filter((seq): seq is number => seq !== null);
			const commits = new Map(
				(await scope.store.getCommitsBySeqs(space.id, [...new Set(seqs)])).map((c) => [c.seq, c]),
			);
			const isOwn = (seq: number) => {
				const commit = commits.get(seq);
				return commit?.actorKind === "agent" && commit.actorId === scope.narratorId;
			};
			/**
			 * The version by someone else the agent has not seen, if there is one: its seq, or the
			 * block's current one when the scan bound hid it.
			 */
			const unseenWrite = (m: OutlineBlockMeta): number | undefined => {
				if (byOthersSince.has(m.id)) return byOthersSince.get(m.id) ?? m.versionSeq;
				const last = lastWrite.get(m.id);
				if (!last) return undefined;
				if (last.fromSeq === null) return m.versionSeq;
				const ownText =
					isOwn(last.fromSeq) && ((last.changeFlags ?? 0) & OUTLINE_CHANGE.MERGE) === 0;
				return ownText ? undefined : last.fromSeq;
			};
			const why = (
				m: OutlineBlockMeta,
				seq: number,
				extra: Partial<ChangedSinceRead> = {},
			): ChangedSinceRead => ({
				blockId: m.id,
				sid: m.sid,
				seen: seenOf(m.id) ?? null,
				now: seq,
				// Its own version (a merge it wrote, or the scan bound hid the other's): "someone".
				by: isOwn(seq) ? undefined : commits.get(seq),
				...extra,
			});
			const changed = [...current.values()].flatMap((m) =>
				byOthersSince.has(m.id) ? [why(m, unseenWrite(m) as number)] : [],
			);
			// Only a block's one replace is merged; a move, delete or set needs the block as read.
			const replaceOf = (blockId: string) => {
				const list = editsOf.get(blockId) ?? [];
				return list.length === 1 && list[0]?.kind === "replace" ? list[0] : undefined;
			};
			// Never read (or not since the server started): a replace or delete of what someone
			// else wrote needs a read first (design §6.5, the read cache gone: any change refuses).
			const unread = [...current.values()].flatMap((m) => {
				const seq =
					seenOf(m.id) === undefined && replacedOrDeleted(m.id) ? unseenWrite(m) : undefined;
				return seq === undefined ? [] : [why(m, seq, { shown: true })];
			});
			const sidOf = (id: string) => current.get(id)?.sid ?? id;
			const underChanged = under.blocks.flatMap((b) => {
				const seq = unseenWrite(b.meta);
				return seq === undefined ? [] : [why(b.meta, seq, { under: sidOf(b.rootId), shown: true })];
			});
			const tooLarge = under.overflow.flatMap(({ rootId, limit }) => {
				const m = current.get(rootId);
				return m ? [why(m, m.versionSeq, { tooLarge: limit })] : [];
			});
			// Each block once (one deleted under another is both a target and under it).
			const refusedNow = new Map<string, ChangedSinceRead>();
			for (const c of [
				...changed
					.filter((c) => !replaceOf(c.blockId))
					.map((c) => ({ ...c, detail: [OUTLINE_TOOL_TEXT.edit.notMerged] })),
				...unread,
				...tooLarge,
				...underChanged,
			]) {
				if (!refusedNow.has(c.blockId)) refusedNow.set(c.blockId, c);
			}
			if (refusedNow.size > 0) return { conflicts: [...refusedNow.values()] };

			/** Blocks to merge, with who changed them since the agent read them. */
			const merges = new Map<
				string,
				{ merge: Extract<AgentMerge, { ok: true }>; why: ChangedSinceRead }
			>();
			if (changed.length > 0) {
				const replaces: AgentReplace[] = changed.map((c) => {
					const p = (replaceOf(c.blockId)?.items as PlannedItem[])[0] as PlannedItem;
					return {
						blockId: c.blockId,
						seen: c.seen as number,
						content: p.content,
						...replaceFields(p),
					};
				});
				// What the rest of the call writes, so the merged texts are checked against what one
				// transaction takes before any of them is merged (the merges hold the space's lane).
				const mergedIds = new Set(changed.map((c) => c.blockId));
				let otherBytes = 0;
				for (const edit of edits) {
					const own = edit.located?.kind === "block" ? edit.located.block.id : undefined;
					(edit.items ?? []).forEach((p, k) => {
						walkPlanned([p], (q) => {
							if (!(k === 0 && q === p && own && mergedIds.has(own)))
								otherBytes += Buffer.byteLength(q.content, "utf8");
						});
					});
				}
				let results: AgentMerge[];
				try {
					results = await mergeAgentReplaces(scope.store, replaces, {
						signal: provenance.signal,
						maxTheirsBytes: OUTLINE_LIMITS.maxTransactionBodyBytes - otherBytes,
					});
				} catch (error) {
					if (error instanceof OutlineEditTextError || error instanceof AgentMergeLimitError)
						return { output: failed([error.message]) };
					throw error;
				}
				const refused: ChangedSinceRead[] = [];
				results.forEach((r, i) => {
					const c = changed[i] as ChangedSinceRead;
					if (r.ok) merges.set(r.blockId, { merge: r, why: c });
					else refused.push({ ...c, detail: refusalDetail(r) });
				});
				if (refused.length > 0) return { conflicts: refused };
			}
			const base = (blockId: string) => current.get(blockId)?.versionSeq;

			// 5. Operations.
			const ops: OutlineOp[] = [];
			const canonical: Array<OutlineCanonicalContent | undefined> = [];
			const opEdit: number[] = [];
			const push = (edit: EditState, op: OutlineOp, content?: OutlineCanonicalContent) => {
				edit.opIndexes.push(ops.length);
				opEdit.push(edit.index);
				canonical.push(content);
				ops.push(op);
			};
			const taskOf = (edit: EditState, item: EditTextItem): OutlineTaskInput | null => {
				const depends = dependsOf(item);
				if (!item.task) {
					if (depends?.length || item.props.due)
						edit.notes.push(OUTLINE_TOOL_TEXT.edit.taskPropsIgnored(edit.index + 1));
					return null;
				}
				return {
					status: item.task.status,
					assignee: item.task.assignee,
					...(depends?.length ? { depends } : {}),
					...(item.props.due ? { due: item.props.due } : {}),
				};
			};
			const insertTree = (
				edit: EditState,
				p: PlannedItem,
				parent: OutlineBlockRef | null,
				position: OutlinePosition | undefined,
			): string => {
				const tempId = `n${ops.length}`;
				push(
					edit,
					{
						op: "insert",
						tempId,
						sid: p.sid,
						parent,
						...(position ? { position } : {}),
						content: p.content,
						task: taskOf(edit, p.item),
						...(p.alias ? { alias: p.alias } : {}),
						...(p.item.props.tags?.length ? { tags: p.item.props.tags.map((t) => t.target) } : {}),
					},
					{ content: p.content, links: p.links },
				);
				for (const child of p.children) insertTree(edit, child, { tempId }, undefined);
				return tempId;
			};
			for (const edit of edits) {
				const r = edit.request;
				if ("add" in r) {
					const parent = edit.parent?.kind === "block" ? { id: edit.parent.block.id } : null;
					let previous: string | null = null;
					for (const p of edit.items ?? []) {
						const position: OutlinePosition | undefined = previous
							? { after: { tempId: previous } }
							: edit.after
								? { after: { id: edit.after.id } }
								: undefined;
						previous = insertTree(edit, p, parent, position);
					}
				} else if ("replace" in r) {
					const block = (edit.located as { block: OutlineResolvedBlock }).block;
					const p = (edit.items as PlannedItem[])[0] as PlannedItem;
					// A merged block takes the merged text and only the fields the merge kept.
					const merge = merges.get(block.id)?.merge;
					const fields = merge ?? replaceFields(p);
					const content = merge ? merge.content : p.content;
					// The checkbox as it already is is not a change: rewriting the text of a task in
					// progress does not claim it (only setting it to in progress does). A merge keeps
					// the checkbox only when the agent changed it from what it read, so it stays.
					let task = fields.task;
					if (
						!merge &&
						task?.status !== undefined &&
						task.status === current.get(block.id)?.taskJson?.status
					) {
						const { status: _unchanged, ...rest } = task;
						task = Object.keys(rest).length > 0 ? rest : undefined;
					}
					push(
						edit,
						{
							op: "update",
							block: { id: block.id },
							content,
							baseVersionSeq: base(block.id),
							...(fields.alias !== undefined ? { alias: fields.alias } : {}),
							...(fields.tags !== undefined ? { tags: fields.tags } : {}),
							...(merge ? { merged: true } : {}),
						},
						{ content, links: merge ? merge.links : p.links },
					);
					if (task) {
						push(edit, {
							op: "setTask",
							block: { id: block.id },
							task,
							baseVersionSeq: base(block.id),
						});
					}
					let previous: string | null = null;
					for (const child of p.children) {
						previous = insertTree(
							edit,
							child,
							{ id: block.id },
							previous ? { after: { tempId: previous } } : { first: true },
						);
					}
				} else if ("move" in r) {
					const block = (edit.located as { block: OutlineResolvedBlock }).block;
					push(edit, {
						op: "move",
						block: { id: block.id },
						parent: edit.parent?.kind === "block" ? { id: edit.parent.block.id } : null,
						...(edit.after ? { position: { after: { id: edit.after.id } } } : {}),
						baseVersionSeq: base(block.id),
					});
				} else if ("delete" in r) {
					const block = (edit.located as { block: OutlineResolvedBlock }).block;
					push(edit, { op: "delete", block: { id: block.id }, baseVersionSeq: base(block.id) });
				} else {
					const block = (edit.located as { block: OutlineResolvedBlock }).block;
					const assignee = normalizeAssignee(r.assignee);
					if (r.checkbox === "none") {
						push(edit, {
							op: "setTask",
							block: { id: block.id },
							task: null,
							baseVersionSeq: base(block.id),
						});
					} else if (r.checkbox !== undefined || assignee !== undefined) {
						push(edit, {
							op: "setTask",
							block: { id: block.id },
							task: {
								...(r.checkbox !== undefined ? { status: STATUS_OF[r.checkbox] } : {}),
								...(assignee !== undefined ? { assignee } : {}),
							},
							baseVersionSeq: base(block.id),
						});
					}
					if (edit.alias !== undefined) {
						push(edit, {
							op: "update",
							block: { id: block.id },
							alias: edit.alias,
							baseVersionSeq: base(block.id),
						});
					}
				}
			}

			// Write.
			let result: OutlineWriteResult;
			try {
				result = await writeOutline(
					{
						spaceId: space.id,
						ops,
						actor: { kind: "agent", id: scope.narratorId },
						responsibleUserId: scope.ctx.userId,
						narratorId: scope.narratorId,
						messageId: provenance.messageId,
						toolCallId: provenance.toolCallId,
						...(input.message?.trim() ? { summary: input.message.trim() } : {}),
					},
					{ canonical },
				);
			} catch (error) {
				if (error instanceof OutlineConflictError) return { writeConflict: error };
				if (error instanceof OutlineTaskClaimedError) {
					const at = error.opIndex === null ? undefined : edits[opEdit[error.opIndex] as number];
					const message = OUTLINE_TOOL_TEXT.edit.taskClaimed(
						error.address,
						await claimHolderName(error),
					);
					return { output: failed([at ? `${label(at)}: ${message}` : message]) };
				}
				if (error instanceof OutlineWriteError) {
					const at = error.opIndex === null ? undefined : edits[opEdit[error.opIndex] as number];
					const message = error.message.replace(/^operation \d+: /, "");
					return { output: failed([at ? `${label(at)}: ${message}` : message]) };
				}
				if (error instanceof OutlineBusyError)
					return { output: failed([OUTLINE_TOOL_TEXT.edit.busy]) };
				if (error instanceof NotFoundError) return { output: failed([error.message]) };
				throw error;
			}

			// The read ledger follows the agent's own writes: what it added and the texts it wrote.
			// A merged block counts as read only once the result shows it (below), so until then
			// it keeps the version the agent read and a later edit merges again. A set or a move
			// shows nothing of the block: it only moves a version the agent did read along.
			const commit = result.commit;
			if (commit) {
				const written: Array<readonly [string, number]> = [];
				const deleted: string[] = [];
				result.results.forEach((r, i) => {
					if (!r) return;
					const op = ops[i];
					const kind = edits[opEdit[i] as number]?.kind;
					if (op?.op === "delete") deleted.push(r.blockId);
					else if (merges.has(r.blockId) && op?.op !== "insert") {
						// Shown (or not) below.
					} else if (kind === "set" || kind === "move") {
						if (seenOf(r.blockId) !== undefined) written.push([r.blockId, commit.seq]);
					} else written.push([r.blockId, commit.seq]);
					for (const s of r.split) written.push([s.blockId, commit.seq]);
				});
				recordOutlineReads(scope.narratorId, written);
				forgetOutlineReads(scope.narratorId, deleted);
			}

			// Merged blocks as they are now (still behind the barrier: nobody has typed since), in
			// the order of the call's edits.
			const merged: MergedBlock[] = [];
			if (merges.size > 0) {
				const ids = [...merges.keys()];
				const rows = new Map((await scope.store.getBlocks(ids)).map((row) => [row.id, row]));
				const tags = await tagsNow(scope, ids);
				for (const edit of edits) {
					if (edit.kind !== "replace" || edit.located?.kind !== "block") continue;
					const row = rows.get(edit.located.block.id);
					const why = row ? merges.get(row.id)?.why : undefined;
					if (!row || !why || row.deleted) continue;
					merged.push({ why, row, tags: tags.get(row.id) ?? [] });
				}
			}
			return { written: result, merged };
		});
	} catch (error) {
		// The space's live text could not be committed first: try again shortly.
		if (error instanceof OutlineBusyError) return failed([OUTLINE_TOOL_TEXT.edit.busy]);
		throw error;
	}
	if ("output" in outcome) return outcome.output;
	if ("conflicts" in outcome) return await conflictOutput(scope, space, outcome.conflicts, meta);
	if ("written" in outcome) {
		return successOutput(
			space,
			spaceText,
			edits,
			outcome.written,
			await mergedSection(scope, outcome.merged, scope.narratorId),
			{ globalNotes, hints, meta },
		);
	}
	const error = outcome.writeConflict;
	const metas = new Map(
		(
			await scope.store.getBlockMetas(space.id, {
				ids: error.conflicts.map((c) => c.blockId),
			})
		).map((m) => [m.id, m]),
	);
	const commits = new Map(
		(
			await scope.store.getCommitsBySeqs(
				space.id,
				error.conflicts.map((c) => c.actualVersionSeq),
			)
		).map((c) => [c.seq, c]),
	);
	return await conflictOutput(
		scope,
		space,
		error.conflicts.map((c) => ({
			blockId: c.blockId,
			sid: metas.get(c.blockId)?.sid ?? c.sid,
			seen: seenOutlineVersion(scope.narratorId, c.blockId) ?? c.expectedVersionSeq,
			now: c.actualVersionSeq,
			by: commits.get(c.actualVersionSeq),
		})),
		meta,
	);
}

/** A block someone else changed after the agent read it: who, and what kept it from merging. */
interface ChangedSinceRead {
	blockId: string;
	sid: string;
	/** The version the agent read; null when it has not read the block (or not since a restart). */
	seen: number | null;
	/** The block's version now. */
	now: number;
	by?: Pick<OutlineCommitRow, "actorKind" | "actorId">;
	/** Why it could not be merged. */
	detail?: string[];
	/** The sid of the block this call deletes that it is under. */
	under?: string;
	/** A block this call deletes with more blocks under it than were left to check: that many. */
	tooLarge?: number;
	/**
	 * Its current text is shown in full (within a budget) and then counts as read, so the edit
	 * goes through once the agent has seen it: a block never read, or under a deleted one.
	 */
	shown?: boolean;
}

/** Who holds a claim, as a refusal names them: the session's title or the person's name. */
async function claimHolderName(error: OutlineTaskClaimedError): Promise<string> {
	const holder = error.holder;
	const names = await readDisplayNames(
		holder.kind === "agent" ? { narratorIds: [holder.narratorId] } : { userIds: [holder.userId] },
	).catch(() => null);
	return holder.kind === "agent"
		? OUTLINE_TOOL_TEXT.edit.claimHolderSession(
				names?.narrators.get(holder.narratorId) ?? null,
				holder.narratorId,
			)
		: OUTLINE_TOOL_TEXT.edit.claimHolderPerson(
				names?.users.get(holder.userId) ?? null,
				holder.userId,
			);
}

/**
 * Live descendants of `rootIds`, breadth first, each with the root it is under, at most `max`
 * for all roots together: one indexed, bounded query per level. A root whose subtree does not
 * fit in what is left is `overflow`, with the number of blocks that was left for it (its blocks
 * are not counted; the roots after it still are).
 */
async function liveDescendants(
	store: OutlineStore,
	spaceId: string,
	rootIds: readonly string[],
	max: number,
): Promise<{
	blocks: Array<{ meta: OutlineBlockMeta; rootId: string }>;
	overflow: Array<{ rootId: string; limit: number }>;
}> {
	const blocks: Array<{ meta: OutlineBlockMeta; rootId: string }> = [];
	const overflow: Array<{ rootId: string; limit: number }> = [];
	for (const rootId of rootIds) {
		const start = blocks.length;
		const limit = max - start;
		let frontier = [rootId];
		while (frontier.length > 0) {
			const remaining = max - blocks.length;
			const rows = await store.listChildMetas(spaceId, frontier, remaining + 1);
			if (rows.length > remaining) {
				blocks.length = start;
				overflow.push({ rootId, limit });
				break;
			}
			for (const meta of rows) blocks.push({ meta, rootId });
			frontier = rows.map((m) => m.id);
		}
	}
	return { blocks, overflow };
}

/** A block row as a read's tree node (no parent or children), for showing it as a read does. */
function rowNode(row: OutlineBlockRow, tags: string[]): OutlineNode {
	return {
		id: row.id,
		sid: row.sid,
		parentId: row.parentId,
		orderKey: row.orderKey,
		alias: row.alias,
		task: row.taskJson,
		versionSeq: row.versionSeq,
		parent: null,
		children: [],
		content: row.content,
		tags,
	};
}

/** Tag targets of blocks now, sorted, by block. */
async function tagsNow(
	scope: OutlineAgentScope,
	ids: readonly string[],
): Promise<Map<string, string[]>> {
	const out = new Map<string, string[]>(ids.map((id) => [id, []]));
	if (ids.length === 0) return out;
	const links = await scope.store.listLinksAt(
		ids,
		null,
		["tag"],
		ids.length * OUTLINE_LIMITS.maxTagsPerBlock,
	);
	for (const link of links) out.get(link.fromBlockId)?.push(link.targetRef);
	for (const list of out.values()) list.sort();
	return out;
}

/** What a result says about the blocks a call merged. */
interface MergedSection {
	lines: string[];
	sids: ReadonlySet<string>;
	/** Those whose merged text it shows (the rest the agent has to read). */
	shown: ReadonlySet<string>;
}

/** A block merged by this call, as it is after the write. */
interface MergedBlock {
	why: ChangedSinceRead;
	row: OutlineBlockRow;
	/** Its tags, sorted. */
	tags: string[];
}

function whoChanged(by: ChangedSinceRead["by"]): string {
	return !by
		? OUTLINE_TOOL_TEXT.edit.someone
		: by.actorKind === "human"
			? OUTLINE_TOOL_TEXT.edit.aPerson
			: by.actorKind === "agent"
				? OUTLINE_TOOL_TEXT.edit.anotherAgent
				: OUTLINE_TOOL_TEXT.edit.theSystem;
}

/** Why a merge was refused, as lines under the block's conflict. */
function refusalDetail(refused: Extract<AgentMerge, { ok: false }>): string[] {
	switch (refused.reason) {
		case "overlap":
			return [OUTLINE_TOOL_TEXT.edit.overlaps(refused.overlaps ?? [])];
		case "fields":
			return [OUTLINE_TOOL_TEXT.edit.bothChanged(refused.fields ?? [])];
		case "unstable":
			return [OUTLINE_TOOL_TEXT.edit.mergeUnstable];
		case "no-base":
			return [OUTLINE_TOOL_TEXT.edit.noBase];
		case "deleted":
			return [];
	}
}

async function conflictOutput(
	scope: OutlineAgentScope,
	space: OutlineSpaceRow,
	conflicts: ChangedSinceRead[],
	meta: Record<string, unknown>,
): Promise<OutlineToolOutput> {
	const text = OUTLINE_TOOL_TEXT.edit;
	const listed = conflicts.slice(0, OUTLINE_EDIT_LIMITS.maxConflictsListed);
	const blocks = new Map(
		(await scope.store.getBlocks(listed.map((c) => c.blockId))).map((b) => [b.id, b]),
	);
	// Blocks never read, or under a deleted block: shown in full as a read shows them, within a
	// budget; those shown count as read from now on.
	const full = listed.flatMap((c) => {
		const row = blocks.get(c.blockId);
		return c.shown && row && !row.deleted ? [row] : [];
	});
	const tags = await tagsNow(
		scope,
		full.map((row) => row.id),
	);
	const rendered = await blockLinesForAgent(
		scope,
		full.map((row) => rowNode(row, tags.get(row.id) ?? [])),
	);
	const shown: OutlineBlockRow[] = [];
	let bytes = 0;
	for (const row of full) {
		const size = Buffer.byteLength(rendered.get(row.id) ?? "", "utf8");
		if (bytes > 0 && bytes + size > OUTLINE_EDIT_LIMITS.maxConflictShownBytes) continue;
		bytes += size;
		shown.push(row);
	}
	const shownIds = new Set(shown.map((row) => row.id));

	const lines: string[] = [text.conflictHeader];
	let needsRead = conflicts.length > listed.length;
	for (const c of listed) {
		const who = whoChanged(c.by);
		if (c.tooLarge !== undefined) {
			lines.push(
				`- ${text.tooLargeToDelete(c.sid, c.tooLarge, OUTLINE_EDIT_LIMITS.maxDeletedChecked)}`,
			);
			continue;
		}
		lines.push(
			`- ${c.seen === null ? text.notRead(c.sid, who, c.now) : text.conflict(c.sid, who, c.now, c.seen)}`,
		);
		if (c.under) lines.push(`  ${text.underDeleted(c.under)}`);
		for (const detail of c.detail ?? []) lines.push(`  ${detail}`);
		const block = blocks.get(c.blockId);
		if (shownIds.has(c.blockId)) lines.push(`  ${text.shownBelow}`);
		else if (block && !block.deleted) {
			needsRead = true;
			const now = clip(block.content.split("\n").join(" "), OUTLINE_EDIT_LIMITS.maxConflictChars);
			lines.push(`  ${text.nowReads(now)}`);
		} else if (block?.deleted) lines.push(`  ${text.nowDeleted}`);
	}
	if (conflicts.length > listed.length)
		lines.push(text.moreConflicts(conflicts.length - listed.length));
	if (conflicts.some((c) => c.seen === null && c.tooLarge === undefined))
		lines.push(text.readFirst);
	if (shown.length > 0) {
		lines.push(text.shownHeader);
		for (const row of shown) lines.push(rendered.get(row.id) ?? "");
		recordOutlineReads(
			scope.narratorId,
			shown.map((row) => [row.id, row.versionSeq] as const),
		);
	}
	if (needsRead || shown.length === 0) lines.push(text.conflictRecover(space.key));
	return {
		output: lines.join("\n"),
		isError: true,
		metadata: { ...meta, commit: null, conflicts: conflicts.map((c) => `${space.key}/${c.sid}`) },
	};
}

function itemLines(items: readonly PlannedItem[], depth: number, out: string[]): void {
	for (const p of items) {
		const box = p.item.task ? `[${TASK_BOX[p.item.task.status]}] ` : "";
		const who = p.item.task?.assignee ? ` @${p.item.task.assignee}` : "";
		const alias = p.alias ? OUTLINE_TOOL_TEXT.aliasMark(p.alias) : "";
		const title = clip(p.item.title) || OUTLINE_TOOL_TEXT.untitled;
		out.push(`${"  ".repeat(depth)}- [${p.sid}] ${box}${title}${who}${alias}`);
		itemLines(p.children, depth + 1, out);
	}
}

/**
 * The merged blocks as a read shows them (the short id after the bullet, links with their
 * targets' titles), within {@link OUTLINE_EDIT_LIMITS.maxMergedBytes}; the rest are only named.
 */
async function mergedSection(
	scope: OutlineAgentScope,
	merged: readonly MergedBlock[],
	narratorId: string,
): Promise<MergedSection> {
	if (merged.length === 0) return { lines: [], sids: new Set(), shown: new Set() };
	const rendered = await blockLinesForAgent(
		scope,
		merged.map((m) => rowNode(m.row, m.tags)),
	);
	const lines: string[] = [OUTLINE_TOOL_TEXT.edit.mergedHeader];
	const unshown: string[] = [];
	const shown: MergedBlock[] = [];
	let bytes = 0;
	for (const m of merged) {
		const text = rendered.get(m.row.id) ?? "";
		const size = Buffer.byteLength(text, "utf8");
		if (bytes > 0 && bytes + size > OUTLINE_EDIT_LIMITS.maxMergedBytes) {
			unshown.push(`[${m.row.sid}]`);
			continue;
		}
		bytes += size;
		shown.push(m);
		const { why } = m;
		lines.push(
			`‹${OUTLINE_TOOL_TEXT.edit.mergedBlock(why.sid, whoChanged(why.by), why.now, why.seen ?? 0)}›`,
		);
		lines.push(text);
	}
	if (unshown.length > 0) lines.push(`‹${OUTLINE_TOOL_TEXT.edit.mergedNotShown(unshown)}›`);
	// Shown whole, as a read shows them: these versions count as read. The others keep the
	// version the agent read, so its next edit of them is merged again.
	recordOutlineReads(
		narratorId,
		shown.map((m) => [m.row.id, m.row.versionSeq] as const),
	);
	return {
		lines,
		sids: new Set(merged.map((m) => m.row.sid)),
		shown: new Set(shown.map((m) => m.row.sid)),
	};
}

function successOutput(
	space: OutlineSpaceRow,
	spaceText: string,
	edits: readonly EditState[],
	result: OutlineWriteResult,
	merged: MergedSection,
	extra: { globalNotes: string[]; hints: string[]; meta: Record<string, unknown> },
): OutlineToolOutput {
	const mergedMeta =
		merged.sids.size > 0 ? { merged: [...merged.sids].map((sid) => `${space.key}/${sid}`) } : {};
	if (!result.commit) {
		return {
			output: [OUTLINE_TOOL_TEXT.edit.noChange, ...merged.lines].join("\n"),
			metadata: { ...extra.meta, commit: null, ...mergedMeta },
		};
	}
	const lines = [OUTLINE_TOOL_TEXT.edit.committed(result.commit.seq, spaceText, edits.length)];
	const summary: Array<Record<string, unknown>> = [];
	for (const edit of edits) {
		const n = edit.index + 1;
		const r = edit.request;
		const firstResult = result.results[edit.opIndexes[0] as number];
		const where = (l: Located | undefined) =>
			l?.kind === "block" ? `[${l.block.sid}] ${clip(l.block.title, 60)}` : null;
		if ("add" in r) {
			lines.push(`${n}. ${OUTLINE_TOOL_TEXT.edit.added(where(edit.parent))}`);
			itemLines(edit.items ?? [], 1, lines);
			const created: string[] = [];
			walkPlanned(edit.items ?? [], (p) => created.push(`${space.key}/${p.sid}`));
			summary.push({ op: "add", created });
		} else if ("replace" in r) {
			const sid = firstResult?.sid ?? "";
			lines.push(
				`${n}. ${
					merged.shown.has(sid)
						? OUTLINE_TOOL_TEXT.edit.replacedMerged(sid)
						: merged.sids.has(sid)
							? OUTLINE_TOOL_TEXT.edit.replacedMergedUnshown(sid)
							: OUTLINE_TOOL_TEXT.edit.replaced(sid)
				}`,
			);
			const children = (edit.items?.[0]?.children ?? []) as PlannedItem[];
			if (children.length > 0) itemLines(children, 1, lines);
			summary.push({ op: "replace", address: `${space.key}/${sid}` });
		} else if ("move" in r) {
			const sid = firstResult?.sid ?? "";
			const to = where(edit.parent) ?? OUTLINE_TOOL_TEXT.edit.topLevel;
			lines.push(`${n}. ${OUTLINE_TOOL_TEXT.edit.moved(sid, to)}`);
			summary.push({ op: "move", address: `${space.key}/${sid}` });
		} else if ("delete" in r) {
			const sid = firstResult?.sid ?? "";
			lines.push(`${n}. ${OUTLINE_TOOL_TEXT.edit.deleted(sid)}`);
			summary.push({ op: "delete", address: `${space.key}/${sid}` });
		} else {
			const sid = firstResult?.sid ?? "";
			const parts: string[] = [];
			if (r.checkbox === "none") parts.push(OUTLINE_TOOL_TEXT.edit.noCheckbox);
			else if (r.checkbox !== undefined) parts.push(`[${TASK_BOX[STATUS_OF[r.checkbox]]}]`);
			const assignee = normalizeAssignee(r.assignee);
			if (assignee !== undefined)
				parts.push(assignee ? `@${assignee}` : OUTLINE_TOOL_TEXT.edit.noAssignee);
			if (edit.alias !== undefined)
				parts.push(
					edit.alias
						? OUTLINE_TOOL_TEXT.aliasMark(edit.alias).trim()
						: OUTLINE_TOOL_TEXT.edit.noAlias,
				);
			lines.push(`${n}. ${OUTLINE_TOOL_TEXT.edit.set(sid, parts)}`);
			summary.push({ op: "set", address: `${space.key}/${sid}` });
		}
	}
	lines.push(...merged.lines);
	const notes = [...edits.flatMap((edit) => edit.notes), ...extra.globalNotes];
	if (notes.length > 0)
		lines.push(OUTLINE_TOOL_TEXT.edit.notesHeader, ...notes.map((n) => `- ${n}`));
	if (extra.hints.length > 0)
		lines.push(OUTLINE_TOOL_TEXT.edit.hintsHeader, ...extra.hints.map((h) => `- ${h}`));
	return {
		output: lines.join("\n"),
		title: `OutlineEdit: ${edits.length} edit${edits.length === 1 ? "" : "s"}`,
		metadata: {
			...extra.meta,
			commit: result.commit,
			edits: summary,
			notes: notes.length,
			...mergedMeta,
		},
	};
}
