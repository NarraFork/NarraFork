/**
 * An outline session's behavior boundary (outline plan PR 4, decisions 2026-11-02 Q1, Q2; D43).
 *
 * WHERE IT LIVES
 * --------------
 * One page per root session, in its session space, holding the alias `behavior`
 * (`OUTLINE_BEHAVIOR_ALIAS`). People write it in the outline; the agent only under the one-shot
 * grant of a user turn (the write path refuses it otherwise, `write.ts`); subagents read their
 * root's (D31). Plugins still write their SOP into the old `spec://behavior_fence`, which in an
 * outline session is nothing but that channel until plugins write blocks (plan PR 12).
 *
 * THE IMPORT
 * ----------
 * A session created before PR 4 may have text in its old fence. When it next starts a run
 * ({@link importOutlineBehaviorFence}), everything in the fence but the plugin's SOP becomes
 * plain blocks of the page (created if missing, appended to otherwise) in `import` commits (one
 * for an ordinary fence; as many as the write limits need for a large one), and the fence keeps
 * only the SOP. The blocks' short ids follow from the text, so a run cut short resumes where it
 * stopped and nothing is imported twice. Bounded: one parse job (off the main thread when large),
 * commits within the write limits. Asked once per process for each session.
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
import { getOutlineBehaviorPageTitle, type Locale } from "@server/lib/prompt-i18n";
import { splitBehaviorFence } from "../behavior-fence-sop";
import { readNarrator } from "../outline/access-reads";
import type { EditTextItem } from "../outline/edit-text";
import { processEditText } from "../outline/edit-text-runner";
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
	 * and the behavior view shows its text until a later run imports it.
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
}

/**
 * The short ids of an import follow from the fence text: the same text gets the same ids, so a
 * run cut short (a failed commit, a restart) skips what is in the space already and writes the
 * rest, and two writers of the same text cannot both succeed (a taken short id refuses a commit).
 * Longer than the 8 characters drawn ids have, so they never collide with one.
 */
function importSids(text: string): { page: string; block: (n: number) => string } {
	const tag = createHash("sha256").update(text).digest("hex").slice(0, 10);
	return { page: `fp${tag}`, block: (n) => `fi${tag}${n.toString(36)}` };
}

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
	if (!fence.own) return "nothing";
	const [parsed] = await processEditText({
		kind: "parse",
		inputs: [{ mode: "outline", text: fence.own }],
		labels: [],
	});
	// Rules are not tasks: every item becomes a plain block (a checkbox in the old fence is
	// dropped, so nothing on the page starts or continues), and the properties (aliases,
	// prerequisites, dates) are left out so nothing can collide.
	const sids = importSids(fence.own);
	const nodes: ImportNode[] = [];
	const walk = (items: readonly EditTextItem[], parentSid: string | null) => {
		for (const item of items) {
			const sid = sids.block(nodes.length);
			nodes.push({ sid, parentSid, content: item.content, links: item.links });
			walk(item.children, sid);
		}
	};
	walk(parsed?.items ?? [], null);
	if (nodes.length === 0) return "nothing";

	const space = await ensureSessionSpace(narratorId);
	const done = new Set<string>();
	for (let i = 0; i < nodes.length; i += OUTLINE_BEHAVIOR_LIMITS.sidLookup) {
		const chunk = nodes.slice(i, i + OUTLINE_BEHAVIOR_LIMITS.sidLookup).map((node) => node.sid);
		for (const meta of await outlineStore.getBlockMetas(space.id, { sids: chunk })) {
			done.add(meta.sid);
		}
	}
	const pending = nodes.filter((node) => !done.has(node.sid));
	let pageId = (await findBehaviorPage(space.id))?.id ?? null;
	const owner = (await readNarrator(narratorId))?.ownerUserId ?? null;

	// As many commits as the write limits need (a small fence is one commit), parents first.
	let at = 0;
	while (at < pending.length || pageId === null) {
		const ops: OutlineOp[] = [];
		const canonical: Array<OutlineCanonicalContent | null> = [];
		const inThisCommit = new Set<string>();
		let bytes = 0;
		if (pageId === null) {
			const title = getOutlineBehaviorPageTitle(locale);
			ops.push({
				op: "insert",
				tempId: "page",
				sid: sids.page,
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
			canonical.push({ content: node.content, links: node.links });
			inThisCommit.add(node.sid);
			bytes += size;
		}
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
	}

	// The page holds the text now; the fence keeps only the plugin's channel. It is read again
	// right before the write so a plugin SOP update that landed during the import is kept; text of
	// its own that changed meanwhile is left alone (the view shows it, a later run imports it).
	const current = await readOldBehaviorFence(narratorId);
	if (current.own !== fence.own) return "imported";
	await writeSpecFile(narratorId, BEHAVIOR_FENCE_URI, current.sopSections, {
		actor: "system",
		createdBy: "system",
		pluginSop: true,
	});
	return "imported";
}

/**
 * Forget what the import found for a session (tests; a session whose fence changed hands).
 * Without an argument, for every session.
 */
export function resetOutlineBehaviorImport(narratorId?: string): void {
	if (narratorId === undefined) nothingToImport.clear();
	else nothingToImport.delete(narratorId);
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
				content: OUTLINE_TEXT.behaviorForkCut(
					copied.length,
					total,
					`${parentSpace.key}/${page.sid}`,
				),
			});
			canonical.push(null);
		}
		const owner = (await readNarrator(childNarratorId))?.ownerUserId ?? null;
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
