/**
 * The model's notice after the import moved a session into the outline (outline P2 PR 12b2;
 * `docs/INJECTION.md`, source `spec_import`): one `sys` history row telling the session where its
 * tasks, notes and behavior boundary are now and that `spec://` no longer applies, written at the
 * start of the session's next run (`prepareOutlineRun`, before its first request reads history),
 * whichever trigger moved it. Never in the system prompt.
 *
 * Exactly once per switch: the state row counts switches (`switch_count`) and the one told
 * (`notice_switch`); the row's id is derived from (session, switch), and a row already under it
 * (the process stopped between writing it and recording that) is not written again. A session
 * moved back to Dynamic Spec and forward again is a new switch, told again. A switch that wrote
 * nothing (the session never used Dynamic Spec) is recorded as told.
 *
 * Bounded: one primary-key read of the state (cached), one of the row, one page read of the
 * session space's pages (at most {@link SPEC_IMPORT_NOTICE_LIMITS.pageRead}); the text lists at
 * most {@link SPEC_IMPORT_NOTICE_LIMITS.pages} pages. Written on SQLite only, where the session
 * runtime runs.
 */
import { createHash } from "node:crypto";
import { getUserLanguage } from "@server/lib/i18n";
import { logger } from "@server/lib/logger";
import { getSpecImportNotice, type Locale } from "@server/lib/prompt-i18n";
import { specIndexSid } from "../../plugin-spec-compat";
import { outlineAccessBackend, readNarrator } from "../access-reads";
import { OUTLINE_BEHAVIOR_ALIAS, OUTLINE_TASKS_PAGE_ALIAS } from "../model";
import { outlineStore } from "../store";
import { isImportSid } from "./plan";
import { readSpecImportState, writeSpecImportState } from "./state";

export const SPEC_IMPORT_NOTICE_LIMITS = {
	/** Pages of the session space read to name the imported ones. */
	pageRead: 60,
	/** Pages the text names; the rest are counted. */
	pages: 20,
	/** Characters of a page title in the text. */
	titleChars: 120,
} as const;

/** The injection source of the notice. */
export const SPEC_IMPORT_NOTICE_SOURCE = "spec_import";

/** The id of the notice of a session's `switchCount`-th switch. */
export function specImportNoticeId(narratorId: string, switchCount: number): string {
	return createHash("sha256")
		.update(["spec-import-notice", narratorId, String(switchCount)].join("\u0000"))
		.digest("base64url")
		.slice(0, 21);
}

/**
 * Write the notice for the session's last switch when its history does not hold it yet (see the
 * module header). Never rejects: `delivered`, `already` (the row was there), or `none`.
 */
export async function deliverSpecImportNotice(
	narratorId: string,
): Promise<"delivered" | "already" | "none"> {
	try {
		const state = await readSpecImportState(narratorId);
		if (
			!state ||
			state.status === "reverted" ||
			state.switchCount === 0 ||
			state.noticeSwitch >= state.switchCount
		)
			return "none";
		if (outlineAccessBackend() !== "sqlite") return "none";
		const switchCount = state.switchCount;
		const messageId = specImportNoticeId(narratorId, switchCount);
		const [{ db }, { narratorMessages }, { and, eq }] = await Promise.all([
			import("@server/db"),
			import("@server/db/schema"),
			import("drizzle-orm"),
		]);
		const existing = db
			.select({ id: narratorMessages.id })
			.from(narratorMessages)
			.where(and(eq(narratorMessages.id, messageId), eq(narratorMessages.narratorId, narratorId)))
			.limit(1)
			.get();
		if (existing) {
			await recordTold(narratorId, switchCount);
			return "already";
		}
		const owner = (await readNarrator(narratorId))?.ownerUserId ?? null;
		const locale: Locale = owner ? await getUserLanguage(owner).catch(() => "en" as const) : "en";
		const content = getSpecImportNotice(
			{ tasks: state.tasks ?? 0, ...(await importedPages(narratorId)) },
			locale,
		);
		const { deliverInjection } = await import("../../narrator-injection");
		await deliverInjection(narratorId, {
			messageId,
			content,
			source: SPEC_IMPORT_NOTICE_SOURCE,
			body: { kind: "prose", text: content },
			// A plain row: this run's first request reads it from history.
			schedule: "none",
			locale,
		});
		await recordTold(narratorId, switchCount);
		return "delivered";
	} catch (error) {
		logger.warn("Could not tell an imported session where its Dynamic Spec went", {
			narratorId,
			error: String(error),
		});
		return "none";
	}
}

async function recordTold(narratorId: string, switchCount: number): Promise<void> {
	await writeSpecImportState(narratorId, (current) => ({
		noticeSwitch: Math.max(current?.noticeSwitch ?? 0, switchCount),
	}));
}

/** The pages of the session space an import wrote (by their short ids), in page order. */
async function importedPages(
	narratorId: string,
): Promise<{ pages: Array<{ title: string; address: string }>; morePages: number }> {
	const space = await outlineStore.findSpace({ kind: "session", narratorId });
	if (!space) return { pages: [], morePages: 0 };
	const rows = await outlineStore.listChildren(space.id, null, SPEC_IMPORT_NOTICE_LIMITS.pageRead);
	const indexSid = specIndexSid();
	const imported = rows.filter(
		(row) =>
			!row.deleted &&
			row.alias !== OUTLINE_TASKS_PAGE_ALIAS &&
			row.alias !== OUTLINE_BEHAVIOR_ALIAS &&
			(isImportSid(row.sid) || row.sid === indexSid),
	);
	return {
		pages: imported.slice(0, SPEC_IMPORT_NOTICE_LIMITS.pages).map((row) => ({
			title: (row.content.split("\n", 1)[0] ?? "").slice(0, SPEC_IMPORT_NOTICE_LIMITS.titleChars),
			address: `session/${row.sid}`,
		})),
		morePages: Math.max(0, imported.length - SPEC_IMPORT_NOTICE_LIMITS.pages),
	};
}
