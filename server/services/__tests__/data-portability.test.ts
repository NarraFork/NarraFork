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
const { SNAPSHOT_TABLES } = await import("../../db/snapshot-protocol");
const { saveSettings, settings } = await import("../../lib/settings");
const { getModelOverride, replaceModelOverridesForTests, setModelCatalogAutoUpdate } = await import(
	"../../lib/model-catalog"
);
const {
	applyImport,
	clearData,
	consumeExportTicket,
	createExportTicket,
	exportData,
	previewImport,
} = await import("../data-portability");

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
	sqlite.run("DELETE FROM usage_daily");
	sqlite.run("DELETE FROM narrator_message_refs");
	sqlite.run("DELETE FROM narrator_tool_calls");
	sqlite.run("DELETE FROM narrator_messages");
	sqlite.run("DELETE FROM narrators");
	sqlite.run("DELETE FROM folder_git_identity_bindings");
	sqlite.run("DELETE FROM user_git_identities");
	sqlite.run("DELETE FROM user_recent_tabs");
	sqlite.run("DELETE FROM users");

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
	// 平台实例也计入供应商数量；默认清空，个别用例自己再写入。
	(next.agent as unknown as Record<string, unknown>).platformInstances = [];
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
	test("会话导入覆盖与清空只使本地 workspace 候选失效，不改已有名字", async () => {
		sqlite.run(
			"INSERT INTO users (id, username, password_hash, created_at) VALUES ('workspace-owner', 'workspace-owner', 'x', '2026-10-01T00:00:00Z')",
		);
		// Omit new columns, as an old importer would. The conservative defaults preserve names.
		sqlite.run(
			"INSERT INTO workspaces (id, user_id, title, tree, created_at, updated_at) VALUES ('local-workspace', 'workspace-owner', 'Keep my name', '{}', 0, 0)",
		);
		sqlite.run(
			"INSERT INTO workspace_panels (id, workspace_id, kind, narrator_id, sort_order, created_at, updated_at) VALUES ('local-panel', 'local-workspace', 'narrator', 'sess-1', 0, 0, 0)",
		);
		const titleState = () =>
			sqlite
				.query(
					"SELECT title, title_source, title_revision FROM workspaces WHERE id = 'local-workspace'",
				)
				.get();
		expect(titleState()).toEqual({
			title: "Keep my name",
			title_source: "manual",
			title_revision: 0,
		});
		expect(SNAPSHOT_TABLES.sessions as readonly string[]).not.toContain("workspaces");
		const zip = await readFile((await exportData()).zipPath);
		const preview = await previewImport(toArrayBuffer(zip), "workspace-compatible.zip");
		await applyImport(preview.token, { conflictDefault: "overwrite" });
		expect(titleState()).toEqual({
			title: "Keep my name",
			title_source: "manual",
			title_revision: 1,
		});
		await clearData("sessions");
		expect(titleState()).toEqual({
			title: "Keep my name",
			title_source: "manual",
			title_revision: 2,
		});
		expect(count("workspace_panels")).toBe(0);
	});
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

	test("归档位置标记随会话导出与恢复，并保持用户隔离", async () => {
		for (const userId of ["archive-user-a", "archive-user-b"]) {
			sqlite.run(
				`INSERT INTO users (id, username, password_hash, created_at)
				 VALUES (?, ?, 'x', '2026-10-01T00:00:00Z')`,
				[userId, userId],
			);
			sqlite.run(
				`INSERT INTO recent_tab_archive_marks
				 (id, user_id, narrator_id, folder_id, archived_at)
				 VALUES (?, ?, 'sess-1', ?, '2026-10-02T00:00:00Z')`,
				[`mark-${userId}`, userId, `folder-${userId}`],
			);
		}

		const zip = await readFile((await exportData()).zipPath);
		await clearData("sessions");
		expect(count("recent_tab_archive_marks")).toBe(0);

		const preview = await previewImport(toArrayBuffer(zip), "archive-marks.zip");
		const result = await applyImport(preview.token, { conflictDefault: "skip" });
		expect(result.sessionsInserted).toBe(1);
		const restored = sqlite
			.prepare(
				`SELECT user_id, narrator_id, folder_id FROM recent_tab_archive_marks ORDER BY user_id`,
			)
			.all();
		expect(restored).toEqual([
			{ user_id: "archive-user-a", narrator_id: "sess-1", folder_id: "folder-archive-user-a" },
			{ user_id: "archive-user-b", narrator_id: "sess-1", folder_id: "folder-archive-user-b" },
		]);
	});

	test("文件夹 Git 身份绑定可导出恢复，且不会跨用户串联", async () => {
		const now = "2026-10-01T00:00:00Z";
		for (const id of ["user-a", "user-b"]) {
			sqlite.run(
				`INSERT INTO users (id, username, password_hash, role, created_at)
				 VALUES (?, ?, 'x', 'user', ?)`,
				[id, id, now],
			);
		}
		for (const [id, userId] of [
			["identity-a", "user-a"],
			["identity-b", "user-b"],
		]) {
			sqlite.run(
				`INSERT INTO user_git_identities (id, user_id, name, email, is_default, created_at)
				 VALUES (?, ?, ?, ?, 1, ?)`,
				[id, userId, id, `${id}@example.com`, now],
			);
		}
		for (const id of ["folder-a", "folder-cross"]) {
			sqlite.run(
				`INSERT INTO user_recent_tabs
				 (id, user_id, tab_key, section, type, entity_id, title, last_visited_at, sort_order,
				  created_at, updated_at)
				 VALUES (?, 'user-a', ?, 'work', 'folder', ?, 'Work', 0, 0, ?, ?)`,
				[`row-${id}`, `folder:${id}`, id, now, now],
			);
		}
		sqlite.run(
			`INSERT INTO folder_git_identity_bindings (id, folder_id, user_id, identity_id, updated_at)
			 VALUES ('binding-a', 'folder-a', 'user-a', 'identity-a', ?),
			        ('binding-cross', 'folder-cross', 'user-a', 'identity-b', ?)`,
			[now, now],
		);

		expect(SNAPSHOT_TABLES.sessions).toContain("folder_git_identity_bindings");
		const zip = await readFile(
			(await exportData({ requests: false, sessions: true, providers: false })).zipPath,
		);
		await clearData("sessions");
		expect(count("folder_git_identity_bindings")).toBe(0);

		const preview = await previewImport(toArrayBuffer(zip), "folder-identities.zip");
		await applyImport(preview.token, {
			include: { requests: false, sessions: true, providers: false },
		});
		const rows = sqlite
			.prepare(
				`SELECT id, folder_id, user_id, identity_id FROM folder_git_identity_bindings ORDER BY id`,
			)
			.all();
		expect(rows).toEqual([
			{
				id: "binding-a",
				folder_id: "folder-a",
				user_id: "user-a",
				identity_id: "identity-a",
			},
		]);
	});

	test("目标库缺少绑定身份时只跳过该绑定，不回滚会话导入", async () => {
		const now = "2026-10-01T00:00:00Z";
		sqlite.run(
			`INSERT INTO users (id, username, password_hash, role, created_at)
			 VALUES ('user-a', 'user-a', 'x', 'user', ?)`,
			[now],
		);
		sqlite.run(
			`INSERT INTO user_git_identities (id, user_id, name, email, is_default, created_at)
			 VALUES ('identity-a', 'user-a', 'Alice', 'alice@example.com', 1, ?)`,
			[now],
		);
		sqlite.run(
			`INSERT INTO folder_git_identity_bindings (id, folder_id, user_id, identity_id, updated_at)
			 VALUES ('binding-a', 'folder-a', 'user-a', 'identity-a', ?)`,
			[now],
		);
		const zip = await readFile(
			(await exportData({ requests: false, sessions: true, providers: false })).zipPath,
		);
		await clearData("sessions");
		sqlite.run("DELETE FROM user_git_identities WHERE id = 'identity-a'");

		const preview = await previewImport(toArrayBuffer(zip), "missing-folder-identity.zip");
		const result = await applyImport(preview.token, {
			include: { requests: false, sessions: true, providers: false },
		});
		expect(result.sessionsInserted).toBe(1);
		expect(count("folder_git_identity_bindings")).toBe(0);
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

	test("只导出供应商：不生成快照，导入只应用供应商", async () => {
		const before = snapshotCounts();
		const exported = await exportData({ requests: false, sessions: false, providers: true });
		expect(exported.counts).toMatchObject({ requests: 0, sessions: 0 });
		const zip = await readFile(exported.zipPath);
		// 只勾供应商时不应把会话/请求快照打进包（那是几百 MB 的无关数据）。
		expect(zip.includes(Buffer.from("snapshot.db"))).toBe(false);
		expect(zip.includes(Buffer.from("providers.json"))).toBe(true);

		const preview = await previewImport(toArrayBuffer(zip), "providers-only.zip");
		expect(preview.counts).toMatchObject({ requests: 0, sessions: 0 });
		expect(preview.conflicts).toHaveLength(0);
		const result = await applyImport(preview.token, { conflictDefault: "skip" });
		expect(result.requestsInserted).toBe(0);
		expect(result.sessionsInserted).toBe(0);
		// 主库的请求与会话没有被这次导入动过。
		const after = snapshotCounts();
		expect(after.requests).toBe(before.requests);
		expect(after.sessions).toBe(before.sessions);
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

	test("导入的请求计入用量日账本一次，重复导入不重复计数；清空请求同时清空账本", async () => {
		const ledger = () =>
			sqlite
				.prepare(
					`SELECT COALESCE(SUM(request_count), 0) AS requests, COALESCE(SUM(input_tokens), 0) AS input
					 FROM usage_daily`,
				)
				.get() as { requests: number; input: number };
		const zip = await readFile((await exportData()).zipPath);
		await clearData("all");
		expect(ledger()).toEqual({ requests: 0, input: 0 });

		const first = await previewImport(toArrayBuffer(zip), "export.zip");
		await applyImport(first.token, { conflictDefault: "skip" });
		expect(ledger()).toEqual({ requests: 2, input: 30 });

		const second = await previewImport(toArrayBuffer(zip), "export.zip");
		await applyImport(second.token, { conflictDefault: "skip" });
		expect(ledger()).toEqual({ requests: 2, input: 30 });

		await clearData("requests");
		expect(ledger()).toEqual({ requests: 0, input: 0 });
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

describe("export download ticket", () => {
	const selection = { requests: true, sessions: false, providers: true };

	test("一次性有效，调用方之后改选择不影响已签发的票据", () => {
		const chosen = { ...selection };
		const token = createExportTicket(chosen, 1_000);
		chosen.requests = false;
		expect(consumeExportTicket(token, 1_000)).toEqual(selection);
		expect(consumeExportTicket(token, 1_000)).toBeNull();
	});

	test("过期、伪造的票据不能下载", () => {
		const token = createExportTicket(selection, 1_000);
		expect(consumeExportTicket(token, 1_000 + 2 * 60 * 1000)).toBeNull();
		expect(consumeExportTicket("not-a-ticket", 1_000)).toBeNull();
	});

	test("超过上限时丢掉最早的一张", () => {
		// 先把前面用例留下的票据全部过期掉，再发出这一批。
		const base = 10_000_000_000;
		createExportTicket(selection, base);
		const tokens: string[] = [];
		for (let i = 0; i < 33; i += 1) tokens.push(createExportTicket(selection, base + i));
		expect(consumeExportTicket(tokens[0] ?? "", base + 100)).toBeNull();
		expect(consumeExportTicket(tokens[32] ?? "", base + 100)).toEqual(selection);
	});
});

describe("平台实例随供应商一起导出", () => {
	const instance = {
		id: "platform-cc-1",
		platform: "CommandCode",
		suffix: "1",
		prefix: "CommandCode-1",
		disabled: false,
		config: { apiKey: "cc-key" },
	};
	const instancesNow = () =>
		(settings.agent as unknown as Record<string, unknown>).platformInstances;

	test("导出、清空与导入都带上平台实例", async () => {
		const original = structuredClone(settings);
		// 平台实例由平台集成功能引入；这里按运行时结构写入，导出逻辑只按键名读取。
		(settings.agent as unknown as Record<string, unknown>).platformInstances = [instance];
		try {
			const exported = await exportData({ requests: false, sessions: false, providers: true });
			// 1 个 API key 供应商 + 1 个平台实例
			expect(exported.counts.providers).toBe(2);

			const zip = await readFile(exported.zipPath);
			const preview = await previewImport(toArrayBuffer(zip), "instances.zip");
			// 实例密钥和其它供应商一样走封存包；不带口令的 providers.json 里只有配置。
			const withoutKey = { ...instance, config: {} };
			expect(preview.providers.platformInstances).toEqual([withoutKey]);

			await clearData("providers");
			expect(instancesNow()).toEqual([]);

			const result = await applyImport(preview.token, { conflictDefault: "skip" });
			// 清空后本地两者都没有：导入恢复 1 个 API key 供应商 + 1 个平台实例。
			expect(result.providersAdded).toBe(2);
			expect(instancesNow()).toEqual([withoutKey]);
		} finally {
			saveSettings(original);
		}
	});
});

describe("逐模型设置随供应商一起导出", () => {
	const agent = () => settings.agent as unknown as Record<string, unknown>;

	test("导入按「导入优先、本地独有保留」合并", async () => {
		const original = structuredClone(settings);
		try {
			agent().hiddenModels = ["remote:hidden"];
			agent().modelProtocols = { "remote:proto": "anthropic-messages" };
			agent().customModels = [{ value: "remote:custom", label: "remote" }];

			const exported = await exportData({ requests: false, sessions: false, providers: true });
			const zip = await readFile(exported.zipPath);
			const preview = await previewImport(toArrayBuffer(zip), "model-settings.zip");
			expect(preview.providers.hiddenModels).toEqual(["remote:hidden"]);
			expect(preview.providers.modelProtocols).toEqual({ "remote:proto": "anthropic-messages" });

			// 本地换一套：一条独有、一条与导入同键但取值不同。
			agent().hiddenModels = ["local:hidden"];
			agent().modelProtocols = { "remote:proto": "gemini-compatible" };
			agent().customModels = [];

			await applyImport(preview.token, { conflictDefault: "skip" });

			// 数组取并集；同键的协议以导入为准。
			expect(agent().hiddenModels).toEqual(
				expect.arrayContaining(["local:hidden", "remote:hidden"]),
			);
			expect(agent().modelProtocols).toEqual({ "remote:proto": "anthropic-messages" });
			expect(agent().customModels).toEqual([{ value: "remote:custom", label: "remote" }]);
		} finally {
			saveSettings(original);
		}
	});

	test("不参与自动的前缀随导出导入走、取并集，清空供应商时一起清掉", async () => {
		const original = structuredClone(settings);
		try {
			agent().autoExcludedProviders = ["remote-relay"];
			const exported = await exportData({ requests: false, sessions: false, providers: true });
			const zip = await readFile(exported.zipPath);
			const preview = await previewImport(toArrayBuffer(zip), "auto-excluded.zip");
			expect(preview.providers.autoExcludedProviders).toEqual(["remote-relay"]);

			agent().autoExcludedProviders = ["local-relay"];
			await applyImport(preview.token, { conflictDefault: "skip" });
			expect(agent().autoExcludedProviders).toEqual(
				expect.arrayContaining(["local-relay", "remote-relay"]),
			);

			await clearData("providers");
			expect(agent().autoExcludedProviders).toEqual([]);
		} finally {
			saveSettings(original);
		}
	});

	test("模型覆盖按键合并：同键以导入为准，本地独有保留", async () => {
		const original = structuredClone(settings);
		const originalCatalog = settings.agent.modelCatalog;
		const restores: Array<() => void> = [];
		try {
			restores.push(
				replaceModelOverridesForTests({
					models: { "gpt-6-astra": { maxOutputTokens: 1000 } },
					connections: { "remote:m1": { contextWindow: 1000 } },
				}),
			);

			const exported = await exportData({ requests: false, sessions: false, providers: true });
			const zip = await readFile(exported.zipPath);
			const preview = await previewImport(toArrayBuffer(zip), "catalog.zip");

			// 本地换一套：一条与导入同键但取值不同，一条本地独有；更新策略也不同。
			restores.push(
				replaceModelOverridesForTests({
					connections: {
						"remote:m1": { contextWindow: 2000 },
						"local:only": { contextWindow: 3000 },
					},
				}),
			);
			setModelCatalogAutoUpdate(false);

			await applyImport(preview.token, { conflictDefault: "skip" });

			// 同键用导入的那份，本地独有的条目留着。
			expect(getModelOverride("connection", "remote:m1")).toEqual({ contextWindow: 1000 });
			expect(getModelOverride("connection", "local:only")).toEqual({ contextWindow: 3000 });
			expect(getModelOverride("model", "gpt-6-astra")).toEqual({ maxOutputTokens: 1000 });
			// 导入搬的是模型数据，不是目录更新策略：本地偏好不变，设置里也不内联覆盖。
			expect(settings.agent.modelCatalog).toEqual({ autoUpdate: false });
		} finally {
			while (restores.length) restores.pop()?.();
			setModelCatalogAutoUpdate(originalCatalog?.autoUpdate ?? true);
			saveSettings(original);
		}
	});

	const apiProvider = (id: string, prefix: string, apiKey: string, baseUrl: string) => ({
		id,
		name: prefix,
		prefix,
		protocol: "completions-compatible" as const,
		baseUrl,
		apiKey,
		defaultModel: "",
	});

	test("前缀冲突时导入的会话跟着改到新前缀，跳过的本地会话不动", async () => {
		const original = structuredClone(settings);
		try {
			await seed(1);
			const insertSession = (id: string, model: string, restore: string | null = null) =>
				sqlite.run(
					`INSERT INTO narrators (id, type, model, pending_model_restore, created_at, updated_at)
					 VALUES (?, 'primary', ?, ?, ?, ?)`,
					[id, model, restore, "2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z"],
				);
			insertSession("sess-new", "openai:gpt-5.5", "__agg__:openai:gpt-5.5");
			insertSession("sess-longer", "openai-extra:gpt-5.5");
			insertSession("sess-auto", "auto:gpt-5.5");
			insertSession("sess-kept", "openai:gpt-5.5");
			const exported = structuredClone(settings);
			exported.customApiProviders = [
				apiProvider("remote-openai", "openai", "remote-key", "https://remote.example/v1"),
			];
			saveSettings(exported);
			const zip = await readFile(
				(await exportData({ requests: false, sessions: true, providers: true })).zipPath,
			);
			const preview = await previewImport(toArrayBuffer(zip), "sessions-prefix.zip");

			// Locally, a different service took the `openai` prefix; one session already exists.
			sqlite.run("DELETE FROM narrator_message_refs");
			sqlite.run("DELETE FROM narrator_tool_calls");
			sqlite.run("DELETE FROM narrator_messages");
			sqlite.run("DELETE FROM narrators");
			insertSession("sess-kept", "openai:local-model");
			const local = structuredClone(original);
			local.customApiProviders = [
				apiProvider("local-openai", "openai", "local-key", "https://local.example/v1"),
			];
			saveSettings(local);

			await applyImport(preview.token, { conflictDefault: "skip" });
			const modelOf = (id: string) =>
				sqlite
					.prepare("SELECT model, pending_model_restore AS restore FROM narrators WHERE id = ?")
					.get(id) as { model: string | null; restore: string | null };
			expect(modelOf("sess-new")).toEqual({
				model: "openai-2:gpt-5.5",
				restore: "__agg__:openai-2:gpt-5.5",
			});
			expect(modelOf("sess-longer").model).toBe("openai-extra:gpt-5.5");
			expect(modelOf("sess-auto").model).toBe("auto:gpt-5.5");
			// Skipped on conflict: the local row and its local provider stay as they were.
			expect(modelOf("sess-kept").model).toBe("openai:local-model");
		} finally {
			saveSettings(original);
		}
	});

	test("前缀冲突时逐模型设置改挂到新前缀，且不误伤更长的前缀", async () => {
		const original = structuredClone(settings);
		const restores: Array<() => void> = [];
		try {
			restores.push(
				replaceModelOverridesForTests({ connections: { "openai:ctx": { contextWindow: 5000 } } }),
			);
			const exported = structuredClone(settings);
			exported.customApiProviders = [
				apiProvider("remote-openai", "openai", "remote-key", "https://remote.example/v1"),
			];
			(exported.agent as unknown as Record<string, unknown>).hiddenModels = [
				"openai:hidden",
				"openai-2:already",
				"openai-extra:stay",
			];
			(exported.agent as unknown as Record<string, unknown>).modelProtocols = {
				"openai:proto": "anthropic-messages",
				"openai-extra:stay": "gemini-compatible",
			};
			(exported.agent as unknown as Record<string, unknown>).customModels = [
				{ value: "openai:custom", label: "remote", provider: "openai" },
			];
			(exported.agent as unknown as Record<string, unknown>).autoExcludedProviders = [
				"openai",
				"openai-extra",
			];
			saveSettings(exported);

			const zip = await readFile(
				(await exportData({ requests: false, sessions: false, providers: true })).zipPath,
			);
			const preview = await previewImport(toArrayBuffer(zip), "prefix.zip");

			const local = structuredClone(original);
			local.customApiProviders = [
				apiProvider("local-openai", "openai", "local-key", "https://local.example/v1"),
			];
			(local.agent as unknown as Record<string, unknown>).hiddenModels = ["openai:local-only"];
			(local.agent as unknown as Record<string, unknown>).modelProtocols = {
				"openai:local": "completions-compatible",
			};
			(local.agent as unknown as Record<string, unknown>).customModels = [];
			(local.agent as unknown as Record<string, unknown>).autoExcludedProviders = [];
			saveSettings(local);
			restores.push(replaceModelOverridesForTests({}));

			await applyImport(preview.token, { conflictDefault: "skip" });
			expect(getModelOverride("connection", "openai-2:ctx")).toEqual({ contextWindow: 5000 });
			expect(getModelOverride("connection", "openai:ctx")).toBeUndefined();

			expect((settings.customApiProviders ?? []).map((item) => item.prefix).sort()).toEqual([
				"openai",
				"openai-2",
			]);
			expect(agent().hiddenModels).toEqual([
				"openai:local-only",
				"openai-2:hidden",
				"openai-2:already",
				"openai-extra:stay",
			]);
			expect(agent().modelProtocols).toEqual({
				"openai:local": "completions-compatible",
				"openai-2:proto": "anthropic-messages",
				"openai-extra:stay": "gemini-compatible",
			});
			expect(agent().customModels).toEqual([
				{ value: "openai-2:custom", label: "remote", provider: "openai-2" },
			]);
			// Bare prefixes follow the rename too; the local provider stays in auto.
			expect(agent().autoExcludedProviders).toEqual(["openai-2", "openai-extra"]);
		} finally {
			while (restores.length) restores.pop()?.();
			saveSettings(original);
		}
	});

	test("同一端点已存在但前缀不同时，模型设置改挂到本地前缀", async () => {
		const original = structuredClone(settings);
		try {
			const exported = structuredClone(settings);
			exported.customApiProviders = [
				apiProvider("remote", "remote", "shared-key", "https://same.example/v1"),
			];
			(exported.agent as unknown as Record<string, unknown>).hiddenModels = ["remote:hidden"];
			saveSettings(exported);

			// The same-endpoint check compares keys, which travel sealed.
			const passphrase = "same-endpoint-pass";
			const zip = await readFile(
				(await exportData({ requests: false, sessions: false, providers: true }, { passphrase }))
					.zipPath,
			);
			const preview = await previewImport(toArrayBuffer(zip), "same-endpoint.zip");

			const local = structuredClone(original);
			local.customApiProviders = [
				apiProvider("local", "local", "shared-key", "https://same.example/v1"),
			];
			(local.agent as unknown as Record<string, unknown>).hiddenModels = ["local:keep"];
			saveSettings(local);

			const result = await applyImport(preview.token, { conflictDefault: "skip", passphrase });
			expect(result.providersAdded).toBe(0);
			expect(settings.customApiProviders ?? []).toHaveLength(1);
			expect(settings.customApiProviders?.[0]?.prefix).toBe("local");
			expect(agent().hiddenModels).toEqual(["local:keep", "local:hidden"]);
		} finally {
			saveSettings(original);
		}
	});
});

describe("跳过会话不带回子行，覆盖按主键补回", () => {
	test("跳过不恢复已删的消息、块和请求；覆盖会补回，且不删本地新增", async () => {
		sqlite.run(
			`INSERT INTO narrator_messages (id, narrator_id, role, content_json, created_at)
			 VALUES ('msg-new', 'sess-1', 'user', '[]', '2026-10-02T00:00:00Z')`,
		);
		sqlite.run(
			`INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq)
			 VALUES ('ref-new', 'sess-1', 'msg-new', 3)`,
		);
		sqlite.run(
			`INSERT INTO narrator_tool_calls (id, narrator_id, message_id, tool_use_id, tool_name, created_at)
			 VALUES ('tc-new', 'sess-1', 'msg-new', 'tu-new', 'Read', '2026-10-02T00:00:01Z')`,
		);
		sqlite.run(
			`INSERT INTO narrator_blocks (id, message_id, ordinal, kind, phase, created_at, payload)
			 VALUES ('blk-new', 'msg-new', 0, 'input', 'done', '2026-10-02T00:00:00Z', '{"text":"new"}')`,
		);
		sqlite.run(
			`INSERT INTO api_requests (id, narrator_id, created_at, input_tokens, output_tokens, cached_input_tokens)
			 VALUES ('req-new', 'sess-1', '2026-10-02T00:00:00Z', 1, 1, 0)`,
		);

		const zip = await readFile((await exportData()).zipPath);
		sqlite.run(`DELETE FROM api_requests WHERE id = 'req-new'`);
		sqlite.run(`DELETE FROM narrator_message_refs WHERE id = 'ref-new'`);
		sqlite.run(`DELETE FROM narrator_tool_calls WHERE id = 'tc-new'`);
		sqlite.run(`DELETE FROM narrator_messages WHERE id = 'msg-new'`);
		sqlite.run(
			`INSERT INTO narrator_messages (id, narrator_id, role, content_json, created_at)
			 VALUES ('msg-local', 'sess-1', 'user', '["local"]', '2026-10-03T00:00:00Z')`,
		);

		const skipped = await applyImport((await previewImport(toArrayBuffer(zip), "skip.zip")).token, {
			conflictDefault: "skip",
		});
		expect(skipped.sessionsSkipped).toBe(1);
		expect(skipped.requestsInserted).toBe(0);
		for (const [table, id] of [
			["narrator_messages", "msg-new"],
			["narrator_message_refs", "ref-new"],
			["narrator_tool_calls", "tc-new"],
			["narrator_blocks", "blk-new"],
			["api_requests", "req-new"],
		] as const) {
			expect(sqlite.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id)).toBeNull();
		}
		expect(
			sqlite.prepare(`SELECT 1 FROM narrator_messages WHERE id = 'msg-local'`).get(),
		).toBeTruthy();

		await applyImport((await previewImport(toArrayBuffer(zip), "overwrite.zip")).token, {
			conflictDefault: "overwrite",
		});
		expect(
			sqlite.prepare(`SELECT payload FROM narrator_blocks WHERE id = 'blk-new'`).get(),
		).toEqual({
			payload: '{"text":"new"}',
		});
		expect(
			sqlite.prepare(`SELECT narrator_id FROM api_requests WHERE id = 'req-new'`).get(),
		).toEqual({ narrator_id: "sess-1" });
		expect(
			sqlite.prepare(`SELECT 1 FROM narrator_message_refs WHERE id = 'ref-new'`).get(),
		).toBeTruthy();
		expect(
			sqlite.prepare(`SELECT 1 FROM narrator_tool_calls WHERE id = 'tc-new'`).get(),
		).toBeTruthy();
		expect(
			sqlite.prepare(`SELECT 1 FROM narrator_messages WHERE id = 'msg-local'`).get(),
		).toBeTruthy();
		expect(count("narrator_messages")).toBe(4);
	});

	test("body_rows_only 的正文随 narrator_blocks 导出再导入", async () => {
		sqlite.run(
			`UPDATE narrator_messages
			    SET content_json = '[]', body_rows_only = 1, body_format = 2
			  WHERE id = 'msg-1'`,
		);
		sqlite.run(
			`INSERT INTO narrator_blocks (id, message_id, ordinal, kind, phase, created_at, payload)
			 VALUES ('blk-1', 'msg-1', 0, 'input', 'done', '2026-10-01T00:00:01Z', '{"text":"block-body"}')`,
		);
		const zip = await readFile(
			(await exportData({ requests: false, sessions: true, providers: false })).zipPath,
		);
		await clearData("sessions");
		expect(count("narrator_blocks")).toBe(0);

		const preview = await previewImport(toArrayBuffer(zip), "blocks.zip");
		const result = await applyImport(preview.token, {
			conflictDefault: "skip",
			include: { sessions: true, requests: false, providers: false },
		});
		expect(result.sessionsInserted).toBe(1);
		const message = sqlite
			.prepare(`SELECT body_rows_only FROM narrator_messages WHERE id = 'msg-1'`)
			.get() as { body_rows_only: number };
		expect(message.body_rows_only).toBe(1);
		expect(sqlite.prepare(`SELECT payload FROM narrator_blocks WHERE id = 'blk-1'`).get()).toEqual({
			payload: '{"text":"block-body"}',
		});
	});
});
