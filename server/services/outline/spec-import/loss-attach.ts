/**
 * Putting what the old Spec panel may have swallowed on the page (outline P2 PR 12c; PR 12 design
 * §2.9, owner decision D52: 「照常导入，只附在页上」). A finding of the scan (`loss-scan.ts`) is
 * ATTACHED to the page its file was imported to, automatically, and shown nowhere else: no import
 * notice, no digest line, no question. Nothing of the page's own content is ever rewritten.
 *
 * WHAT AN ATTACH WRITES
 *
 * One commit of the system actor `spec-import-check` (a routine actor in digests), answered for
 * by the session's owner (or the person who asked): one block at the top of the page saying what
 * it is, and under it the lost content as it stood before the save, tables converted from their
 * markdown (as the import writes tables), everything else kept as source in code blocks. The
 * conversion runs on the background text worker; when it fails nothing is written.
 *
 * WHEN ({@link attachSpecLossForSession}, called by the scan's pass, never on a request)
 *
 * Only for a session whose tasks are in the outline (imported) and that no import is working on;
 * a session still in Dynamic Spec keeps its findings open until a pass after its import. For each
 * open finding not tried before (or left by a cap, or failed), oldest first:
 *   - the file's imported page is not there → `no_page`, left to a person;
 *   - the file's current revision holds the content again → `restored`, not attached;
 *   - {@link SPEC_LOSS_ATTACH_LIMITS.perPage} findings are attached to the page already →
 *     `page_cap`, left to a person (the scan reports removals on purpose too: a page is not
 *     buried under them);
 *   - {@link SPEC_LOSS_ATTACH_LIMITS.perSessionPass} were attached for the session in this pass →
 *     `session_cap`, attached by a later pass;
 *   - otherwise attached. A failure is `failed` and tried again by a later pass.
 *
 * IDEMPOTENT
 *
 * The block's short id follows from (finding, its attach sequence): an attach that wrote the
 * block and did not get to record it finds the block and records it, never a second one.
 *
 * A BLOCK THAT IS GONE ({@link reopenLostAttachments})
 *
 * When the block of an attached finding was deleted by a SYSTEM commit (a plugin's old
 * `spec_write index.md` replacing the page, a re-import taking a stale page away), the finding is
 * open again and attached anew by the same pass, under its next sequence. A block a person or an
 * agent deleted stays deleted: that is how a person disposes of it.
 *
 * DISMISSING ({@link removeSpecLossBlock})
 *
 * The block of a dismissed finding is deleted when only this module ever wrote it and what is
 * under it; a block someone edited or added to is kept as it is.
 */
import { createHash } from "node:crypto";
import { catalogError } from "@server/lib/errors";
import { getUserLanguage } from "@server/lib/i18n";
import { logger } from "@server/lib/logger";
import type { Locale } from "@server/lib/prompt-i18n";
import type { OutlineSpecLossAttachNote, OutlineSpecLossKind } from "@shared/outline-spec-import";
import {
	SPEC_LOSS_FENCE_PATH,
	SPEC_LOSS_KINDS,
	type SpecLossExcerptPart,
} from "@shared/spec-content-loss";
import { specIndexSid } from "../../plugin-spec-compat";
import { isSpecImporting } from "../../task-source/backend";
import { findBehaviorPage } from "../../task-source/outline-behavior";
import { processBackgroundText } from "../edit-text-runner";
import type { ReportBlock } from "../report-text";
import { outlineStore } from "../store";
import type { OutlineSpaceRow } from "../store/port";
import { type OutlineCanonicalContent, type OutlineOp, writeOutline } from "../write";
import { isSpecImportRunning } from "./importer";
import {
	bumpSpecLossAttachSeq,
	countSpecLossAttached,
	listSpecLossAttached,
	listSpecLossToAttach,
	markSpecLossSessionCap,
	type SpecLossFindingRow,
	setSpecLossAttachNote,
	setSpecLossFindingStatus,
} from "./loss-store";
import { OUTLINE_SPEC_LOSS_ACTOR, SPEC_IMPORT_TEXT, specFileTag } from "./plan";
import {
	readSpecFilePointers,
	readSpecRevisionContents,
	type SpecImportFilePointer,
	type SpecImportSession,
} from "./read-port";

export const SPEC_LOSS_ATTACH_LIMITS = {
	/** Findings attached automatically to one page; more are left to a person. */
	perPage: 20,
	/** Findings attached for one session in one pass; the rest by later passes. */
	perSessionPass: 10,
	/** Attached findings of one session whose blocks a pass looks at. */
	attachedChecked: 200,
	/** Blocks under an attached block read to see who wrote them (dismiss). */
	subtreeBlocks: 300,
	/** Versions of one block read for that. */
	versionsPerBlock: 20,
	/** Blocks one attach writes at most (a commit takes 200 operations). */
	blocks: 180,
} as const;

const KIND_NAMES: Record<Locale, Record<OutlineSpecLossKind, (n: number) => string>> = {
	en: {
		table: (n) => `${n} table${n === 1 ? "" : "s"}`,
		html: (n) => `${n} piece${n === 1 ? "" : "s"} of HTML`,
		image: (n) => `${n} image${n === 1 ? "" : "s"}`,
		taskItem: (n) => `${n} task item${n === 1 ? "" : "s"}`,
		footnote: (n) => `${n} footnote${n === 1 ? "" : "s"}`,
		frontMatter: () => "the front matter",
	},
	"zh-CN": {
		table: (n) => `${n} 张表格`,
		html: (n) => `${n} 处 HTML`,
		image: (n) => `${n} 张图片`,
		taskItem: (n) => `${n} 个任务项`,
		footnote: (n) => `${n} 处脚注`,
		frontMatter: () => "开头的 front matter",
	},
};

const TEXT: Record<
	Locale,
	{
		header: (day: string, what: string, truncated: boolean) => string;
		summary: (path: string) => string;
		summaryRemoved: (path: string) => string;
		unknownDay: string;
	}
> = {
	en: {
		header: (day, what, truncated) =>
			`Possibly lost content. A save from the Spec panel (${day}) left out what the version before it held: ${what}. It is below as it stood then${truncated ? " (the beginning only: it was too long to keep whole)" : ""}. Move it back into the page or delete this block; nothing else was changed.`,
		summary: (path) => `Content a Spec panel save may have lost, attached to ${path}`,
		summaryRemoved: (path) => `Dismissed: the possibly lost content attached to ${path} removed`,
		unknownDay: "date unknown",
	},
	"zh-CN": {
		header: (day, what, truncated) =>
			`可能丢失的内容。Spec 面板的一次保存（${day}）之后，上一版里的这些内容不见了：${what}。下面是它当时的原样${truncated ? "（只有开头一部分：太长，没有全部保留）" : ""}。要挪回正文还是删掉这一块，由你决定；页上其他内容没有改动。`,
		summary: (path) => `Spec 面板保存时可能丢失的内容，附在 ${path}`,
		summaryRemoved: (path) => `已忽略：删掉附在 ${path} 的可能丢失的内容`,
		unknownDay: "日期不详",
	},
};

function describeKinds(
	kinds: Partial<Record<OutlineSpecLossKind, number>>,
	locale: Locale,
): string {
	const names = SPEC_LOSS_KINDS.filter((kind) => (kinds[kind] ?? 0) > 0).map((kind) =>
		KIND_NAMES[locale][kind](kinds[kind] ?? 0),
	);
	return names.join(locale === "zh-CN" ? "、" : ", ");
}

/** The short id of the block an attach writes: the same attach again is the same block. */
export function specLossBlockSid(findingId: string, attachSeq = 0): string {
	const source = attachSeq === 0 ? findingId : `${findingId}\u0000${attachSeq}`;
	return `sl${createHash("sha256").update(source).digest("hex").slice(0, 14)}`;
}

function flatten(
	blocks: readonly ReportBlock[],
	parent: string,
	prefix: string,
	out: Array<{ tempId: string; parent: string; block: ReportBlock }>,
): void {
	blocks.forEach((block, n) => {
		const tempId = `${prefix}${n.toString(36)}`;
		out.push({ tempId, parent, block });
		flatten(block.children, tempId, `${tempId}-`, out);
	});
}

/** The lost text as blocks: tables from their markdown, the rest as source in code blocks. */
async function convertParts(
	parts: readonly SpecLossExcerptPart[],
	locale: Locale,
	signal?: AbortSignal,
): Promise<ReportBlock[]> {
	const continued = SPEC_IMPORT_TEXT[locale].continued;
	const tables = parts.filter((part) => part.kind === "table").map((part) => part.text);
	const rest = parts.filter((part) => part.kind !== "table").map((part) => part.text);
	const blocks: ReportBlock[] = [];
	let count = 0;
	if (tables.length > 0) {
		const converted = await processBackgroundText(
			{ kind: "notes", text: tables.join("\n\n"), continued },
			{ signal },
		);
		count += converted.count;
		blocks.push(...converted.blocks);
	}
	// Too many blocks from the tables: everything as source instead, which is cut by size.
	const all = count > SPEC_LOSS_ATTACH_LIMITS.blocks;
	if (rest.length > 0 || all) {
		if (all) blocks.length = 0;
		const converted = await processBackgroundText(
			{
				kind: "notes",
				text: (all ? parts.map((part) => part.text) : rest).join("\n\n"),
				continued,
				code: "markdown",
			},
			{ signal },
		);
		blocks.push(...converted.blocks);
	}
	return blocks;
}

/** What one session's attaches read once: its space and its Dynamic Spec file pointers. */
interface AttachContext {
	session: SpecImportSession;
	space: OutlineSpaceRow | null;
	pointers: readonly SpecImportFilePointer[] | null;
	/** Structures of the files' current revisions, by revision (the restored check). */
	current: Map<string, Set<string> | null>;
	signal?: AbortSignal;
}

async function contextOf(session: SpecImportSession, signal?: AbortSignal): Promise<AttachContext> {
	return {
		session,
		space: await outlineStore.findSpace({ kind: "session", narratorId: session.narratorId }),
		pointers: null,
		current: new Map(),
		signal,
	};
}

async function pointerOf(ctx: AttachContext, path: string): Promise<SpecImportFilePointer | null> {
	if (ctx.pointers === null)
		ctx.pointers = ctx.session.namespaceId
			? await readSpecFilePointers(ctx.session.namespaceId)
			: [];
	return ctx.pointers.find((pointer) => pointer.path === path) ?? null;
}

/**
 * The live page the import made for the file: the behavior page for the fence, else the page
 * whose short id follows from the file's current revision. Null when it is not there.
 */
async function pageOf(ctx: AttachContext, path: string): Promise<string | null> {
	if (!ctx.space) return null;
	if (path === SPEC_LOSS_FENCE_PATH) return (await findBehaviorPage(ctx.space.id))?.id ?? null;
	const pointer = await pointerOf(ctx, path);
	if (!pointer?.revisionId) return null;
	const sid =
		path === "index.md"
			? specIndexSid()
			: `sp${specFileTag(ctx.session.narratorId, path, pointer.revisionId)}`;
	const [page] = await outlineStore.getBlockMetas(ctx.space.id, { sids: [sid] });
	return page && !page.deleted && page.parentId === null ? page.id : null;
}

const structureId = (item: { kind: string; key: string }) => `${item.kind}\u0000${item.key}`;

/**
 * Whether the file's current revision holds everything the finding kept of what was lost: it was
 * put back since the scan. False when that cannot be told (nothing to compare, unreadable).
 */
async function restoredSince(ctx: AttachContext, row: SpecLossFindingRow): Promise<boolean> {
	const pointer = await pointerOf(ctx, row.path);
	if (!pointer?.revisionId || row.parts.length === 0) return false;
	let current = ctx.current.get(pointer.revisionId);
	if (current === undefined) {
		const content = (await readSpecRevisionContents([pointer.revisionId])).get(pointer.revisionId);
		current = null;
		if (content !== undefined) {
			const [items = []] = await processBackgroundText(
				{ kind: "specLoss", contents: [content] },
				{ signal: ctx.signal },
			);
			current = new Set(items.map(structureId));
		}
		ctx.current.set(pointer.revisionId, current);
	}
	if (current === null) return false;
	const lost = (
		await processBackgroundText(
			{ kind: "specLoss", contents: row.parts.map((part) => part.text) },
			{ signal: ctx.signal },
		)
	).flat();
	return lost.length > 0 && lost.every((item) => current.has(structureId(item)));
}

type AttachResult = { blockId: string } | { note: OutlineSpecLossAttachNote };

/**
 * Attach one finding (see the module header). `auto`: the pass's attach, with the restored check
 * and the page cap; a person's own request has neither. Rejects when the conversion or the write
 * fails (nothing is written then).
 */
async function attachOne(
	ctx: AttachContext,
	row: SpecLossFindingRow,
	options: { auto: boolean; userId: string | null },
): Promise<AttachResult> {
	const { space } = ctx;
	const pageId = await pageOf(ctx, row.path);
	if (!space || pageId === null) return { note: "no_page" };
	let seq = row.attachSeq;
	let [written] = await outlineStore.getBlockMetas(space.id, {
		sids: [specLossBlockSid(row.id, seq)],
	});
	// Written before and not recorded (the process stopped in between): that block is the one.
	if (written && !written.deleted) return { blockId: written.id };
	if (options.auto) {
		if (await restoredSince(ctx, row)) return { note: "restored" };
		const cap = SPEC_LOSS_ATTACH_LIMITS.perPage;
		if ((await countSpecLossAttached(row.narratorId, row.path, cap)) >= cap)
			return { note: "page_cap" };
	}
	if (written?.deleted) {
		// Its block was deleted: attached anew under the next short id (a short id is never reused).
		seq = await bumpSpecLossAttachSeq(row.id, seq);
		[written] = await outlineStore.getBlockMetas(space.id, {
			sids: [specLossBlockSid(row.id, seq)],
		});
		if (written && !written.deleted) return { blockId: written.id };
		if (written) throw new Error("spec loss attach: the next block was deleted meanwhile");
	}
	const owner = options.userId ?? ctx.session.ownerUserId;
	const locale: Locale = owner ? await getUserLanguage(owner).catch(() => "en" as const) : "en";
	const text = TEXT[locale];
	const blocks = await convertParts(row.parts, locale, ctx.signal);
	const flat: Array<{ tempId: string; parent: string; block: ReportBlock }> = [];
	flatten(blocks, "h", "c", flat);
	if (flat.length > SPEC_LOSS_ATTACH_LIMITS.blocks + 15)
		throw new Error("spec loss attach: the excerpt converts to too many blocks");
	const ops: OutlineOp[] = [
		{
			op: "insert",
			tempId: "h",
			sid: specLossBlockSid(row.id, seq),
			parent: { id: pageId },
			position: { first: true },
			content: text.header(
				row.savedAt?.slice(0, 10) || text.unknownDay,
				describeKinds(row.kinds, locale),
				row.truncated,
			),
		},
	];
	const canonical: Array<OutlineCanonicalContent | null> = [null];
	for (const entry of flat) {
		ops.push({
			op: "insert",
			tempId: entry.tempId,
			parent: { tempId: entry.parent },
			content: entry.block.content,
		});
		canonical.push({ content: entry.block.content, links: entry.block.links });
	}
	const result = await writeOutline(
		{
			spaceId: space.id,
			ops,
			actor: { kind: "system", id: OUTLINE_SPEC_LOSS_ACTOR },
			responsibleUserId: owner,
			narratorId: row.narratorId,
			summary: text.summary(row.path),
		},
		{ canonical },
	);
	const blockId = result.results[0]?.blockId;
	if (!blockId) throw new Error("spec loss attach: the write returned no block");
	return { blockId };
}

/**
 * A person asks for an open finding to be attached (the automatic attach left it out, or they
 * reopened it). Rejects with why it cannot be (`SPEC_LOSS_NOT_IMPORTED`, `SPEC_LOSS_NO_PAGE`),
 * or when the write fails; the block's id otherwise.
 */
export async function attachSpecLossFinding(
	session: SpecImportSession,
	row: SpecLossFindingRow,
	userId: string,
): Promise<string> {
	if (session.taskBackend !== "outline") throw catalogError("SPEC_LOSS_NOT_IMPORTED");
	const result = await attachOne(await contextOf(session), row, { auto: false, userId });
	if ("note" in result) throw catalogError("SPEC_LOSS_NO_PAGE");
	logger.info("Possibly lost Dynamic Spec content attached to its imported page", {
		narratorId: row.narratorId,
		findingId: row.id,
		path: row.path,
		userId,
	});
	return result.blockId;
}

/**
 * Attached findings whose block a SYSTEM commit deleted are open again (see the module header).
 * Bounded: the session's attached findings up to a limit, their blocks by id, and for a deleted
 * one its last versions and that commit. The number reopened.
 */
export async function reopenLostAttachments(
	session: SpecImportSession,
	space: OutlineSpaceRow,
): Promise<number> {
	const limits = SPEC_LOSS_ATTACH_LIMITS;
	const attached = (await listSpecLossAttached(session.narratorId, limits.attachedChecked)).filter(
		(entry): entry is { id: string; blockId: string } => entry.blockId !== null,
	);
	let reopened = 0;
	for (let i = 0; i < attached.length; i += 100) {
		const chunk = attached.slice(i, i + 100);
		const metas = new Map(
			(await outlineStore.getBlockMetas(space.id, { ids: chunk.map((e) => e.blockId) })).map(
				(meta) => [meta.id, meta],
			),
		);
		for (const entry of chunk) {
			const meta = metas.get(entry.blockId);
			if (!meta?.deleted) continue;
			const [commit] = await outlineStore.getCommitsBySeqs(space.id, [meta.versionSeq]);
			// A person's or an agent's deletion is how the block is disposed of: it stays deleted.
			if (!commit || commit.actorKind !== "system" || commit.actorId === OUTLINE_SPEC_LOSS_ACTOR)
				continue;
			if (
				await setSpecLossFindingStatus({
					id: entry.id,
					from: ["attached"],
					to: "open",
					userId: null,
					blockId: null,
				})
			)
				reopened++;
		}
	}
	return reopened;
}

export interface SpecLossAttachRun {
	attached: number;
	/** Open findings left for a later pass (the session cap, a failure). */
	left: number;
}

/**
 * One pass's attaches for one session (see the module header). Never rejects: a failed attach is
 * noted on its finding and counted as left.
 */
export async function attachSpecLossForSession(
	session: SpecImportSession,
	options: { signal?: AbortSignal; max?: number } = {},
): Promise<SpecLossAttachRun> {
	const run: SpecLossAttachRun = { attached: 0, left: 0 };
	const { narratorId } = session;
	if (session.taskBackend !== "outline") return run;
	// An import (or a move back) is working on the session's space: a later pass.
	if (isSpecImportRunning(narratorId) || isSpecImporting(narratorId)) return run;
	try {
		const ctx = await contextOf(session, options.signal);
		if (!ctx.space) return run;
		await reopenLostAttachments(session, ctx.space);
		const max = options.max ?? SPEC_LOSS_ATTACH_LIMITS.perSessionPass;
		const rows = await listSpecLossToAttach(narratorId, max + 1);
		for (const row of rows.slice(0, max)) {
			options.signal?.throwIfAborted();
			let result: AttachResult;
			try {
				result = await attachOne(ctx, row, { auto: true, userId: null });
			} catch (error) {
				logger.warn("Could not attach possibly lost Dynamic Spec content", {
					narratorId,
					findingId: row.id,
					error: String(error),
				});
				result = { note: "failed" };
			}
			if ("blockId" in result) {
				if (
					await setSpecLossFindingStatus({
						id: row.id,
						from: ["open"],
						to: "attached",
						userId: null,
						blockId: result.blockId,
					})
				)
					run.attached++;
			} else {
				await setSpecLossAttachNote(row.id, result.note);
				if (result.note === "failed") run.left++;
			}
		}
		if (rows.length > max) {
			// The rest say why they wait; a later pass attaches them.
			await markSpecLossSessionCap(narratorId);
			run.left++;
		}
		if (run.attached > 0)
			logger.info("Possibly lost Dynamic Spec content attached to its imported pages", {
				narratorId,
				...run,
			});
	} catch (error) {
		run.left++;
		logger.warn("Attaching possibly lost Dynamic Spec content failed", {
			narratorId,
			error: String(error),
		});
	}
	return run;
}

/** Whether every commit that wrote the block and what is under it now is this module's. */
async function onlyAttachWrote(space: OutlineSpaceRow, blockId: string): Promise<boolean> {
	const limits = SPEC_LOSS_ATTACH_LIMITS;
	const blocks = [blockId];
	let level = [blockId];
	while (level.length > 0) {
		const children = await outlineStore.listChildMetas(
			space.id,
			level,
			limits.subtreeBlocks - blocks.length + 1,
		);
		if (blocks.length + children.length > limits.subtreeBlocks) return false;
		level = children.map((child) => child.id);
		blocks.push(...level);
	}
	const seqs = new Set<number>();
	for (const id of blocks) {
		const versions = await outlineStore.listBlockVersions(id, limits.versionsPerBlock + 1);
		if (versions.length > limits.versionsPerBlock) return false;
		for (const version of versions) seqs.add(version.fromSeq);
	}
	const wanted = [...seqs];
	let found = 0;
	for (let i = 0; i < wanted.length; i += 100)
		for (const commit of await outlineStore.getCommitsBySeqs(space.id, wanted.slice(i, i + 100))) {
			if (commit.actorKind !== "system" || commit.actorId !== OUTLINE_SPEC_LOSS_ACTOR) return false;
			found++;
		}
	return found === wanted.length;
}

/**
 * A finding is dismissed: its block goes when only the attach ever wrote it and what is under it
 * ("removed"); a block someone edited, added to or moved things into is kept ("kept"); "none"
 * when there is no live block. Rejects when the delete fails.
 */
export async function removeSpecLossBlock(
	row: SpecLossFindingRow,
	userId: string,
): Promise<"removed" | "kept" | "none"> {
	if (!row.blockId) return "none";
	const space = await outlineStore.findSpace({ kind: "session", narratorId: row.narratorId });
	if (!space) return "none";
	const [meta] = await outlineStore.getBlockMetas(space.id, { ids: [row.blockId] });
	if (!meta || meta.deleted) return "none";
	if (!(await onlyAttachWrote(space, meta.id))) return "kept";
	const locale: Locale = await getUserLanguage(userId).catch(() => "en" as const);
	await writeOutline({
		spaceId: space.id,
		ops: [{ op: "delete", block: { id: meta.id } }],
		actor: { kind: "system", id: OUTLINE_SPEC_LOSS_ACTOR },
		responsibleUserId: userId,
		narratorId: row.narratorId,
		summary: TEXT[locale].summaryRemoved(row.path),
	});
	return "removed";
}
