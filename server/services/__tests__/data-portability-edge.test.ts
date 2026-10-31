/**
 * 数据可移植性 · 异常与边界全覆盖。
 *
 * 目标是「奇妙数据」不弄坏主库：空库、注入字符、超长文本、畸形/缺失/版本过高的包、
 * 缺表快照、逐条混合冲突决策、供应商多次重名、批量会话与消息等。
 * 每个用例独立临时 NARRAFORK_HOME，真实 SQLite。
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const previousHome = process.env.NARRAFORK_HOME;
const testHome = mkdtempSync(join(tmpdir(), "narrafork-portability-edge-"));
process.env.NARRAFORK_HOME = testHome;

const { sqlite } = await import("../../db");
const { saveSettings, settings } = await import("../../lib/settings");
const { applyImport, clearData, exportData, previewImport } = await import("../data-portability");
const archiver = (await import("archiver")).default;
const { createWriteStream } = await import("node:fs");

afterAll(() => {
	if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = previousHome;
	try {
		rmSync(testHome, { recursive: true, force: true });
	} catch {
		// Windows 句柄未释放：留给系统清理
	}
});

const count = (table: string) =>
	Number((sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);

const toArrayBuffer = (buffer: Buffer): ArrayBuffer =>
	buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;

function reset() {
	sqlite.run("DELETE FROM api_requests");
	sqlite.run("DELETE FROM narrator_message_refs");
	sqlite.run("DELETE FROM narrator_tool_calls");
	sqlite.run("DELETE FROM narrator_messages");
	sqlite.run("DELETE FROM narrators");
	const next = structuredClone(settings);
	next.codex = undefined;
	next.tokendance = undefined;
	next.commandCode = undefined;
	next.customApiProviders = [];
	next.nugProviders = [];
	saveSettings(next);
}

function insertNarrator(id: string, title: string | null) {
	sqlite.run(
		`INSERT INTO narrators (id, type, title, created_at, updated_at) VALUES (?, 'primary', ?, ?, ?)`,
		[id, title, "2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z"],
	);
}

function insertMessage(id: string, narratorId: string, body: string) {
	sqlite.run(
		`INSERT INTO narrator_messages (id, narrator_id, role, content_json, created_at) VALUES (?, ?, 'user', ?, ?)`,
		[id, narratorId, body, "2026-10-01T00:00:01Z"],
	);
}

/** 造一个自定义 ZIP（文件名 → 内容），用来构造畸形包。 */
async function buildZip(files: Record<string, string | Buffer>): Promise<Buffer> {
	const dir = mkdtempSync(join(tmpdir(), "narrafork-edge-zip-"));
	const zipPath = join(dir, "custom.zip");
	await new Promise<void>((resolve, reject) => {
		const output = createWriteStream(zipPath);
		const archive = archiver("zip");
		output.on("close", () => resolve());
		archive.on("error", reject);
		archive.pipe(output);
		for (const [name, content] of Object.entries(files)) archive.append(content, { name });
		void archive.finalize();
	});
	const buffer = await readFile(zipPath);
	rmSync(dir, { recursive: true, force: true });
	return buffer;
}

/** 造一个只有指定表/列的最小 snapshot.db。 */
function buildSnapshot(statement: string): Buffer {
	const dir = mkdtempSync(join(tmpdir(), "narrafork-edge-db-"));
	const path = join(dir, "snapshot.db");
	const db = new Database(path);
	try {
		db.run(statement);
	} finally {
		db.close();
	}
	const bytes = require("node:fs").readFileSync(path) as Buffer;
	rmSync(dir, { recursive: true, force: true });
	return bytes;
}

beforeEach(() => {
	reset();
});

describe("data portability · 异常与边界", () => {
	test("空库：导出包可预览可导入，计数为 0", async () => {
		const exported = await exportData();
		expect(exported.counts).toEqual({ requests: 0, sessions: 0, providers: 0 });
		const zip = await readFile(exported.zipPath);
		const preview = await previewImport(toArrayBuffer(zip), "export.zip");
		expect(preview.counts).toEqual({ requests: 0, sessions: 0, providers: 0 });
		expect(preview.conflicts).toEqual([]);
		const result = await applyImport(preview.token, { conflictDefault: "skip" });
		expect(result.requestsInserted).toBe(0);
		expect(count("narrators")).toBe(0);
	});

	test("SQL 注入字符：会话名与供应商名原样保存，表未被破坏", async () => {
		const nasty = `'; DROP TABLE narrators; --`;
		insertNarrator("sess-inject", nasty);
		sqlite.run(`INSERT INTO api_requests (id, created_at, input_tokens) VALUES (?, ?, 1)`, [
			"req-inject",
			"2026-10-01T00:00:00Z",
		]);
		const zip = await readFile((await exportData()).zipPath);
		const preview = await previewImport(toArrayBuffer(zip), "export.zip");
		await applyImport(preview.token, { conflictDefault: "overwrite" });
		const row = sqlite.prepare(`SELECT title FROM narrators WHERE id = ?`).get("sess-inject") as {
			title: string;
		};
		expect(row.title).toBe(nasty);
		expect(count("narrators")).toBe(1);
		expect(count("api_requests")).toBe(1);
	});

	test("超长消息（1MB contentJson）：完整往返", async () => {
		insertNarrator("sess-big", "大消息会话");
		const big = JSON.stringify([{ type: "text", text: "x".repeat(1024 * 1024) }]);
		insertMessage("msg-big", "sess-big", big);
		const zip = await readFile((await exportData()).zipPath);
		const preview = await previewImport(toArrayBuffer(zip), "export.zip");
		await applyImport(preview.token, { conflictDefault: "overwrite" });
		const row = sqlite
			.prepare(`SELECT content_json FROM narrator_messages WHERE id = ?`)
			.get("msg-big") as { content_json: string };
		expect(row.content_json.length).toBe(big.length);
	});

	test("畸形 providers.json：拒绝且主库不变", async () => {
		insertNarrator("sess-1", "会话");
		const snapshot = buildSnapshot(`CREATE TABLE narrators (id TEXT PRIMARY KEY);`);
		const bad = await buildZip({
			"snapshot.db": snapshot,
			"providers.json": "{ not valid json",
			"manifest.json": JSON.stringify({ version: 1 }),
		});
		await expect(previewImport(toArrayBuffer(bad), "bad.zip")).rejects.toThrow();
		expect(count("narrators")).toBe(1);
	});

	test("manifest 版本过高：拒绝导入", async () => {
		const exported = await exportData();
		const zip = await readFile(exported.zipPath);
		const original = await previewImport(toArrayBuffer(zip), "export.zip");
		// 用超过当前支持版本的 manifest 重新打包（复用同一 snapshot）
		const snapshotBytes = buildSnapshot(`CREATE TABLE narrators (id TEXT PRIMARY KEY);`);
		const tooNew = await buildZip({
			"snapshot.db": snapshotBytes,
			"manifest.json": JSON.stringify({ version: 999 }),
		});
		await expect(previewImport(toArrayBuffer(tooNew), "new.zip")).rejects.toThrow();
		void original;
	});

	test("快照缺表：明确拒绝，已有数据不受影响", async () => {
		insertNarrator("sess-keep", "保留会话");
		insertMessage("msg-keep", "sess-keep", "[]");
		const bytes = buildSnapshot(
			`CREATE TABLE api_requests (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);`,
		);
		const zip = await buildZip({
			"snapshot.db": bytes,
			"manifest.json": JSON.stringify({ version: 1 }),
		});
		// 缺 narrators/narrator_messages → 预览阶段拒绝
		await expect(previewImport(toArrayBuffer(zip), "partial.zip")).rejects.toThrow();
		expect(count("narrators")).toBe(1);
		expect(count("narrator_messages")).toBe(1);
	});

	test("逐条混合决策：一个覆盖一个跳过，互不影响", async () => {
		insertNarrator("sess-a", "会话A");
		insertNarrator("sess-b", "会话B");
		const zip = await readFile((await exportData()).zipPath);
		// 本地改动 A 与 B
		sqlite.run(`UPDATE narrators SET title = '本地A' WHERE id = 'sess-a'`);
		sqlite.run(`UPDATE narrators SET title = '本地B' WHERE id = 'sess-b'`);
		const preview = await previewImport(toArrayBuffer(zip), "export.zip");
		expect(preview.conflicts.map((c) => c.id).sort()).toEqual(["sess-a", "sess-b"]);
		const result = await applyImport(preview.token, {
			conflictById: { "sess-a": "overwrite", "sess-b": "skip" },
		});
		expect(result.sessionsOverwritten).toBe(1);
		expect(result.sessionsSkipped).toBe(1);
		const a = sqlite.prepare(`SELECT title FROM narrators WHERE id = 'sess-a'`).get() as {
			title: string;
		};
		const b = sqlite.prepare(`SELECT title FROM narrators WHERE id = 'sess-b'`).get() as {
			title: string;
		};
		expect(a.title).toBe("会话A"); // 被导入值覆盖
		expect(b.title).toBe("本地B"); // 跳过，保留本地
	});

	test("供应商同 apiKey+baseUrl：重复导入直接跳过，不产生副本", async () => {
		const next = structuredClone(settings);
		next.codex = undefined;
		next.tokendance = undefined;
		next.commandCode = undefined;
		next.nugProviders = [];
		next.customApiProviders = [
			{
				id: "p1",
				name: "Same",
				prefix: "same",
				protocol: "completions-compatible",
				baseUrl: "https://a.example/v1",
				apiKey: "k",
				defaultModel: "",
			},
		];
		saveSettings(next);

		const zip = await readFile((await exportData()).zipPath);
		// 同一端点已经存在：连续导入两次都应被跳过
		for (let i = 0; i < 2; i += 1) {
			const preview = await previewImport(toArrayBuffer(zip), "export.zip");
			await applyImport(preview.token, { conflictDefault: "skip" });
		}
		const providers = settings.customApiProviders ?? [];
		expect(providers).toHaveLength(1);
		expect(providers[0]?.name).toBe("Same");
	});

	test("供应商重名但端点不同：-副本 递增，id 与 prefix 均唯一", async () => {
		const template = structuredClone(settings);
		template.codex = undefined;
		template.tokendance = undefined;
		template.commandCode = undefined;
		template.nugProviders = [];
		const provider = (id: string, baseUrl: string) => ({
			id,
			name: "Same",
			prefix: "same",
			protocol: "completions-compatible" as const,
			baseUrl,
			apiKey: "k",
			defaultModel: "",
		});

		saveSettings({ ...template, customApiProviders: [provider("p1", "https://a.example/v1")] });
		const zip = await readFile((await exportData()).zipPath);

		// 本地换成另一端点后再导入：端点不同，必须并存并自动改名
		saveSettings({ ...template, customApiProviders: [provider("p2", "https://b.example/v1")] });
		const preview = await previewImport(toArrayBuffer(zip), "export.zip");
		await applyImport(preview.token, { conflictDefault: "skip" });

		const providers = settings.customApiProviders ?? [];
		expect(providers).toHaveLength(2);
		const ids = providers.map((p) => p.id);
		const prefixes = providers.map((p) => p.prefix);
		expect(new Set(ids).size).toBe(ids.length);
		expect(new Set(prefixes).size).toBe(prefixes.length);
		expect(providers.map((p) => p.name)).toContain("Same-副本");
	});

	test("空库清空：计数 0，不抛错", async () => {
		const cleared = await clearData("all");
		expect(cleared.deleted).toEqual({ requests: 0, sessions: 0, providers: 0 });
	});

	test("重复导出：两次包均可预览，主库不变", async () => {
		insertNarrator("sess-1", "会话");
		const before = count("narrators");
		const zip1 = await readFile((await exportData()).zipPath);
		const zip2 = await readFile((await exportData()).zipPath);
		const p1 = await previewImport(toArrayBuffer(zip1), "a.zip");
		const p2 = await previewImport(toArrayBuffer(zip2), "b.zip");
		expect(p1.token).not.toBe(p2.token);
		expect(count("narrators")).toBe(before);
	});

	test("空 snapshot.db（0 字节）：拒绝且主库不变", async () => {
		insertNarrator("sess-keep", "保留会话");
		const zip = await buildZip({
			"snapshot.db": Buffer.alloc(0),
			"manifest.json": JSON.stringify({ version: 1 }),
		});
		await expect(previewImport(toArrayBuffer(zip), "empty.zip")).rejects.toThrow();
		expect(count("narrators")).toBe(1);
	});

	test("损坏 snapshot.db（非 SQLite 内容）：拒绝且主库不变", async () => {
		insertNarrator("sess-keep", "保留会话");
		const zip = await buildZip({
			"snapshot.db": Buffer.from("this is definitely not a sqlite database file", "utf8"),
			"manifest.json": JSON.stringify({ version: 1 }),
		});
		await expect(previewImport(toArrayBuffer(zip), "corrupt.zip")).rejects.toThrow();
		expect(count("narrators")).toBe(1);
	});

	test("导入后立即导出：闭环一致（计数与内容都对得上）", async () => {
		insertNarrator("sess-loop", "闭环会话");
		insertMessage("msg-loop", "sess-loop", JSON.stringify([{ type: "text", text: "loop" }]));
		const zip = await readFile((await exportData()).zipPath);
		const preview = await previewImport(toArrayBuffer(zip), "export.zip");
		await applyImport(preview.token, { conflictDefault: "overwrite" });
		// 再次导出，第二次的计数应与导入前完全一致
		const second = await exportData();
		expect(second.counts).toEqual({
			requests: 0,
			sessions: 1,
			providers: 0,
		});
		const secondZip = await readFile(second.zipPath);
		const secondPreview = await previewImport(toArrayBuffer(secondZip), "again.zip");
		expect(secondPreview.counts.sessions).toBe(1);
		expect(secondPreview.conflicts).toHaveLength(1);
	});

	test("并发预览：同一 ZIP 两个 token 独立生效、互不干扰", async () => {
		insertNarrator("sess-1", "会话");
		const zip = await readFile((await exportData()).zipPath);
		const [p1, p2] = await Promise.all([
			previewImport(toArrayBuffer(zip), "a.zip"),
			previewImport(toArrayBuffer(zip), "b.zip"),
		]);
		expect(p1.token).not.toBe(p2.token);
		expect(p1.conflicts).toHaveLength(1);
		expect(p2.conflicts).toHaveLength(1);
		// 用第一个 token 导入后，第二个 token 依然可用（预览快照独立）
		await applyImport(p1.token, { conflictDefault: "skip" });
		const result = await applyImport(p2.token, { conflictDefault: "skip" });
		expect(result.sessionsSkipped).toBe(1);
	});

	test("批量会话与消息：100 会话 / 5000 消息往返一致", async () => {
		sqlite.transaction(() => {
			for (let s = 0; s < 100; s += 1) {
				const sess = `sess-${s}`;
				insertNarrator(sess, `会话${s}`);
				for (let m = 0; m < 50; m += 1) {
					insertMessage(`msg-${s}-${m}`, sess, "[]");
				}
			}
		})();
		expect(count("narrators")).toBe(100);
		expect(count("narrator_messages")).toBe(5000);

		const started = Date.now();
		const zip = await readFile((await exportData()).zipPath);
		const preview = await previewImport(toArrayBuffer(zip), "export.zip");
		expect(preview.counts.sessions).toBe(100);
		await applyImport(preview.token, { conflictDefault: "overwrite" });
		const elapsed = Date.now() - started;
		expect(elapsed).toBeLessThan(15_000);
		expect(count("narrators")).toBe(100);
		expect(count("narrator_messages")).toBe(5000);
	});
});
