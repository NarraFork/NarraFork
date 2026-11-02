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
 * blocks of the page (created if missing, appended to otherwise) in one `import` commit, and
 * the fence keeps only the SOP. Bounded: one parse job (off the main thread when large), one
 * commit. Asked once per process for each session; the answer "nothing to import" is kept.
 *
 * FORKS
 * -----
 * A fork copies the page ({@link copyOutlineBehaviorPage}): the parent session's page as it is,
 * breadth first, at most {@link OUTLINE_BEHAVIOR_LIMITS.forkBlocks} blocks, with its short ids
 * (design §2.5: fork = copy). The rest of the session space is not copied (as in PR 3).
 */
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
import { breadthFirst } from "../outline/tree";
import { type OutlineCanonicalContent, type OutlineOp, writeOutline } from "../outline/write";
import { readSpecFile, writeSpecFile } from "../spec-vfs-service";
import { readTaskSession } from "./backend";

export const BEHAVIOR_FENCE_URI = "spec://behavior_fence";

export const OUTLINE_BEHAVIOR_LIMITS = {
	/** Blocks of the page a fork copies (one commit holds at most `OUTLINE_LIMITS.maxOps`). */
	forkBlocks: OUTLINE_LIMITS.maxOps,
	/** Content bytes a fork copies (one commit's content limit). */
	forkBytes: OUTLINE_LIMITS.maxTransactionBodyBytes,
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

/** A narrator's old fence split into its own text and the plugin's SOP; empty when unreadable. */
export async function readOldBehaviorFence(narratorId: string) {
	let content = "";
	try {
		content = (await readSpecFile(narratorId, BEHAVIOR_FENCE_URI)).content;
	} catch {
		// No namespace yet (or unreadable): no fence.
	}
	return splitBehaviorFence(content);
}

/** Sessions whose fence was found to hold nothing to import, in this process. */
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
	/** There was text, but it could not be imported (logged); the fence is left as it was. */
	| "failed";

/**
 * Move an outline root session's old fence text into its behavior page: one `import` commit,
 * then the fence is rewritten to its plugin SOP alone. Called when the session starts a run,
 * never on the request path. Never rejects.
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

async function runImport(narratorId: string, locale: Locale): Promise<OutlineBehaviorImport> {
	const session = await readTaskSession(narratorId);
	if (!session || session.backend !== "outline" || session.subagent) {
		nothingToImport.add(narratorId);
		return "nothing";
	}
	const fence = await readOldBehaviorFence(narratorId);
	if (!fence.own) {
		nothingToImport.add(narratorId);
		return "nothing";
	}
	const [parsed] = await processEditText({
		kind: "parse",
		inputs: [{ mode: "outline", text: fence.own }],
		labels: [],
	});
	const space = await ensureSessionSpace(narratorId);
	const page = await findBehaviorPage(space.id);
	const ops: OutlineOp[] = [];
	const canonical: Array<OutlineCanonicalContent | null> = [];
	const pageRef = page ? { id: page.id } : { tempId: "page" };
	if (!page) {
		ops.push({
			op: "insert",
			tempId: "page",
			parent: null,
			content: getOutlineBehaviorPageTitle(locale),
			alias: OUTLINE_BEHAVIOR_ALIAS,
		});
		canonical.push(null);
	}
	// Rules are not tasks: every item becomes a plain block (a checkbox in the old fence is
	// dropped, so nothing on the page starts or continues), and the properties (aliases,
	// prerequisites, dates) are left out so nothing can collide.
	let n = 0;
	const add = (items: readonly EditTextItem[], parent: { id: string } | { tempId: string }) => {
		for (const item of items) {
			const tempId = `b${n++}`;
			ops.push({ op: "insert", tempId, parent, content: item.content });
			canonical.push({ content: item.content, links: item.links });
			add(item.children, { tempId });
		}
	};
	add(parsed?.items ?? [], pageRef);
	// Asked once per process from here on, whatever happens: a failed import is not retried on
	// every run (the behavior view shows the fence text that stayed behind instead).
	nothingToImport.add(narratorId);
	if (ops.length === (page ? 0 : 1)) return "nothing";
	const owner = (await readNarrator(narratorId))?.ownerUserId ?? null;
	await writeOutline(
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
	// The page holds the text now; the fence keeps only the plugin's channel. Should this write
	// fail, a run after a restart would import the same text again (logged by the caller).
	await writeSpecFile(narratorId, BEHAVIOR_FENCE_URI, fence.sopSections, {
		actor: "agent",
		allowFenceMutation: true,
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
		const order = breadthFirst(subtree.root, "all", OUTLINE_BEHAVIOR_LIMITS.forkBlocks);
		await loadBodiesWithin(subtree.state, order, OUTLINE_BEHAVIOR_LIMITS.forkBytes);
		const copied: typeof order = [];
		let bytes = 0;
		for (const node of order) {
			if (node.content === null) break;
			const size = Buffer.byteLength(node.content, "utf8");
			if (bytes + size > OUTLINE_BEHAVIOR_LIMITS.forkBytes) break;
			// Breadth first: a parent is always copied before its children.
			if (node.parent && !copied.includes(node.parent)) continue;
			bytes += size;
			copied.push(node);
		}
		if (copied.length < order.length) {
			logger.warn("Fork copied only part of the behavior page", {
				parentNarratorId,
				childNarratorId,
				copied: copied.length,
				read: order.length,
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
		const ops: OutlineOp[] = copied.map((node, i) => {
			const content = normalized[i]?.content ?? node.content ?? "";
			const task = node.task
				? {
						status: node.task.status === "doing" ? ("todo" as const) : node.task.status,
						...(node.task.assignee ? { assignee: node.task.assignee } : {}),
					}
				: null;
			return {
				op: "insert",
				tempId: node.id,
				sid: node.sid,
				parent: node === subtree.root || !node.parent ? null : { tempId: node.parent.id },
				content,
				...(task ? { task } : {}),
				...(node.alias ? { alias: node.alias } : {}),
				...(node.tags && node.tags.length > 0 ? { tags: node.tags } : {}),
			};
		});
		const canonical = copied.map((_, i) => {
			const entry = normalized[i];
			return entry && entry.split.length === 0
				? { content: entry.content, links: entry.links }
				: null;
		});
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
