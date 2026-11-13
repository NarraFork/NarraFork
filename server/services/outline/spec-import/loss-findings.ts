/**
 * What people see and do about content the old Spec panel may have swallowed (outline P2 PR 12c;
 * owner decision D52: found and shown, never repaired automatically). The scan (`loss-scan.ts`)
 * only records findings; here they are listed (an administrator: every session's; a session's
 * reader: that session's), read one at a time with the lost text, and decided, one at a time, by
 * a person:
 *
 *   - ATTACH: the lost text is put on the file's imported page, as one block at the very top
 *     saying what it is, with the text under it as it stood before the save (tables converted
 *     from their markdown, everything else kept as source in code blocks). Nothing of the page's
 *     own content is touched; whether it goes back into the text is the person's to decide, by
 *     moving or deleting the block. Only for a session whose tasks are in the outline and whose
 *     page for the file is there; the commit is the system's (`spec-import-check`), answered for
 *     by the person who asked.
 *   - DISMISS: a save that removed the content on purpose reads as a loss too; dismissing says
 *     so. REOPEN undoes it.
 *
 * A decision is a conditional update of the finding's status, so two people deciding at once do
 * not both win. The conversion runs on the background text worker; when it fails nothing is
 * written and the finding stays open.
 */
import { createHash } from "node:crypto";
import { catalogError, NotFoundError } from "@server/lib/errors";
import { getUserLanguage } from "@server/lib/i18n";
import { logger } from "@server/lib/logger";
import type { Locale } from "@server/lib/prompt-i18n";
import type {
	OutlineSpecLossAction,
	OutlineSpecLossDetail,
	OutlineSpecLossFinding,
	OutlineSpecLossKind,
	OutlineSpecLossPage,
	OutlineSpecLossStatus,
} from "@shared/outline-spec-import";
import {
	SPEC_LOSS_FENCE_PATH,
	SPEC_LOSS_KINDS,
	type SpecLossExcerptPart,
} from "@shared/spec-content-loss";
import { specIndexSid } from "../../plugin-spec-compat";
import { findBehaviorPage } from "../../task-source/outline-behavior";
import { processBackgroundText } from "../edit-text-runner";
import type { ReportBlock } from "../report-text";
import { outlineStore } from "../store";
import { type OutlineCanonicalContent, type OutlineOp, writeOutline } from "../write";
import { specLossScanStatus } from "./loss-scan";
import {
	countSpecLossFindings,
	listSpecLossFindings,
	readSpecLossFinding,
	SPEC_LOSS_STORE_LIMITS,
	type SpecLossCursor,
	type SpecLossFindingRow,
	setSpecLossFindingStatus,
} from "./loss-store";
import { OUTLINE_SPEC_LOSS_ACTOR, SPEC_IMPORT_TEXT, specFileTag } from "./plan";
import { readSpecFilePointers, readSpecImportSession } from "./read-port";

/** Operations one attach may need at most (a commit takes 200). */
const ATTACH_MAX_BLOCKS = 180;

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
		unknownDay: string;
	}
> = {
	en: {
		header: (day, what, truncated) =>
			`Possibly lost content. A save from the Spec panel (${day}) left out what the version before it held: ${what}. It is below as it stood then${truncated ? " (the beginning only: it was too long to keep whole)" : ""}. Move it back into the page or delete this block; nothing was changed automatically.`,
		summary: (path) => `Content a Spec panel save may have lost, attached to ${path}`,
		unknownDay: "date unknown",
	},
	"zh-CN": {
		header: (day, what, truncated) =>
			`可能丢失的内容。Spec 面板的一次保存（${day}）之后，上一版里的这些内容不见了：${what}。下面是它当时的原样${truncated ? "（只有开头一部分：太长，没有全部保留）" : ""}。要挪回正文还是删掉这一块，由你决定；系统没有自动改动任何内容。`,
		summary: (path) => `Spec 面板保存时可能丢失的内容，附在 ${path}`,
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

function encodeCursor(cursor: SpecLossCursor | null): string | null {
	return cursor ? Buffer.from(JSON.stringify(cursor)).toString("base64url") : null;
}

function decodeCursor(cursor: string | null | undefined): SpecLossCursor | null {
	if (!cursor) return null;
	try {
		const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
		if (
			parsed &&
			typeof parsed === "object" &&
			typeof (parsed as SpecLossCursor).createdAt === "string" &&
			typeof (parsed as SpecLossCursor).id === "string"
		)
			return parsed as SpecLossCursor;
	} catch {
		// An unreadable cursor reads the first page.
	}
	return null;
}

function publicFinding(row: SpecLossFindingRow): OutlineSpecLossFinding {
	return {
		id: row.id,
		narratorId: row.narratorId,
		title: row.title,
		path: row.path,
		savedAt: row.savedAt,
		kinds: row.kinds,
		truncated: row.truncated,
		status: row.status,
		blockId: row.blockId,
		spaceId: row.spaceId,
		resolvedAt: row.resolvedAt,
		createdAt: row.createdAt,
		attachable: row.attachable,
	};
}

/**
 * One page of the findings in `status`, newest first, with the count per status: one session's
 * (`narratorId`), or every session's with how the scan is doing (administrators).
 */
export async function specLossPage(options: {
	status: OutlineSpecLossStatus;
	narratorId?: string | null;
	cursor?: string | null;
	limit?: number;
	canAct: boolean;
}): Promise<OutlineSpecLossPage> {
	const [counts, page] = await Promise.all([
		countSpecLossFindings(options.narratorId),
		listSpecLossFindings({
			status: options.status,
			narratorId: options.narratorId,
			after: decodeCursor(options.cursor),
			limit: options.limit,
		}),
	]);
	return {
		items: page.items.map(publicFinding),
		next: encodeCursor(page.next),
		counts,
		countCap: SPEC_LOSS_STORE_LIMITS.countCap,
		canAct: options.canAct,
		...(options.narratorId ? {} : { scan: specLossScanStatus() }),
	};
}

/** A finding of `narratorId` (any session's when null), or a 404. */
async function findingOf(
	id: string,
	narratorId: string | null,
	withExcerpt: boolean,
): Promise<SpecLossFindingRow> {
	const row = await readSpecLossFinding(id, { withExcerpt });
	if (!row || (narratorId !== null && row.narratorId !== narratorId))
		throw new NotFoundError("Finding", id);
	return row;
}

/** One finding with the lost text. */
export async function specLossDetail(
	id: string,
	narratorId: string | null,
): Promise<OutlineSpecLossDetail> {
	const row = await findingOf(id, narratorId, true);
	return { ...publicFinding(row), parts: row.parts };
}

/** The short id of the block an attach writes: the same finding attached again is the same block. */
export function specLossBlockSid(findingId: string): string {
	return `sl${createHash("sha256").update(findingId).digest("hex").slice(0, 14)}`;
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
): Promise<ReportBlock[]> {
	const continued = SPEC_IMPORT_TEXT[locale].continued;
	const tables = parts.filter((part) => part.kind === "table").map((part) => part.text);
	const rest = parts.filter((part) => part.kind !== "table").map((part) => part.text);
	const blocks: ReportBlock[] = [];
	let count = 0;
	if (tables.length > 0) {
		const converted = await processBackgroundText({
			kind: "notes",
			text: tables.join("\n\n"),
			continued,
		});
		count += converted.count;
		blocks.push(...converted.blocks);
	}
	if (rest.length > 0 || count > ATTACH_MAX_BLOCKS) {
		// Too many blocks from the tables: everything as source instead, which is cut by size.
		const all = count > ATTACH_MAX_BLOCKS;
		if (all) blocks.length = 0;
		const converted = await processBackgroundText({
			kind: "notes",
			text: (all ? parts.map((part) => part.text) : rest).join("\n\n"),
			continued,
			code: "markdown",
		});
		blocks.push(...converted.blocks);
	}
	return blocks;
}

async function attach(row: SpecLossFindingRow, userId: string): Promise<string> {
	if (row.taskBackend !== "outline") throw catalogError("SPEC_LOSS_NOT_IMPORTED");
	const session = await readSpecImportSession(row.narratorId);
	const space = await outlineStore.findSpace({ kind: "session", narratorId: row.narratorId });
	if (!session || !space) throw catalogError("SPEC_LOSS_NO_PAGE");
	// The page the import made for the file: the behavior page, or the one whose short id
	// follows from the file's current revision.
	let pageId: string | null = null;
	if (row.path === SPEC_LOSS_FENCE_PATH) pageId = (await findBehaviorPage(space.id))?.id ?? null;
	else if (session.namespaceId) {
		const pointer = (await readSpecFilePointers(session.namespaceId)).find(
			(p) => p.path === row.path,
		);
		if (pointer?.revisionId) {
			const sid =
				row.path === "index.md"
					? specIndexSid()
					: `sp${specFileTag(row.narratorId, row.path, pointer.revisionId)}`;
			const [page] = await outlineStore.getBlockMetas(space.id, { sids: [sid] });
			if (page && !page.deleted && page.parentId === null) pageId = page.id;
		}
	}
	if (pageId === null) throw catalogError("SPEC_LOSS_NO_PAGE");
	const headerSid = specLossBlockSid(row.id);
	// Written before and the decision not recorded (the process stopped in between): the block is
	// the one; a person who deleted it since decided what to do with it.
	const [written] = await outlineStore.getBlockMetas(space.id, { sids: [headerSid] });
	if (written) return written.id;
	const locale: Locale = await getUserLanguage(userId).catch(() => "en" as const);
	const text = TEXT[locale];
	const blocks = await convertParts(row.parts, locale);
	const flat: Array<{ tempId: string; parent: string; block: ReportBlock }> = [];
	flatten(blocks, "h", "c", flat);
	if (flat.length > ATTACH_MAX_BLOCKS + 15)
		throw new Error("spec loss attach: the excerpt converts to too many blocks");
	const ops: OutlineOp[] = [
		{
			op: "insert",
			tempId: "h",
			sid: headerSid,
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
			responsibleUserId: userId,
			narratorId: row.narratorId,
			summary: text.summary(row.path),
		},
		{ canonical },
	);
	const blockId = result.results[0]?.blockId;
	if (!blockId) throw catalogError("SPEC_LOSS_NO_PAGE");
	logger.info("Possibly lost Dynamic Spec content attached to its imported page", {
		narratorId: row.narratorId,
		findingId: row.id,
		path: row.path,
		userId,
		blocks: ops.length,
	});
	return blockId;
}

/**
 * A person's decision about one finding (of `narratorId`; any session's when null). Answers the
 * finding as it is afterwards. 409 when it was decided already, or cannot be attached.
 */
export async function decideSpecLossFinding(args: {
	id: string;
	narratorId: string | null;
	action: OutlineSpecLossAction;
	userId: string;
}): Promise<OutlineSpecLossFinding> {
	const row = await findingOf(args.id, args.narratorId, args.action === "attach");
	const from: OutlineSpecLossStatus = args.action === "reopen" ? "dismissed" : "open";
	if (row.status !== from) throw catalogError("SPEC_LOSS_DECIDED");
	let blockId: string | null = null;
	if (args.action === "attach") blockId = await attach(row, args.userId);
	const to: OutlineSpecLossStatus =
		args.action === "attach" ? "attached" : args.action === "dismiss" ? "dismissed" : "open";
	const changed = await setSpecLossFindingStatus({
		id: row.id,
		from,
		to,
		userId: args.userId,
		blockId,
	});
	// Someone else decided meanwhile: an attach wrote the same block (its short id is the
	// finding's), so nothing is doubled; the finding reads as they left it.
	if (!changed && args.action !== "attach") throw catalogError("SPEC_LOSS_DECIDED");
	const after = await readSpecLossFinding(row.id);
	if (!after) throw new NotFoundError("Finding", row.id);
	return publicFinding(after);
}
