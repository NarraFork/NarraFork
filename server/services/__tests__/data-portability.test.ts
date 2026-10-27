/**
 * 数据可移植性：全链路 + 数据安全边界。
 *
 * 关键原则：任何失败路径都不得破坏主库——导出/预览只读，导入在单事务内可回滚，
 * 清空按类别隔离。每个用例都在独立临时 NARRAFORK_HOME 上真实跑 SQLite。
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const previousHome = process.env.NARRAFORK_HOME;
const testHome = mkdtempSync(join(tmpdir(), "narrafork-portability-"));
process.env.NARRAFORK_HOME = testHome;

const { sqlite } = await import("../../db");
const { saveSettings, settings } = await import("../../lib/settings");
const { applyImport, clearData, exportData, previewImport } = await import("../data-portability");

afterAll(() => {
	if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = previousHome;
	try {
		rmSync(testHome, { recursive: true, force: true });
	} catch {
		// Windows 上句柄未释放时删除会 EBUSY，留给系统清理
	}
});

const count = (table: string) =>
	Number((sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);

async function seed(rows = 2) {
	sqlite.run("DELETE FROM api_requests");
	sqlite.run("DELETE FROM narrator_message_refs");
	sqlite.run("DELETE FROM narrator_tool_calls");
	sqlite.run("DELETE FROM narrator_messages");
	sqlite.run("DELETE FROM narrators");

	for (let i = 1; i <= rows; i += 1) {
		sqlite.run(
			`INSERT INTO api_requests (id, created_at, input_tokens, output_tokens, cached_input_tokens)
			 VALUES (?, ?, ?, ?, ?)`,
			[`req-${i}`, `2026-10-0${(i % 9) + 1}T00:00:00Z`, 10 * i, 5, 3],
		);
	}
	sqlite.run(
		`INSERT INTO narrators (id, type, created_at, updated_at) VALUES (?, 'primary', ?, ?)`,
		["sess-1", "2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z"],
	);
	sqlite.run(
		`INSERT INTO narrator_messages (id, narrator_id, role, content_json, created_at) VALUES (?, ?, 'user', '[]', ?)`,
		["msg-1", "sess-1", "2026-10-01T00:00:01Z"],
	);
	sqlite.run(
		`INSERT INTO narrator_messages (id, narrator_id, role, content_json, created_at) VALUES (?, ?, 'assistant', '[]', ?)`,
		["msg-2", "sess-1", "2026-10-01T00:00:02Z"],
	);
	sqlite.run(
		`INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq) VALUES (?, ?, ?, ?)`,
		["ref-1", "sess-1", "msg-1", 1],
	);
	sqlite.run(
		`INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq) VALUES (?, ?, ?, ?)`,
		["ref-2", "sess-1", "msg-2", 2],
	);
	sqlite.run(
		`INSERT INTO narrator_tool_calls (id, narrator_id, message_id, tool_use_id, tool_name, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		["tc-1", "sess-1", "msg-2", "tu-1", "Read", "2026-10-01T00:00:03Z"],
	);

	const next = structuredClone(settings);
	next.codex = undefined;
	next.tokendance = undefined;
	next.commandCode = undefined;
	next.nugProviders = [];
	next.customApiProviders = [
		{
			id: "prov-1",
			name: "Existing",
			prefix: "existing",
			protocol: "completions-compatible",
			baseUrl: "https://existing.example/v1",
			apiKey: "dk-test",
			defaultModel: "",
		},
	];
	saveSettings(next);
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
	return buffer.buffer.slice(
		buffer.byteOffset,
		buffer.byteOffset + buffer.byteLength,
	) as ArrayBuffer;
}

const snapshotCounts = () => ({
	requests: count("api_requests"),
	sessions: count("narrators"),
	messages: count("narrator_messages"),
	refs: count("narrator_message_refs"),
	toolCalls: count("narrator_tool_calls"),
});

beforeEach(async () => {
	await seed();
});

describe("data portability · 全链路", () => {
	test("导出 → 预览 → 导入（跳过与覆盖）→ 清空", async () => {
		const exported = await exportData();
		expect(exported.counts).toEqual({ requests: 2, sessions: 1, providers: 1 });
		const zip = await readFile(exported.zipPath);
		expect(zip.byteLength).toBeGreaterThan(0);

		const preview = await previewImport(toArrayBuffer(zip), "narrafork-export.zip");
		expect(preview.counts).toEqual({ requests: 2, sessions: 1, providers: 1 });
		expect(preview.conflicts).toHaveLength(1);
		expect(preview.conflicts[0]?.id).toBe("sess-1");

		const skipped = await applyImport(preview.token, { conflictDefault: "skip" });
		expect(skipped.requestsInserted).toBe(0);
		expect(skipped.sessionsSkipped).toBe(1);
		expect(count("api_requests")).toBe(2);

		// 覆盖：本地改动被导入值替换
		sqlite.run(`UPDATE narrators SET title = '本地修改' WHERE id = 'sess-1'`);
		const preview2 = await previewImport(toArrayBuffer(zip), "narrafork-export.zip");
		const overwritten = await applyImport(preview2.token, {
			conflictById: { "sess-1": "overwrite" },
		});
		expect(overwritten.sessionsOverwritten).toBe(1);
		const restored = sqlite.prepare(`SELECT title FROM narrators WHERE id = 'sess-1'`).get() as {
			title: string | null;
		};
		expect(restored.title).toBeNull();
		expect(count("narrator_message_refs")).toBe(2);

		const cleared = await clearData("all");
		expect(cleared.deleted.requests).toBe(2);
		expect(cleared.deleted.sessions).toBe(1);
		expect(count("api_requests")).toBe(0);
		expect(count("narrators")).toBe(0);
		expect(count("narrator_messages")).toBe(0);
		expect(settings.customApiProviders ?? []).toEqual([]);
	});

	/**
	 * 真实库的形态：请求挂会话与消息，会话的 `context_project_id` 指向 projects。
	 *
	 * projects 不在导出包内，目标库缺少该行时必须置 NULL；请求引用的会话与消息必须先
	 * 就位——两者任一处理错，导入都会以 `FOREIGN KEY constraint failed` 整批回滚。
	 */
	test("请求挂会话/消息、会话引用未导出表时导入不撞外键", async () => {
		sqlite.run(
			`INSERT INTO projects (id, name, created_at, updated_at)
			 VALUES ('proj-1', '本地项目', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')`,
		);
		sqlite.run(`UPDATE narrators SET context_project_id = 'proj-1' WHERE id = 'sess-1'`);
		sqlite.run(
			`UPDATE api_requests SET narrator_id = 'sess-1', message_id = 'msg-2' WHERE id = 'req-1'`,
		);

		const zip = await readFile((await exportData()).zipPath);
		await clearData("all");
		sqlite.run("DELETE FROM projects");

		const preview = await previewImport(toArrayBuffer(zip), "narrafork-export.zip");
		const result = await applyImport(preview.token, { conflictDefault: "skip" });
		expect(result.sessionsInserted).toBe(1);
		expect(result.requestsInserted).toBe(2);

		const request = sqlite
			.prepare(`SELECT narrator_id, message_id FROM api_requests WHERE id = 'req-1'`)
			.get() as { narrator_id: string | null; message_id: string | null };
		expect(request.narrator_id).toBe("sess-1");
		expect(request.message_id).toBe("msg-2");
		const session = sqlite
			.prepare(`SELECT context_project_id FROM narrators WHERE id = 'sess-1'`)
			.get() as { context_project_id: string | null };
		expect(session.context_project_id).toBeNull();
	});

	test("按类别导出：只带会话时请求与供应商都为空", async () => {
		const exported = await exportData({ requests: false, sessions: true, providers: false });
		expect(exported.counts).toEqual({ requests: 0, sessions: 1, providers: 0 });

		const zip = await readFile(exported.zipPath);
		const preview = await previewImport(toArrayBuffer(zip), "export.zip");
		expect(preview.counts).toEqual({ requests: 0, sessions: 1, providers: 0 });
		expect(preview.conflicts).toHaveLength(1);
	});

	test("按类别导入：只导入请求时不落会话，且会话引用被置空", async () => {
		sqlite.run(
			`UPDATE api_requests SET narrator_id = 'sess-1', message_id = 'msg-1' WHERE id = 'req-1'`,
		);
		const zip = await readFile((await exportData()).zipPath);
		await clearData("all");

		const preview = await previewImport(toArrayBuffer(zip), "export.zip");
		const result = await applyImport(preview.token, {
			conflictDefault: "skip",
			include: { requests: true, sessions: false, providers: false },
		});
		expect(result.requestsInserted).toBe(2);
		expect(result.sessionsInserted).toBe(0);
		expect(count("narrators")).toBe(0);
		expect(settings.customApiProviders ?? []).toEqual([]);

		const request = sqlite
			.prepare(`SELECT narrator_id, message_id FROM api_requests WHERE id = 'req-1'`)
			.get() as { narrator_id: string | null; message_id: string | null };
		expect(request.narrator_id).toBeNull();
		expect(request.message_id).toBeNull();
	});
});

describe("data portability · 数据安全", () => {
	test("导出只读：主库数据与行数完全不变", async () => {
		const before = snapshotCounts();
		const zip = await readFile((await exportData()).zipPath);
		expect(snapshotCounts()).toEqual(before);
		expect(zip.byteLength).toBeGreaterThan(0);
	});

	test("预览只读：不修改主库", async () => {
		const zip = await readFile((await exportData()).zipPath);
		const before = snapshotCounts();
		await previewImport(toArrayBuffer(zip), "export.zip");
		expect(snapshotCounts()).toEqual(before);
	});

	test("无效 ZIP / 缺 snapshot.db：拒绝且主库不变", async () => {
		const before = snapshotCounts();
		await expect(
			previewImport(toArrayBuffer(Buffer.from("not a zip at all")), "x.zip"),
		).rejects.toThrow();
		expect(snapshotCounts()).toEqual(before);

		// 构造一个只有 manifest.json 的 ZIP（缺 snapshot.db）
		const archiver = (await import("archiver")).default;
		const { createWriteStream } = await import("node:fs");
		const dir = mkdtempSync(join(tmpdir(), "narrafork-badzip-"));
		const badZip = join(dir, "bad.zip");
		await new Promise<void>((resolve, reject) => {
			const output = createWriteStream(badZip);
			const archive = archiver("zip");
			output.on("close", () => resolve());
			archive.on("error", reject);
			archive.pipe(output);
			archive.append(JSON.stringify({ version: 1 }), { name: "manifest.json" });
			void archive.finalize();
		});
		try {
			const buffer = await readFile(badZip);
			await expect(previewImport(toArrayBuffer(buffer), "bad.zip")).rejects.toThrow();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
		expect(snapshotCounts()).toEqual(before);
	});

	test("重复导入幂等：数据行数不变、事务不重复插入", async () => {
		const zip = await readFile((await exportData()).zipPath);
		const first = await previewImport(toArrayBuffer(zip), "export.zip");
		await applyImport(first.token, { conflictDefault: "skip" });
		const afterFirst = snapshotCounts();

		const second = await previewImport(toArrayBuffer(zip), "export.zip");
		const result = await applyImport(second.token, { conflictDefault: "skip" });
		expect(result.requestsInserted).toBe(0);
		expect(result.sessionsInserted).toBe(0);
		expect(snapshotCounts()).toEqual(afterFirst);
	});

	test("清空单类别不影响其它类别", async () => {
		await clearData("requests");
		expect(count("api_requests")).toBe(0);
		expect(count("narrators")).toBe(1);
		expect(count("narrator_messages")).toBe(2);
		expect((settings.customApiProviders ?? []).length).toBe(1);

		await seed();
		await clearData("sessions");
		expect(count("narrators")).toBe(0);
		expect(count("api_requests")).toBe(2);
		expect((settings.customApiProviders ?? []).length).toBe(1);

		await seed();
		await clearData("providers");
		expect(settings.customApiProviders ?? []).toEqual([]);
		expect(count("api_requests")).toBe(2);
		expect(count("narrators")).toBe(1);
	});

	test("大数据量：5000 条请求导出/预览/导入在数秒内完成且数据一致", async () => {
		await seed(0);
		const insert = sqlite.prepare(
			`INSERT INTO api_requests (id, created_at, input_tokens, output_tokens) VALUES (?, ?, ?, ?)`,
		);
		sqlite.transaction(() => {
			for (let i = 0; i < 5000; i += 1) {
				insert.run(`bulk-${i}`, "2026-10-05T00:00:00Z", i, 1);
			}
		})();
		expect(count("api_requests")).toBe(5000);

		const started = Date.now();
		const zip = await readFile((await exportData()).zipPath);
		const preview = await previewImport(toArrayBuffer(zip), "export.zip");
		expect(preview.counts.requests).toBe(5000);
		await applyImport(preview.token, { conflictDefault: "skip" });
		const elapsed = Date.now() - started;
		// 性能护栏：5000 行全链路应远快于「逐行 JSON」方案
		expect(elapsed).toBeLessThan(10_000);
		expect(count("api_requests")).toBe(5000);
	});
});
