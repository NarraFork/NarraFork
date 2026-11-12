/**
 * 数据可移植性 · Dynamic Spec 导入状态（outline P2 PR 12b2，`outline_spec_imports`）。
 *
 * 这张表不导出（它说的是本机 spec 行和本机大纲内容之间的关系，两边都不导出）：
 * - 导出的快照里没有它；
 * - 覆盖本地会话时删掉该会话的状态行，跳过时保留，新插入的会话本来就没有；
 * - 导入、清空之后缓存不再报旧状态；
 * - 清空会话一起清掉。
 * 独立临时 NARRAFORK_HOME，真实 SQLite。
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const previousHome = process.env.NARRAFORK_HOME;
const testHome = mkdtempSync(join(tmpdir(), "narrafork-portability-spec-import-"));
process.env.NARRAFORK_HOME = testHome;

const { sqlite } = await import("../../db");
const { SNAPSHOT_TABLES } = await import("../../db/snapshot-protocol");
const { applyImport, clearData, exportData, previewImport } = await import("../data-portability");
const { readSpecImportState, writeSpecImportState, resetSpecImportStateCache } = await import(
	"../outline/spec-import/state"
);
const { readTaskBackend, invalidateTaskBackend } = await import("../task-source/backend");
const { settings } = await import("../../lib/settings");

afterAll(() => {
	if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = previousHome;
	try {
		rmSync(testHome, { recursive: true, force: true });
	} catch {
		// Windows 句柄未释放：留给系统清理
	}
});

const toArrayBuffer = (buffer: Buffer): ArrayBuffer =>
	buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;

const stateRows = () =>
	Number(
		(sqlite.prepare(`SELECT COUNT(*) AS n FROM outline_spec_imports`).get() as { n: number }).n,
	);

function insertNarrator(id: string, backend: "spec" | "outline") {
	sqlite.run(
		`INSERT INTO narrators (id, type, title, task_backend, created_at, updated_at)
		VALUES (?, 'primary', ?, ?, ?, ?)`,
		[id, `会话 ${id}`, backend, "2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z"],
	);
}

async function exportZip(): Promise<ArrayBuffer> {
	return toArrayBuffer(await readFile((await exportData()).zipPath));
}

beforeEach(() => {
	sqlite.run("DELETE FROM outline_spec_imports");
	sqlite.run("DELETE FROM narrator_message_refs");
	sqlite.run("DELETE FROM narrator_messages");
	sqlite.run("DELETE FROM narrators");
	resetSpecImportStateCache();
	invalidateTaskBackend();
	settings.outline.enabled = true;
});

describe("data portability · Dynamic Spec 导入状态", () => {
	test("不在快照里：导出包的数据库没有这张表", async () => {
		expect(Object.values(SNAPSHOT_TABLES).flat()).not.toContain("outline_spec_imports");
		insertNarrator("n-export", "outline");
		await writeSpecImportState("n-export", { status: "imported", switchCount: 1 });
		const zip = await readFile((await exportData()).zipPath);
		const preview = await previewImport(toArrayBuffer(zip), "export.zip");
		const snap = new Database(preview.snapshotPath, { readonly: true });
		const tables = snap
			.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
			.all() as Array<{ name: string }>;
		snap.close();
		expect(tables.map((t) => t.name)).toContain("narrators");
		expect(tables.map((t) => t.name)).not.toContain("outline_spec_imports");
	});

	test("覆盖会话：删掉它的状态行（task_backend 随会话行替换），缓存也不再报旧状态", async () => {
		insertNarrator("n-over", "spec");
		const zip = await exportZip();
		// Locally the session was imported and later moved back.
		sqlite.run(`UPDATE narrators SET task_backend = 'outline' WHERE id = 'n-over'`);
		await writeSpecImportState("n-over", { status: "reverted", switchCount: 1, revertCount: 1 });
		expect(await readTaskBackend("n-over")).toBe("outline");
		const preview = await previewImport(zip, "export.zip");
		const result = await applyImport(preview.token, { conflictDefault: "overwrite" });
		expect(result.sessionsOverwritten).toBe(1);
		expect(stateRows()).toBe(0);
		expect(await readSpecImportState("n-over")).toBeNull();
		// The incoming row brought `spec`; the backend cache was dropped with it.
		expect(await readTaskBackend("n-over")).toBe("spec");
	});

	test("跳过会话：本地状态行保留", async () => {
		insertNarrator("n-skip", "outline");
		const zip = await exportZip();
		await writeSpecImportState("n-skip", { status: "imported", switchCount: 1 });
		const preview = await previewImport(zip, "export.zip");
		const result = await applyImport(preview.token, { conflictDefault: "skip" });
		expect(result.sessionsSkipped).toBe(1);
		expect(stateRows()).toBe(1);
		expect((await readSpecImportState("n-skip"))?.status).toBe("imported");
	});

	test("新插入的会话没有状态行（由下一次尝试重新得出）", async () => {
		insertNarrator("n-new", "outline");
		await writeSpecImportState("n-new", { status: "imported", switchCount: 1 });
		const zip = await exportZip();
		sqlite.run("DELETE FROM narrators");
		expect(stateRows()).toBe(0); // the narrator FK cascades
		const preview = await previewImport(zip, "export.zip");
		const result = await applyImport(preview.token, { conflictDefault: "overwrite" });
		expect(result.sessionsInserted).toBe(1);
		expect(stateRows()).toBe(0);
		expect(await readSpecImportState("n-new")).toBeNull();
	});

	test("清空会话：状态行一起清掉，缓存不再报旧状态", async () => {
		insertNarrator("n-clear", "outline");
		await writeSpecImportState("n-clear", { status: "attention", attempts: 2 });
		expect((await readSpecImportState("n-clear"))?.status).toBe("attention");
		const cleared = await clearData("sessions");
		expect(cleared.deleted.sessions).toBe(1);
		expect(stateRows()).toBe(0);
		expect(await readSpecImportState("n-clear")).toBeNull();
	});

	test("只清请求：状态行不动", async () => {
		insertNarrator("n-keep", "outline");
		await writeSpecImportState("n-keep", { status: "imported", switchCount: 1 });
		await clearData("requests");
		expect(stateRows()).toBe(1);
	});
});
