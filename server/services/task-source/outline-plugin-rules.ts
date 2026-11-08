/**
 * A plugin's rules on an outline session's behavior page (outline P2 PR 12a; PR 12 design §2.10):
 * `behavior_rules_set`, what the old `spec_behavior_fence_update` becomes in an outline session,
 * and the move of an SOP left in the old fence onto the page.
 *
 * THE BLOCK
 * ---------
 * One block per plugin on the session's behavior page (alias `behavior`, made when missing as PR 4
 * makes it): its first line names the plugin, the rules are the blocks under it. Its short id
 * follows from the plugin (short ids are unique within a space, so the session adds nothing, and a
 * fork's copy of the page keeps it: the fork's next update replaces the copy instead of adding a
 * second block), so it is found again and never drawn twice; a block a person deleted is brought
 * back by the next upsert (short ids are never reused), one moved off the page is moved back, a
 * `clear` deletes it. The rules are written as notes (`report` conversion: headings hold their sections,
 * a checkbox or `[[…]]` stays text), so nothing on the page starts or links. People write the
 * page freely; an agent only under the user turn's grant (PR 4), so a session cannot rewrite a
 * plugin's rules on its own.
 *
 * THE OLD FENCE
 * -------------
 * Until now a plugin's SOP lived in the session's `spec://behavior_fence` between the team
 * plugin's markers (`behavior-fence-sop.ts`), and PR 4's import left it there. Any rules write
 * takes it out of the fence afterwards (the fence keeps the rest, which PR 4's import moves). When
 * the plugin writing is not the one the markers name, the SOP is first moved into that plugin's
 * block (unless it has one already): nothing written by another plugin is lost. The old command
 * replaces the SOP section whoever calls it, so its conversion supersedes the SOP. A session
 * that starts a run moves an SOP still in its fence into the marked plugin's block
 * ({@link moveOutlineFenceSop}), once per process.
 *
 * A subagent keeps its own fence (a plugin's temporary worker has its own SOP there): the old
 * command still writes it, and `behavior_rules_set` refuses it (its boundary is its session's
 * page, D31).
 */
import { createHash } from "node:crypto";
import { hotSafe } from "@server/lib/hot-safe";
import { logger } from "@server/lib/logger";
import { getOutlineBehaviorPageTitle, getUserLanguage, type Locale } from "@server/lib/prompt-i18n";
import { TEAM_SOP_PLUGIN_ID } from "../behavior-fence-sop";
import { readNarrator } from "../outline/access-reads";
import { DELEGATION_BLOCK_TEXT } from "../outline/delegation-text";
import { processEditText } from "../outline/edit-text-runner";
import { OUTLINE_TEXT } from "../outline/messages";
import { OUTLINE_BEHAVIOR_ALIAS } from "../outline/model";
import { oneAtATime } from "../outline/person-tasks";
import {
	latestSeq,
	PluginTaskError,
	type PluginTaskSession,
	resolvePluginTaskSession,
	writeForPlugin,
} from "../outline/plugin-tasks";
import { loadBodiesWithin, readSubtree } from "../outline/read";
import type { ReportBlock } from "../outline/report-text";
import { outlineStore } from "../outline/store";
import type { OutlineSpaceRow, OutlineStore } from "../outline/store/port";
import { type OutlineNode, subtreeNodes } from "../outline/tree";
import type { OutlineCanonicalContent, OutlineOp } from "../outline/write";
import { writeSpecFile } from "../spec-vfs-service";
import { readTaskSession } from "./backend";
import { BEHAVIOR_FENCE_URI, findBehaviorPage, readOldBehaviorFence } from "./outline-behavior";

export const OUTLINE_PLUGIN_RULES_LIMITS = {
	/** Characters of a plugin's rules (the old command's limit). */
	textChars: 2000,
	/** Blocks under a plugin's block one replacement deletes (its top-level children). */
	children: 200,
} as const;

/** The first line of a plugin's block, in the session owner's language. */
export const OUTLINE_PLUGIN_RULES_TITLE: Record<Locale, (pluginId: string) => string> = {
	en: (pluginId) => `Rules from plugin ${pluginId}`,
	"zh-CN": (pluginId) => `插件 ${pluginId} 的规程`,
};

/** The short id of a plugin's block in a session space: the same for the same plugin. */
export function pluginRulesSid(pluginId: string): string {
	const tag = createHash("sha256")
		.update(`plugin-rules\u0000${pluginId}`)
		.digest("hex")
		.slice(0, 12);
	return `pr${tag}`;
}

export interface OutlinePluginRulesWritten {
	/** The plugin's block after the write; null when cleared, or there was none to clear. */
	blockId: string | null;
	/** The commit wrote something. */
	changed: boolean;
	space: OutlineSpaceRow | null;
	/** The space's latest commit after the write (0 when there is no space). */
	seq: number;
}

/** The rules as blocks: notes only, within one commit (see the module header). */
async function rulesBlocks(text: string, locale: Locale): Promise<ReportBlock[]> {
	const converted = await processEditText({
		kind: "report",
		text,
		continued: DELEGATION_BLOCK_TEXT[locale].continued,
	});
	return converted.blocks;
}

/**
 * Write (`text`) or clear (null) the block of `pluginId` on the session's behavior page, in one
 * commit. Nothing is written when there is nothing to clear.
 */
async function writeRulesBlock(
	session: PluginTaskSession,
	pluginId: string,
	text: string | null,
	options: { store: OutlineStore; summary?: string },
): Promise<OutlinePluginRulesWritten> {
	const { store } = options;
	const sid = pluginRulesSid(pluginId);
	const existingSpace = await store.findSpace({ kind: "session", narratorId: session.narratorId });
	if (text === null && !existingSpace)
		return { blockId: null, changed: false, space: null, seq: 0 };
	const space =
		existingSpace ??
		(await store.ensureSpace(
			{ kind: "session", narratorId: session.narratorId },
			new Date().toISOString(),
		));
	const [block] = await store.getBlockMetas(space.id, { sids: [sid] });
	const page = await findBehaviorPage(space.id, store);
	const ops: OutlineOp[] = [];
	const canonical: Array<OutlineCanonicalContent | null> = [];
	const push = (op: OutlineOp, content: OutlineCanonicalContent | null = null) => {
		ops.push(op);
		canonical.push(content);
	};
	if (text === null) {
		if (!block || block.deleted)
			return { blockId: null, changed: false, space, seq: latestSeq(space) };
		push({ op: "delete", block: { id: block.id } });
	} else {
		const blocks = await rulesBlocks(text, session.locale);
		// The same rules where they belong: nothing to write (a plugin may send them on every
		// dispatch; each would otherwise be a commit on the session's timeline).
		if (
			block &&
			!block.deleted &&
			page &&
			block.parentId === page.id &&
			(await holdsRules(store, block.id, blocks))
		)
			return { blockId: block.id, changed: false, space, seq: latestSeq(space) };
		const pageRef = page ? { id: page.id } : { tempId: "page" };
		if (!page)
			push({
				op: "insert",
				tempId: "page",
				parent: null,
				content: getOutlineBehaviorPageTitle(session.locale),
				alias: OUTLINE_BEHAVIOR_ALIAS,
			});
		if (block && !block.deleted) {
			// A person moved it off the page: back to the page, last.
			if (!page || block.pageId !== page.id)
				push({ op: "move", block: { id: block.id }, parent: pageRef });
			// The rules are replaced: what is under the block now goes, the new rules go in.
			const children = await store.listChildMetas(
				space.id,
				[block.id],
				OUTLINE_PLUGIN_RULES_LIMITS.children + 1,
			);
			if (children.length > OUTLINE_PLUGIN_RULES_LIMITS.children)
				throw new PluginTaskError(
					"PAYLOAD_TOO_LARGE",
					"The plugin's block holds more blocks than one update replaces",
				);
			for (const child of children) push({ op: "delete", block: { id: child.id } });
		} else if (block) {
			// Deleted by a person: brought back on the page, its old rules stay deleted.
			push({ op: "restore", block: { id: block.id }, parent: pageRef });
		} else {
			push({
				op: "insert",
				tempId: "rules",
				sid,
				parent: pageRef,
				content: OUTLINE_PLUGIN_RULES_TITLE[session.locale](pluginId),
			});
		}
		const parentRef = block ? { id: block.id } : { tempId: "rules" };
		const walk = (nodes: readonly ReportBlock[], parent: { id: string } | { tempId: string }) => {
			for (const node of nodes) {
				const tempId = `r${ops.length}`;
				push(
					{ op: "insert", tempId, parent, content: node.content },
					{ content: node.content, links: node.links },
				);
				walk(node.children, { tempId });
			}
		};
		walk(blocks, parentRef);
	}
	const result = await writeForPlugin(
		session,
		space,
		pluginId,
		ops,
		options.summary ??
			(text === null
				? OUTLINE_TEXT.pluginRulesCleared(pluginId)
				: OUTLINE_TEXT.pluginRulesSet(pluginId)),
		{ store, canonical },
	);
	const blockId =
		text === null
			? null
			: (block?.id ?? result.results.find((r) => r.sid === sid)?.blockId ?? null);
	return {
		blockId,
		changed: result.commit !== null,
		space,
		seq: result.commit?.seq ?? latestSeq(space),
	};
}

/**
 * Whether the plugin's block holds exactly these rules (contents and nesting) under it. Its
 * subtree is a few blocks (the rules are at most 2000 characters); a larger one is not compared.
 */
async function holdsRules(
	store: OutlineStore,
	blockId: string,
	blocks: readonly ReportBlock[],
): Promise<boolean> {
	const read = await readSubtree(blockId, { store });
	if (!read) return false;
	const nodes = subtreeNodes(read.root).filter((node) => node !== read.root);
	if (nodes.length > OUTLINE_PLUGIN_RULES_LIMITS.children) return false;
	await loadBodiesWithin(read.state, nodes, 64 * 1024, { store });
	const same = (have: readonly OutlineNode[], want: readonly ReportBlock[]): boolean =>
		have.length === want.length &&
		have.every((node, i) => {
			const block = want[i] as ReportBlock;
			return (
				node.content === block.content && node.task === null && same(node.children, block.children)
			);
		});
	return same(read.root.children, blocks);
}

/**
 * The session's old fence, or null when it cannot be read (the Dynamic Spec reads are SQLite only:
 * on PostgreSQL a plugin's rules are written without looking at an old SOP).
 */
async function oldFenceOrNull(narratorId: string) {
	try {
		return await readOldBehaviorFence(narratorId);
	} catch (error) {
		logger.warn("Could not read the old behavior fence for a plugin's rules", {
			narratorId,
			error: String(error),
		});
		return null;
	}
}

/** The old fence without its SOP, through the plugin-SOP channel: what any rules write ends with. */
async function dropFenceSop(narratorId: string): Promise<void> {
	const current = await readOldBehaviorFence(narratorId);
	if (!current.sopSections) return;
	await writeSpecFile(narratorId, BEHAVIOR_FENCE_URI, current.own, {
		actor: "system",
		createdBy: "system",
		pluginSop: true,
	});
}

/**
 * `behavior_rules_set`, and the old `spec_behavior_fence_update` in an outline session (`compat`:
 * it supersedes the SOP in the old fence, as it replaced it there). `upsert` with empty text
 * clears, as the old command did. Refused for a Dynamic Spec session and for a subagent.
 */
export async function setOutlinePluginRules(args: {
	narratorId: string;
	pluginId: string;
	mode: "upsert" | "clear";
	text?: string;
	compat?: boolean;
	store?: OutlineStore;
}): Promise<OutlinePluginRulesWritten> {
	const store = args.store ?? outlineStore;
	const text = (args.text ?? "").trim();
	if ([...text].length > OUTLINE_PLUGIN_RULES_LIMITS.textChars)
		throw new PluginTaskError(
			"INVALID_PARAMS",
			`A plugin's rules are limited to ${OUTLINE_PLUGIN_RULES_LIMITS.textChars} characters`,
		);
	const session = await resolvePluginTaskSession(args.narratorId);
	return await oneAtATime(`rules:${session.narratorId}`, async () => {
		const fence = await oldFenceOrNull(session.narratorId);
		// An SOP another plugin left in the fence is kept, in that plugin's block.
		if (fence?.sop && !args.compat && args.pluginId !== TEAM_SOP_PLUGIN_ID) {
			const space = await store.findSpace({ kind: "session", narratorId: session.narratorId });
			const sid = pluginRulesSid(TEAM_SOP_PLUGIN_ID);
			const [held] = space ? await store.getBlockMetas(space.id, { sids: [sid] }) : [];
			if (!held)
				await writeRulesBlock(session, TEAM_SOP_PLUGIN_ID, fence.sop, {
					store,
					summary: OUTLINE_TEXT.pluginSopMoved(TEAM_SOP_PLUGIN_ID),
				});
		}
		const written = await writeRulesBlock(
			session,
			args.pluginId,
			args.mode === "clear" || !text ? null : text,
			{ store },
		);
		if (fence?.sopSections) await dropFenceSop(session.narratorId);
		return written;
	});
}

/** Sessions whose old fence was looked at for an SOP in this process. */
const sopLooked = hotSafe("narrafork.outlinePluginRules.sopLooked", () => new Set<string>());

/**
 * At the start of a run of an outline root session: an SOP still in its old fence moves into the
 * block of the plugin the markers name (unless it has one: then the fence's copy is stale), and
 * leaves the fence. Once per process per session. Never rejects.
 */
export async function moveOutlineFenceSop(
	narratorId: string,
	options: { store?: OutlineStore } = {},
): Promise<"moved" | "dropped" | "nothing" | "failed"> {
	if (sopLooked.has(narratorId)) return "nothing";
	sopLooked.add(narratorId);
	try {
		const row = await readTaskSession(narratorId);
		if (!row || row.backend !== "outline" || row.subagent) return "nothing";
		const fence = await readOldBehaviorFence(narratorId);
		if (!fence.sopSections) return "nothing";
		const store = options.store ?? outlineStore;
		const owner = (await readNarrator(narratorId))?.ownerUserId ?? null;
		const session: PluginTaskSession = {
			narratorId,
			ownerUserId: owner,
			locale: owner ? await getUserLanguage(owner).catch(() => "en" as const) : "en",
		};
		return await oneAtATime(`rules:${narratorId}`, async () => {
			const current = await readOldBehaviorFence(narratorId);
			if (!current.sopSections) return "nothing" as const;
			const space = await store.findSpace({ kind: "session", narratorId });
			const sid = pluginRulesSid(TEAM_SOP_PLUGIN_ID);
			const [held] = space ? await store.getBlockMetas(space.id, { sids: [sid] }) : [];
			let outcome: "moved" | "dropped" = "dropped";
			if (!held && current.sop) {
				await writeRulesBlock(session, TEAM_SOP_PLUGIN_ID, current.sop, {
					store,
					summary: OUTLINE_TEXT.pluginSopMoved(TEAM_SOP_PLUGIN_ID),
				});
				outcome = "moved";
			}
			await dropFenceSop(narratorId);
			return outcome;
		});
	} catch (error) {
		logger.warn("Could not move a plugin's SOP from the old fence to the behavior page", {
			narratorId,
			error: String(error),
		});
		return "failed";
	}
}

/** Forget which sessions were looked at (tests). */
export function resetOutlineFenceSopMove(narratorId?: string): void {
	if (narratorId === undefined) sopLooked.clear();
	else sopLooked.delete(narratorId);
}
