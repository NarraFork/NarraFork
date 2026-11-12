/**
 * What a session the import moved is told (outline P2 PR 12b2): one `sys` history row at the
 * start of its next run, exactly once per switch, also across restarts; a `spec://` tool call
 * answered with where its old files went; Dynamic Spec writes refused with the "moved" wording
 * (the same code as for any outline session).
 *
 * ISOLATION: the isolated database from `tests/preload.ts`; every case makes its own sessions.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { readTestMessageContent } from "../../../../../tests/setup";
import { db, sqlite } from "../../../../db";
import { narratorMessageRefs, narratorMessages } from "../../../../db/schema";
import type { AgentToolUse } from "../../../../lib/agent";
import { getOutlineSpecRejection } from "../../../../lib/agent/tool-executor";
import { AppError } from "../../../../lib/errors";
import { settings } from "../../../../lib/settings";
import { prepareOutlineRun } from "../../../narrator-session";
import type { ActiveNarrator } from "../../../narrator-session-state";
import { writeSpecFile } from "../../../spec-vfs-service";
import { invalidateTaskBackend } from "../../../task-source";
import { resetOutlineBehaviorImport } from "../../../task-source/outline-behavior";
import { resetOutlineFenceSopMove } from "../../../task-source/outline-plugin-rules";
import { stopEditTextWorker } from "../../edit-text-runner";
import { importSpecSession, resetSpecImportRecords } from "../importer";
import { deliverSpecImportNotice, SPEC_IMPORT_NOTICE_SOURCE, specImportNoticeId } from "../notice";
import { isSpecImportedSession, writeSpecImportState } from "../state";
import { resetSpecImportRunTries } from "../triggers";
import { backendOf, makeSession, makeUser, writeNote, writeTasks } from "./fixtures";

beforeEach(() => {
	settings.outline.enabled = true;
	settings.outline.specImport = "auto";
	invalidateTaskBackend();
	resetSpecImportRecords();
	resetSpecImportRunTries();
	resetOutlineBehaviorImport();
	resetOutlineFenceSopMove();
});
afterAll(() => stopEditTextWorker());

const active = (id: string) => ({ narratorId: id, locale: "en" }) as unknown as ActiveNarrator;

/** The notice rows of a session's history. */
async function notices(narratorId: string) {
	const rows = await db
		.select({ id: narratorMessages.id, role: narratorMessages.role })
		.from(narratorMessageRefs)
		.innerJoin(narratorMessages, eq(narratorMessages.id, narratorMessageRefs.messageId))
		.where(eq(narratorMessageRefs.narratorId, narratorId));
	return rows.flatMap((row) =>
		readTestMessageContent(sqlite, row.id)
			.filter((b) => b.type === "system_injection" && b.source === SPEC_IMPORT_NOTICE_SOURCE)
			.map((b) => ({ id: row.id, role: row.role, text: String(b.modelText) })),
	);
}

describe("the notice", () => {
	test("the run that imported the session reads one row saying where everything went", async () => {
		const { id } = await makeSession();
		await writeTasks(id, [{ text: "first" }, { text: "second", status: "doing" }]);
		await writeNote(id, "design.md", "# Design\n\nthe plan\n");
		await prepareOutlineRun(active(id));
		expect(await backendOf(id)).toBe("outline");
		const rows = await notices(id);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.id).toBe(specImportNoticeId(id, 1));
		expect(rows[0]?.role).toBe("sys");
		const text = rows[0]?.text ?? "";
		expect(text).toStartWith("System notice (not the user speaking)");
		expect(text).toContain("session/tasks (2 imported)");
		expect(text).toContain("session/behavior");
		expect(text).toMatch(/- spec:\/\/design\.md → session\/sp[0-9a-f]+/);
		expect(text).toContain("spec:// no longer applies");
		expect(text).toContain("OutlineEdit");
		// The next run: nothing more.
		await prepareOutlineRun(active(id));
		expect(await notices(id)).toHaveLength(1);
	});

	test("whichever trigger moved it, the next run is told; in the owner's language", async () => {
		const owner = await makeUser("zh-CN");
		const { id } = await makeSession({ owner });
		await writeTasks(id, [{ text: "任务" }]);
		settings.outline.specImport = "manual";
		expect((await importSpecSession(id, { trigger: "manual" })).status).toBe("imported");
		expect(await notices(id)).toHaveLength(0);
		await prepareOutlineRun(active(id));
		const rows = await notices(id);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.text).toStartWith("系统通知（不是用户发言）");
		expect(rows[0]?.text).toContain("session/tasks（导入了 1 个）");
	});

	test("exactly once across a restart, also when the process stopped after writing the row", async () => {
		const { id } = await makeSession();
		await writeTasks(id, [{ text: "a" }]);
		await importSpecSession(id, { trigger: "sweep" });
		expect(await deliverSpecImportNotice(id)).toBe("delivered");
		// The row is written, the bookkeeping lost (the process stopped in between).
		await writeSpecImportState(id, { noticeSwitch: 0 });
		resetSpecImportRecords();
		expect(await deliverSpecImportNotice(id)).toBe("already");
		expect(await deliverSpecImportNotice(id)).toBe("none");
		expect(await notices(id)).toHaveLength(1);
	});

	test("a session that never used Dynamic Spec, and a session created in the outline, are told nothing", async () => {
		const empty = await makeSession();
		await importSpecSession(empty.id, { trigger: "sweep" });
		expect(await backendOf(empty.id)).toBe("outline");
		await prepareOutlineRun(active(empty.id));
		expect(await notices(empty.id)).toHaveLength(0);
		const native = await makeSession({ backend: "outline" });
		await prepareOutlineRun(active(native.id));
		expect(await notices(native.id)).toHaveLength(0);
		expect(await isSpecImportedSession(native.id)).toBe(false);
	});
});

describe("spec tools and writes of a moved session", () => {
	const read: AgentToolUse = {
		type: "tool_use",
		id: "t1",
		name: "Read",
		input: { file_path: "spec://tasks.json" },
	} as AgentToolUse;

	test("a spec:// call is told where the old files went", () => {
		const moved = getOutlineSpecRejection(read, {
			taskBackend: "outline",
			locale: "en",
			specImported: true,
		});
		expect(moved?.isError).toBe(true);
		expect(moved?.output).toContain("was moved into the outline");
		expect(moved?.output).toContain("session/tasks");
		expect(moved?.output).toContain("session/behavior");
		expect(
			getOutlineSpecRejection(read, { taskBackend: "outline", locale: "zh-CN", specImported: true })
				?.output,
		).toContain("已搬进大纲");
		// A session created in the outline keeps the general hint.
		expect(
			getOutlineSpecRejection(read, { taskBackend: "outline", locale: "en" })?.output,
		).toContain("spec:// is not available in this session");
		expect(getOutlineSpecRejection(read, { taskBackend: "spec", specImported: true })).toBe(
			undefined,
		);
	});

	test("a write from the Spec panel is refused as moved; a session created in the outline as before", async () => {
		const { id } = await makeSession();
		await writeTasks(id, [{ text: "a" }]);
		await importSpecSession(id, { trigger: "sweep" });
		const write = (narratorId: string) =>
			writeSpecFile(narratorId, "spec://notes.md", "x", { actor: "user", createdBy: "user" });
		const refused = await write(id).catch((error: unknown) => error);
		expect(refused).toBeInstanceOf(AppError);
		expect((refused as AppError).statusCode).toBe(409);
		expect((refused as AppError).code).toBe("SPEC_OUTLINE_SESSION");
		expect((refused as AppError).messageCode).toBe("SPEC_MOVED_TO_OUTLINE");
		const native = await makeSession({ backend: "outline" });
		const before = await write(native.id).catch((error: unknown) => error);
		expect((before as AppError).code).toBe("SPEC_OUTLINE_SESSION");
		expect((before as AppError).messageCode).toBe("SPEC_IN_OUTLINE_SESSION");
	});
});
