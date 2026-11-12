/**
 * An outline session's behavior boundary (outline plan PR 4, decisions 2026-11-02 Q1, Q2; D43).
 *
 * WHERE IT LIVES
 * --------------
 * One page per root session, in its session space, holding the alias `behavior`
 * (`OUTLINE_BEHAVIOR_ALIAS`). People write it in the outline; the agent only under the one-shot
 * grant of a user turn (the write path refuses it otherwise, `write.ts`); subagents read their
 * root's (D31). Since outline P2 PR 12a a plugin writes its rules as its own block on the page
 * (`outline-plugin-rules.ts`); the old `spec://behavior_fence` of an outline session keeps only an
 * SOP written before that, which moves to the page when the session next runs, and a subagent's
 * own SOP (a plugin's temporary worker).
 *
 * THE IMPORT
 * ----------
 * A session created before PR 4 may have text in its old fence. When it next starts a run
 * ({@link importOutlineBehaviorFence}), everything in the fence but the plugin's SOP becomes
 * plain blocks of the page (created if missing, appended to otherwise) in `import` commits (one
 * for an ordinary fence; as many as the write limits need for a large one), and the fence keeps
 * only the SOP. The blocks' short ids follow from the text, so a run cut short resumes where it
 * stopped and nothing is imported twice; a block a person deleted since stays deleted, with what
 * was under it. An item longer than a block may hold becomes several blocks, so no commit is
 * refused for good. Should a commit fail anyway, the behavior view shows what did not reach the
 * page ({@link importLeftover}) until a later run moves it. Bounded: one parse job and normalize
 * jobs for cut items (off the main thread when large), commits within the write limits. Asked
 * once per process for each session.
 *
 * Should the outline be switched off later, the session runs as a spec session and reads its
 * old fence: the spec fence reader puts the page's text ahead of it then
 * (`behaviorPageForSpecFence`), so the rules the import moved never drop out.
 *
 * FORKS
 * -----
 * A fork copies the page ({@link copyOutlineBehaviorPage}): the parent session's page as it is,
 * without checkboxes, breadth first, at most {@link OUTLINE_BEHAVIOR_LIMITS.forkBlocks} blocks
 * with a note when cut, with its short ids (design §2.5: fork = copy). The rest of the session
 * space is not copied (as in PR 3).
 */
import { createHash } from "node:crypto";
import { hotSafe } from "@server/lib/hot-safe";
import { logger } from "@server/lib/logger";
import {
	getOutlineBehaviorForkCutNote,
	getOutlineBehaviorPageTitle,
	getUserLanguage,
	type Locale,
} from "@server/lib/prompt-i18n";
import { splitBehaviorFence } from "../behavior-fence-sop";
import { readNarrator } from "../outline/access-reads";
import type { EditTextItem } from "../outline/edit-text";
import { OUTLINE_EDIT_TEXT_LIMITS, processEditText } from "../outline/edit-text-runner";
import { OUTLINE_TEXT } from "../outline/messages";
import { OUTLINE_BEHAVIOR_ALIAS, OUTLINE_LIMITS } from "../outline/model";
import { loadBodiesWithin, readSubtree } from "../outline/read";
import { ensureSessionSpace } from "../outline/spaces";
import { outlineStore } from "../outline/store";
import type { OutlineBlockMeta, OutlineStore } from "../outline/store/port";
import { breadthFirst, subtreeNodes } from "../outline/tree";
import { type OutlineCanonicalContent, type OutlineOp, writeOutline } from "../outline/write";
import { specVfsService, writeSpecFile } from "../spec-vfs-service";
import { readTaskSession } from "./backend";

export const BEHAVIOR_FENCE_URI = "spec://behavior_fence";

export const OUTLINE_BEHAVIOR_LIMITS = {
	/** Blocks a fork copies, with its note (one commit holds at most `OUTLINE_LIMITS.maxOps`). */
	forkBlocks: OUTLINE_LIMITS.maxOps,
	/** Content bytes a fork copies (one commit's content limit). */
	forkBytes: OUTLINE_LIMITS.maxTransactionBodyBytes,
	/** Bytes kept for the note a cut fork copy ends with. */
	noteBytes: 1024,
	/** Operations of one import commit (a larger fence is imported in several). */
	importOps: OUTLINE_LIMITS.maxOps,
	/** Content bytes of one import commit. */
	importBytes: OUTLINE_LIMITS.maxTransactionBodyBytes - 1024,
	/** Short ids one lookup of what an earlier run imported already asks for. */
	sidLookup: 400,
	/** Bytes of one imported block: a longer item is cut into several (one block holds 16 KiB). */
	importBlockBytes: OUTLINE_LIMITS.maxBodyBytes - 1024,
} as const;

/** The system actors of the import and of the fork copy. */
export const OUTLINE_BEHAVIOR_IMPORT_ACTOR = "outline-behavior-import";
export const OUTLINE_BEHAVIOR_FORK_ACTOR = "outline-behavior-fork";

/**
 * The behavior page of a session space: the live page holding alias `behavior`. Null when no
 * block holds it, or the one that does is not a page (a person gave the alias to a nested block).
 * One alias read and one primary-key read.
 */
export async function findBehaviorPage(
	spaceId: string,
	store: OutlineStore = outlineStore,
): Promise<OutlineBlockMeta | null> {
	const [owner] = await store.findAliasOwners(spaceId, [OUTLINE_BEHAVIOR_ALIAS]);
	if (!owner) return null;
	const [meta] = await store.getBlockMetas(spaceId, { ids: [owner.id] });
	return meta && !meta.deleted && meta.parentId === null ? meta : null;
}

/**
 * A narrator's old fence split into its own text and the plugin's SOP, read without creating its
 * spec namespace (the readers are on a run's or a request's path); empty when it has none.
 */
export async function readOldBehaviorFence(narratorId: string) {
	const content = await specVfsService.readSpecFileContentIfExists(narratorId, BEHAVIOR_FENCE_URI);
	return splitBehaviorFence(content ?? "");
}

/** Sessions whose fence was looked at by the import in this process. */
const nothingToImport = hotSafe(
	"narrafork.outlineBehavior.nothingToImport",
	() => new Set<string>(),
);
const importing = hotSafe(
	"narrafork.outlineBehavior.importing",
	() => new Map<string, Promise<OutlineBehaviorImport>>(),
);

export type OutlineBehaviorImport =
	/** The fence text is now on the page; the fence keeps only the plugin's SOP. */
	| "imported"
	/** Nothing to import: not an outline root session, or no text besides the SOP. */
	| "nothing"
	/**
	 * There was text, but not all of it could be imported (logged). The fence is left as it was,
	 * and the behavior view shows what of it did not reach the page until a later run imports it.
	 */
	| "failed";

/**
 * Move an outline root session's old fence text into its behavior page, then rewrite the fence
 * to its plugin SOP alone. Called when the session starts a run, never on the request path.
 * Never rejects.
 */
export async function importOutlineBehaviorFence(
	narratorId: string,
	locale: Locale,
): Promise<OutlineBehaviorImport> {
	if (nothingToImport.has(narratorId)) return "nothing";
	const running = importing.get(narratorId);
	if (running) return await running;
	const run = runImport(narratorId, locale)
		.catch((error: unknown) => {
			logger.warn("Outline behavior fence import failed", { narratorId, error: String(error) });
			return "failed" as const;
		})
		.finally(() => importing.delete(narratorId));
	importing.set(narratorId, run);
	return await run;
}

/** One block the import writes: its stable short id, its parent's (null: the page) and content. */
interface ImportNode {
	sid: string;
	parentSid: string | null;
	content: string;
	links: OutlineCanonicalContent["links"];
	/** The content is a piece of a longer item, cut to fit one block: normalized before writing. */
	piece: boolean;
	depth: number;
}

/**
 * The short ids of an import follow from the fence text: the same text gets the same ids, so a
 * run cut short (a failed commit, a restart) skips what is in the space already and writes the
 * rest, and two writers of the same text cannot both succeed (a taken short id refuses a commit).
 * Longer than the 8 characters drawn ids have, so they never collide with one.
 */
function importSids(text: string): { page: string; block: (n: number) => string } {
	const tag = behaviorImportTag(text);
	return { page: `fp${tag}`, block: (n) => `fi${tag}${n.toString(36)}` };
}

function behaviorImportTag(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 10);
}

/**
 * The fence text a block of the behavior page was imported from, as a tag: the same for every
 * block an import of one text wrote, compared with {@link behaviorImportTagOf}. Null for a block
 * no import wrote.
 */
export function behaviorImportTagOfSid(sid: string): string | null {
	return /^fi([0-9a-f]{10})[0-9a-z]+$/.exec(sid)?.[1] ?? null;
}

/** The tag of the blocks an import of the fence text `own` writes (null: it writes none). */
export function behaviorImportTagOf(own: string): string | null {
	return own ? behaviorImportTag(own) : null;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * The last grapheme boundary of `text` at or before `at` (a UTF-16 index), so a cut there never
 * splits a ZWJ emoji or a letter from its combining marks. Only a short window around `at` is
 * segmented, never the whole text; a cluster longer than that window (none in practice) may be
 * cut inside.
 */
export function graphemeBoundary(text: string, at: number): number {
	if (at <= 0) return 0;
	if (at >= text.length) return text.length;
	const from = Math.max(0, at - 64);
	let boundary = from;
	for (const { index } of graphemes.segment(text.slice(from, Math.min(text.length, at + 64)))) {
		if (from + index > at) break;
		boundary = from + index;
	}
	return boundary;
}

/**
 * Text cut into pieces of at most `maxBytes` UTF-8 bytes, losing nothing: the pieces joined are
 * the text. A cut falls after a line break or a space when one is in the second half of a piece
 * (it stays with the first piece), else at the last grapheme boundary. An item longer than one
 * block may hold becomes several blocks instead of refusing its commit on every run.
 */
export function cutToBlocks(text: string, maxBytes: number): string[] {
	const out: string[] = [];
	let rest = text;
	while (Buffer.byteLength(rest, "utf8") > maxBytes) {
		let bytes = 0;
		let end = 0;
		for (const char of rest) {
			const size = Buffer.byteLength(char, "utf8");
			if (bytes + size > maxBytes) break;
			bytes += size;
			end += char.length;
		}
		const soft = Math.max(rest.lastIndexOf("\n", end - 1), rest.lastIndexOf(" ", end - 1));
		if (soft >= end / 2) end = soft + 1;
		else {
			const boundary = graphemeBoundary(rest, end);
			if (boundary > 0) end = boundary;
		}
		out.push(rest.slice(0, end));
		rest = rest.slice(end);
	}
	if (rest) out.push(rest);
	return out;
}

/** Fence text the session's last import in this process could not move, by session. */
const leftovers = hotSafe(
	"narrafork.outlineBehavior.leftovers",
	() => new Map<string, { own: string; text: string }>(),
);

/**
 * What of the fence text `own` is not on the behavior page yet, as the session's last import in
 * this process found it (a markdown outline of the blocks it could not write), or null when it
 * has not looked at this text: then all of it is still to move. The behavior view shows this
 * instead of the fence from its top, so the rules that never reached the page are the ones shown.
 */
export function importLeftover(narratorId: string, own: string): string | null {
	const found = leftovers.get(narratorId);
	return found && found.own === own ? found.text : null;
}

/** Text squeezed of whitespace: a plugin's SOP update can glue the text around it together. */
const squeezed = (text: string) => text.replace(/\s+/g, "");

async function runImport(narratorId: string, locale: Locale): Promise<OutlineBehaviorImport> {
	const session = await readTaskSession(narratorId);
	if (!session || session.backend !== "outline" || session.subagent) {
		nothingToImport.add(narratorId);
		return "nothing";
	}
	const fence = await readOldBehaviorFence(narratorId);
	// Asked once per process from here on, whatever happens: a failed import is not retried on
	// every run (the behavior view shows the fence text that stayed behind instead).
	nothingToImport.add(narratorId);
	if ((await importBehaviorFenceText(narratorId, locale, fence.own)) === "nothing")
		return "nothing";

	// The page holds the text now; the fence keeps only the plugin's channel. It is read again
	// right before the write so a plugin SOP update that landed during the import is kept. The
	// fence's own text is compared without whitespace: the plugin's update rejoins the text
	// around an SOP in the middle of the fence without the blank line it had, and that must not
	// leave the moved text behind to be imported again (glued) after a restart. Own text that
	// really changed meanwhile is left alone (the view shows it, a later run imports it).
	const current = await readOldBehaviorFence(narratorId);
	if (squeezed(current.own) !== squeezed(fence.own)) return "imported";
	await writeSpecFile(narratorId, BEHAVIOR_FENCE_URI, current.sopSections, {
		actor: "system",
		createdBy: "system",
		pluginSop: true,
	});
	return "imported";
}

/**
 * Write a fence's own text `own` (everything but the plugin's SOP) onto the session's behavior
 * page, as described in the module header; the fence itself is neither read nor rewritten. What
 * the import of a whole Dynamic Spec session calls before it moves the session to the outline
 * (outline P2 PR 12b, which reads the fence through its own port): the short ids follow from the
 * text, so the session's first run as an outline session finds the text there and only empties
 * the fence. Rejects when a commit fails (what was not written is kept for the behavior view).
 */
export async function importBehaviorFenceText(
	narratorId: string,
	locale: Locale,
	own: string,
	options: { signal?: AbortSignal } = {},
): Promise<"imported" | "nothing"> {
	const { signal } = options;
	const fence = { own };
	leftovers.delete(narratorId);
	if (!fence.own) return "nothing";
	const [parsed] = await processEditText(
		{
			kind: "parse",
			inputs: [{ mode: "outline", text: fence.own }],
			labels: [],
		},
		{ signal },
	);
	// Rules are not tasks: every item becomes a plain block (a checkbox in the old fence is
	// dropped, so nothing on the page starts or continues), and the properties (aliases,
	// prerequisites, dates) are left out so nothing can collide. An item longer than a block may
	// hold becomes several sibling blocks.
	const sids = importSids(fence.own);
	const nodes: ImportNode[] = [];
	const walk = (items: readonly EditTextItem[], parentSid: string | null, depth: number) => {
		for (const item of items) {
			// A piece of nothing but whitespace (a long run of it at a cut) would be an empty block.
			const pieces = cutToBlocks(item.content, OUTLINE_BEHAVIOR_LIMITS.importBlockBytes).filter(
				(piece) => piece.trim() !== "",
			);
			let first: string | null = null;
			for (const piece of pieces.length > 0 ? pieces : [item.content]) {
				const sid = sids.block(nodes.length);
				first ??= sid;
				const whole = pieces.length <= 1;
				nodes.push({
					sid,
					parentSid,
					content: piece,
					links: whole ? item.links : [],
					piece: !whole,
					depth,
				});
			}
			walk(item.children, first, depth + 1);
		}
	};
	walk(parsed?.items ?? [], null, 0);
	if (nodes.length === 0) return "nothing";
	// Pieces of a cut item are normalized like any content, off the main thread when large, in
	// jobs the text runner takes. A piece whose cut left structure the dialect splits off (rare:
	// an item over a block's size with, say, a code fence cut through) goes to the write path as
	// is, which splits it the same way.
	const cut = nodes.filter((node) => node.piece);
	for (let i = 0; i < cut.length; ) {
		const job: ImportNode[] = [];
		let bytes = 0;
		for (; i < cut.length; i++) {
			const node = cut[i] as ImportNode;
			const size = Buffer.byteLength(node.content, "utf8");
			if (job.length > 0 && bytes + size > OUTLINE_EDIT_TEXT_LIMITS.maxBytes / 2) break;
			job.push(node);
			bytes += size;
		}
		const normalized = await processEditText(
			{
				kind: "normalize",
				contents: job.map((node) => node.content),
			},
			{ signal },
		);
		job.forEach((node, n) => {
			const entry = normalized[n];
			if (entry && entry.split.length === 0) {
				node.content = entry.content;
				node.links = entry.links;
				node.piece = false;
			}
		});
	}

	// What is in the space already: written by an earlier run cut short, or deleted since by a
	// person. A deleted one stands deleted, and so do the blocks under it: they are skipped.
	const space = await ensureSessionSpace(narratorId);
	const existing = new Map<string, boolean>();
	const lookup = [...nodes.map((node) => node.sid), sids.page];
	for (let i = 0; i < lookup.length; i += OUTLINE_BEHAVIOR_LIMITS.sidLookup) {
		const chunk = lookup.slice(i, i + OUTLINE_BEHAVIOR_LIMITS.sidLookup);
		for (const meta of await outlineStore.getBlockMetas(space.id, { sids: chunk })) {
			existing.set(meta.sid, meta.deleted);
		}
	}
	const skipped = new Set<string>();
	const pending: ImportNode[] = [];
	for (const node of nodes) {
		if (node.parentSid !== null && skipped.has(node.parentSid)) {
			skipped.add(node.sid);
			continue;
		}
		const deleted = existing.get(node.sid);
		if (deleted === true) skipped.add(node.sid);
		if (deleted !== undefined) continue;
		pending.push(node);
	}
	let pageId = (await findBehaviorPage(space.id))?.id ?? null;
	const owner = (await readNarrator(narratorId))?.ownerUserId ?? null;

	// As many commits as the write limits need (a small fence is one commit), parents first. With
	// nothing left to write (all of it there, or deleted by a person) no page is created.
	let at = 0;
	let written = 0;
	try {
		while (at < pending.length) {
			const ops: OutlineOp[] = [];
			const canonical: Array<OutlineCanonicalContent | null> = [];
			const inThisCommit = new Set<string>();
			let bytes = 0;
			if (pageId === null) {
				const title = getOutlineBehaviorPageTitle(locale);
				// The page's stable short id, unless a page of an earlier run holds it (a person
				// deleted that page, or took its alias): then a drawn one.
				ops.push({
					op: "insert",
					tempId: "page",
					...(existing.has(sids.page) ? {} : { sid: sids.page }),
					parent: null,
					content: title,
					alias: OUTLINE_BEHAVIOR_ALIAS,
				});
				canonical.push(null);
				bytes += Buffer.byteLength(title, "utf8");
			}
			for (; at < pending.length; at++) {
				const node = pending[at] as ImportNode;
				const size = Buffer.byteLength(node.content, "utf8");
				if (
					ops.length >= OUTLINE_BEHAVIOR_LIMITS.importOps ||
					(ops.length > 0 && bytes + size > OUTLINE_BEHAVIOR_LIMITS.importBytes)
				)
					break;
				const parent =
					node.parentSid === null
						? pageId === null
							? { tempId: "page" }
							: { id: pageId }
						: inThisCommit.has(node.parentSid)
							? { tempId: node.parentSid }
							: { sid: node.parentSid };
				ops.push({ op: "insert", tempId: node.sid, sid: node.sid, parent, content: node.content });
				canonical.push(node.piece ? null : { content: node.content, links: node.links });
				inThisCommit.add(node.sid);
				bytes += size;
			}
			// Checked between commits: a commit is whole, what follows is written by the next run.
			signal?.throwIfAborted();
			const result = await writeOutline(
				{
					spaceId: space.id,
					ops,
					actor: { kind: "system", id: OUTLINE_BEHAVIOR_IMPORT_ACTOR },
					responsibleUserId: owner,
					narratorId,
					summary: OUTLINE_TEXT.behaviorImportSummary,
				},
				{ kind: "import", canonical },
			);
			if (pageId === null) pageId = result.results[0]?.blockId ?? null;
			if (pageId === null) throw new Error("the import could not create the behavior page");
			written = at;
		}
	} catch (error) {
		// What did not reach the page is what the view shows from the fence, until a later run
		// (a restart) writes it.
		const lines = pending.slice(written).map((node) => {
			const pad = "  ".repeat(node.depth);
			return `${pad}- ${node.content.replace(/\n/g, `\n${pad}  `)}`;
		});
		leftovers.set(narratorId, { own: fence.own, text: lines.join("\n") });
		throw error;
	}
	// All of it is on the page: should the fence rewrite below fail or be skipped, the view does
	// not show the moved text a second time. (The commits marked the cached views stale; when
	// none landed, nothing reached the page and the leftover is the fence's whole text.)
	leftovers.set(narratorId, { own: fence.own, text: "" });
	return "imported";
}

/**
 * Forget what the import found for a session (tests; a session whose fence changed hands).
 * Without an argument, for every session.
 */
export function resetOutlineBehaviorImport(narratorId?: string): void {
	if (narratorId === undefined) {
		nothingToImport.clear();
		leftovers.clear();
	} else {
		nothingToImport.delete(narratorId);
		leftovers.delete(narratorId);
	}
}

/**
 * Copy the parent session's behavior page into a fork's session space (design §2.5: fork = copy;
 * plan PR 4: the page is copied, the rest of the session space is not). Only when the fork's
 * session is an outline one and has no behavior page yet. The parent may be a subagent (a
 * subagent extracted into a session of its own): its root's page is copied. Never rejects.
 *
 * Rules are not tasks: checkboxes are not copied (as the import drops them). A page larger than
 * one commit is cut breadth first, and a first block says how much was copied and where the rest
 * is, so the fork's view says it too.
 */
export async function copyOutlineBehaviorPage(
	parentNarratorId: string,
	childNarratorId: string,
): Promise<boolean> {
	try {
		const child = await readTaskSession(childNarratorId);
		if (!child || child.backend !== "outline" || child.subagent) return false;
		const parent = await readTaskSession(parentNarratorId);
		const parentSession = parent?.sessionNarratorId ?? parentNarratorId;
		const parentSpace = await outlineStore.findSpace({
			kind: "session",
			narratorId: parentSession,
		});
		if (!parentSpace) return false;
		const page = await findBehaviorPage(parentSpace.id);
		if (!page) return false;
		const subtree = await readSubtree(page.id);
		if (!subtree) return false;
		// One operation is kept for the note a cut copy ends with.
		const room = OUTLINE_BEHAVIOR_LIMITS.forkBlocks - 1;
		const order = breadthFirst(subtree.root, "all", room);
		await loadBodiesWithin(subtree.state, order, OUTLINE_BEHAVIOR_LIMITS.forkBytes);
		const copied: typeof order = [];
		let bytes = 0;
		for (const node of order) {
			if (node.content === null) break;
			const size = Buffer.byteLength(node.content, "utf8");
			if (bytes + size > OUTLINE_BEHAVIOR_LIMITS.forkBytes - OUTLINE_BEHAVIOR_LIMITS.noteBytes)
				break;
			// Breadth first: a parent is always copied before its children.
			if (node.parent && !copied.includes(node.parent)) continue;
			bytes += size;
			copied.push(node);
		}
		const total = subtreeNodes(subtree.root).length;
		const cut = copied.length < total || subtree.state.truncated;
		if (cut) {
			logger.warn("Fork copied only part of the behavior page", {
				parentNarratorId,
				childNarratorId,
				copied: copied.length,
				total,
			});
		}
		const childSpace = await ensureSessionSpace(childNarratorId);
		if (await findBehaviorPage(childSpace.id)) return false;
		const owner = (await readNarrator(childNarratorId))?.ownerUserId ?? null;
		// Stored content is canonical already; the normalizer only confirms it (off the main
		// thread when large) and reads its links.
		const normalized = await processEditText({
			kind: "normalize",
			contents: copied.map((node) => node.content ?? ""),
		});
		const ops: OutlineOp[] = copied.map((node, i) => ({
			op: "insert",
			tempId: node.id,
			sid: node.sid,
			parent: node === subtree.root || !node.parent ? null : { tempId: node.parent.id },
			content: normalized[i]?.content ?? node.content ?? "",
			...(node.alias ? { alias: node.alias } : {}),
			...(node.tags && node.tags.length > 0 ? { tags: node.tags } : {}),
		}));
		const canonical: Array<OutlineCanonicalContent | null> = copied.map((_, i) => {
			const entry = normalized[i];
			return entry && entry.split.length === 0
				? { content: entry.content, links: entry.links }
				: null;
		});
		if (cut) {
			// First on the page, so whoever reads it (the fork's view included) sees it.
			ops.push({
				op: "insert",
				parent: { tempId: subtree.root.id },
				position: { first: true },
				content: getOutlineBehaviorForkCutNote(
					copied.length,
					total,
					`${parentSpace.key}/${page.sid}`,
					owner ? await getUserLanguage(owner) : "en",
				),
			});
			canonical.push(null);
		}
		await writeOutline(
			{
				spaceId: childSpace.id,
				ops,
				actor: { kind: "system", id: OUTLINE_BEHAVIOR_FORK_ACTOR },
				responsibleUserId: owner,
				narratorId: childNarratorId,
				summary: OUTLINE_TEXT.behaviorForkSummary(parentSession),
			},
			{ canonical },
		);
		return true;
	} catch (error) {
		logger.warn("Fork could not copy the behavior page", {
			parentNarratorId,
			childNarratorId,
			error: String(error),
		});
		return false;
	}
}
