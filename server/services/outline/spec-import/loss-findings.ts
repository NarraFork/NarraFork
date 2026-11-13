/**
 * What people see and do about content the old Spec panel may have swallowed (outline P2 PR 12c;
 * owner decision D52: attached on the page only). The scan (`loss-scan.ts`) records findings and
 * attaches them to their imported pages (`loss-attach.ts`); here they are listed (an
 * administrator: every session's; a session's reader: that session's), read one at a time with
 * the lost text, and decided, one at a time, by a person:
 *
 *   - DISMISS (an open or attached finding): a save that removed the content on purpose reads as
 *     a loss too; dismissing says so. Its block on the page is taken away when only the attach
 *     ever wrote it; a block someone edited or added to is kept, and the finding is dismissed
 *     all the same.
 *   - REOPEN (a dismissed finding): open again, and attached again at once when it can be.
 *   - ATTACH (an open finding): what the automatic attach left out (the page was gone, a cap, a
 *     failure), asked for by a person; refused with the reason when it cannot be.
 *
 * A decision is a conditional update of the finding's status, so two people deciding at once do
 * not both win. Nothing of a page's own content is changed by any of them.
 */
import { AppError, catalogError, NotFoundError } from "@server/lib/errors";
import { logger } from "@server/lib/logger";
import type {
	OutlineSpecLossAction,
	OutlineSpecLossDetail,
	OutlineSpecLossFinding,
	OutlineSpecLossPage,
	OutlineSpecLossStatus,
} from "@shared/outline-spec-import";
import { attachSpecLossFinding, removeSpecLossBlock } from "./loss-attach";
import { specLossScanStatus } from "./loss-scan";
import {
	countSpecLossFindings,
	listSpecLossFindings,
	readSpecLossFinding,
	SPEC_LOSS_STORE_LIMITS,
	type SpecLossCursor,
	type SpecLossFindingRow,
	setSpecLossAttachNote,
	setSpecLossFindingStatus,
} from "./loss-store";
import { readSpecImportSession } from "./read-port";

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
		attachNote: row.attachNote,
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

/**
 * A person's decision about one finding (of `narratorId`; any session's when null). Answers the
 * finding as it is afterwards. 409 when it is not in a state the action applies to (someone else
 * decided), or cannot be attached.
 */
export async function decideSpecLossFinding(args: {
	id: string;
	narratorId: string | null;
	action: OutlineSpecLossAction;
	userId: string;
}): Promise<OutlineSpecLossFinding> {
	const { action, userId } = args;
	const row = await findingOf(args.id, args.narratorId, action !== "dismiss");
	const after = async () => {
		const read = await readSpecLossFinding(row.id);
		if (!read) throw new NotFoundError("Finding", row.id);
		return publicFinding(read);
	};
	if (action === "dismiss") {
		if (row.status === "dismissed") throw catalogError("SPEC_LOSS_DECIDED");
		const block = await removeSpecLossBlock(row, userId);
		const changed = await setSpecLossFindingStatus({
			id: row.id,
			from: ["open", "attached"],
			to: "dismissed",
			userId,
			// A block that was kept stays linked from the finding.
			blockId: block === "kept" ? row.blockId : null,
		});
		if (!changed) throw catalogError("SPEC_LOSS_DECIDED");
		return await after();
	}
	const session = await readSpecImportSession(row.narratorId);
	if (!session) throw new NotFoundError("Narrator", row.narratorId);
	if (action === "reopen") {
		if (row.status !== "dismissed") throw catalogError("SPEC_LOSS_DECIDED");
		const changed = await setSpecLossFindingStatus({
			id: row.id,
			from: ["dismissed"],
			to: "open",
			userId,
			blockId: null,
		});
		if (!changed) throw catalogError("SPEC_LOSS_DECIDED");
		// Attached again at once when it can be; otherwise it is open and says why.
		try {
			const blockId = await attachSpecLossFinding(session, row, userId);
			await setSpecLossFindingStatus({
				id: row.id,
				from: ["open"],
				to: "attached",
				userId,
				blockId,
			});
		} catch (error) {
			if (error instanceof AppError && error.messageCode === "SPEC_LOSS_NO_PAGE")
				await setSpecLossAttachNote(row.id, "no_page");
			else if (!(error instanceof AppError && error.messageCode === "SPEC_LOSS_NOT_IMPORTED")) {
				await setSpecLossAttachNote(row.id, "failed");
				logger.warn("Could not attach a reopened finding", {
					findingId: row.id,
					error: String(error),
				});
			}
		}
		return await after();
	}
	if (row.status !== "open") throw catalogError("SPEC_LOSS_DECIDED");
	const blockId = await attachSpecLossFinding(session, row, userId);
	// A pass attached it meanwhile: the same block (its short id is the finding's), nothing doubled.
	await setSpecLossFindingStatus({ id: row.id, from: ["open"], to: "attached", userId, blockId });
	return await after();
}
