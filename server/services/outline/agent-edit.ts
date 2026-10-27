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
 *   4. Check what the agent read: a block it is changing that someone else changed after the
 *      agent last read it is a conflict, reported with its current text; nothing is written.
 *   5. Write one transaction with provenance (this narrator as actor, the turn's person as
 *      responsible, the message and tool call), content handed over already normalized.
 *
 * The result lists each edit's outcome with the addresses of new blocks, the notes, and hints
 * about the space (a page with the same title already exists). Everything it shows comes from
 * the space being written, which the session may read.
 */

import { NotFoundError } from "@server/lib/errors";
import {
	type BodyRef,
	isAlias,
	type OutlineNote,
	parseAliasValue,
	TASK_BOX,
} from "@shared/outline";
import type { OutlineToolOutput } from "./agent-read";
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
import { OutlineBusyError, OutlineConflictError, OutlineWriteError } from "./errors";
import { newOutlineSid } from "./keys";
import { linkDisplayTitle } from "./link-display";
import { OUTLINE_TOOL_TEXT } from "./messages";
import { OUTLINE_LIMITS } from "./model";
import { forgetOutlineReads, recordOutlineReads, seenOutlineVersion } from "./read-ledger";
import type { OutlineResolvedBlock } from "./resolve";
import type { OutlineSpaceRow } from "./store/port";
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
} as const;

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

	// 4. What the agent read.
	const existingIds = [
		...new Set(
			edits.flatMap((edit) => (edit.located?.kind === "block" ? [edit.located.block.id] : [])),
		),
	];
	const current = new Map(
		(await scope.store.getBlockMetas(space.id, { ids: existingIds })).map((m) => [m.id, m]),
	);
	const stale = [...current.values()].filter((m) => {
		const seen = seenOutlineVersion(scope.narratorId, m.id);
		return seen !== undefined && m.versionSeq > seen;
	});
	if (stale.length > 0) {
		const commits = new Map(
			(
				await scope.store.getCommitsBySeqs(space.id, [...new Set(stale.map((m) => m.versionSeq))])
			).map((c) => [c.seq, c]),
		);
		const conflicts = stale.filter((m) => {
			const commit = commits.get(m.versionSeq);
			return !(commit?.actorKind === "agent" && commit.actorId === scope.narratorId);
		});
		if (conflicts.length > 0) {
			return await conflictOutput(
				scope,
				space,
				conflicts.map((m) => ({
					blockId: m.id,
					sid: m.sid,
					seen: seenOutlineVersion(scope.narratorId, m.id) as number,
					now: m.versionSeq,
					by: commits.get(m.versionSeq),
				})),
				meta,
			);
		}
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
			const props = p.item.props;
			push(
				edit,
				{
					op: "update",
					block: { id: block.id },
					content: p.content,
					baseVersionSeq: base(block.id),
					...(p.alias !== undefined ? { alias: p.alias } : {}),
					...(props.tags?.length ? { tags: props.tags.map((t) => t.target) } : {}),
				},
				{ content: p.content, links: p.links },
			);
			const depends = dependsOf(p.item);
			if (p.item.task || depends?.length || props.due) {
				const task: OutlineTaskPatch = {
					...(p.item.task ? { status: p.item.task.status } : {}),
					...(p.item.task?.assignee ? { assignee: p.item.task.assignee } : {}),
					...(depends?.length ? { depends } : {}),
					...(props.due ? { due: props.due } : {}),
				};
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

	// Hints: a new page whose title another page of the space already has.
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
		if (error instanceof OutlineConflictError) {
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
		if (error instanceof OutlineWriteError) {
			const at = error.opIndex === null ? undefined : edits[opEdit[error.opIndex] as number];
			const message = error.message.replace(/^operation \d+: /, "");
			return failed([at ? `${label(at)}: ${message}` : message]);
		}
		if (error instanceof OutlineBusyError) return failed([OUTLINE_TOOL_TEXT.edit.busy]);
		if (error instanceof NotFoundError) return failed([error.message]);
		throw error;
	}

	// The read ledger follows the agent's own writes.
	const commit = result.commit;
	if (commit) {
		const written: Array<readonly [string, number]> = [];
		const deleted: string[] = [];
		result.results.forEach((r, i) => {
			if (!r) return;
			if (ops[i]?.op === "delete") deleted.push(r.blockId);
			else written.push([r.blockId, commit.seq]);
			for (const s of r.split) written.push([s.blockId, commit.seq]);
		});
		recordOutlineReads(scope.narratorId, written);
		forgetOutlineReads(scope.narratorId, deleted);
	}

	return successOutput(space, spaceText, edits, result, { globalNotes, hints, meta });
}

async function conflictOutput(
	scope: OutlineAgentScope,
	space: OutlineSpaceRow,
	conflicts: Array<{
		blockId: string;
		sid: string;
		seen: number;
		now: number;
		by?: { actorKind: string; actorId: string };
	}>,
	meta: Record<string, unknown>,
): Promise<OutlineToolOutput> {
	const blocks = new Map(
		(await scope.store.getBlocks(conflicts.map((c) => c.blockId))).map((b) => [b.id, b]),
	);
	const lines: string[] = [OUTLINE_TOOL_TEXT.edit.conflictHeader];
	for (const c of conflicts) {
		const who = !c.by
			? OUTLINE_TOOL_TEXT.edit.someone
			: c.by.actorKind === "human"
				? OUTLINE_TOOL_TEXT.edit.aPerson
				: c.by.actorKind === "agent"
					? OUTLINE_TOOL_TEXT.edit.anotherAgent
					: OUTLINE_TOOL_TEXT.edit.theSystem;
		lines.push(`- ${OUTLINE_TOOL_TEXT.edit.conflict(c.sid, who, c.now, c.seen)}`);
		const block = blocks.get(c.blockId);
		if (block && !block.deleted) {
			const text = clip(block.content.split("\n").join(" "), OUTLINE_EDIT_LIMITS.maxConflictChars);
			lines.push(`  ${OUTLINE_TOOL_TEXT.edit.nowReads(text)}`);
		} else if (block?.deleted) lines.push(`  ${OUTLINE_TOOL_TEXT.edit.nowDeleted}`);
	}
	lines.push(OUTLINE_TOOL_TEXT.edit.conflictRecover(space.key));
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

function successOutput(
	space: OutlineSpaceRow,
	spaceText: string,
	edits: readonly EditState[],
	result: OutlineWriteResult,
	extra: { globalNotes: string[]; hints: string[]; meta: Record<string, unknown> },
): OutlineToolOutput {
	if (!result.commit) {
		return {
			output: OUTLINE_TOOL_TEXT.edit.noChange,
			metadata: { ...extra.meta, commit: null },
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
			lines.push(`${n}. ${OUTLINE_TOOL_TEXT.edit.replaced(sid)}`);
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
		},
	};
}
