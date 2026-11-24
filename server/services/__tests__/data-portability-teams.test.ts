/**
 * 数据可移植性 · 项目 team（docs/PROJECT_TEAMS-PLAN.md P1）。
 *
 * team 的三张表不导出（记的是本机的 git 分支和 worktree）：
 * - 导出的快照里没有它们；
 * - 导入后会话的 `team` trait 以本机有没有 team 行为准：新会话去掉、覆盖本机协调者时保留；
 * - 清空会话先清 team 表（team 行 RESTRICT 会话删除），不报外键错。
 * 独立临时 NARRAFORK_HOME，真实 SQLite。
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const previousHome = process.env.NARRAFORK_HOME;
const testHome = mkdtempSync(join(tmpdir(), "narrafork-portability-teams-"));
process.env.NARRAFORK_HOME = testHome;

const { sqlite } = await import("../../db");
const { SNAPSHOT_TABLES } = await import("../../db/snapshot-protocol");
const { applyImport, clearData, exportData, previewImport } = await import("../data-portability");
const { isTeamSessionCached, teamSessionMemoSize } = await import("../teams/team-session-memo");
const { eventBus } = await import("../../lib/event-bus");

afterAll(() => {
	if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = previousHome;
	try {
		rmSync(testHome, { recursive: true, force: true });
	} catch {
		// Windows 句柄未释放：留给系统清理
	}
});

const NOW = "2026-11-16T00:00:00Z";
const PROJECT = "p-teams-portability";

const toArrayBuffer = (buffer: Buffer): ArrayBuffer =>
	buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;

const count = (table: string) =>
	Number((sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);

const traitsOf = (id: string) =>
	JSON.parse(
		(sqlite.prepare(`SELECT traits FROM narrators WHERE id = ?`).get(id) as { traits: string })
			.traits,
	) as string[];

function insertNarrator(id: string, traits: string[]) {
	sqlite.run(
		`INSERT INTO narrators (id, type, title, traits, created_at, updated_at)
		VALUES (?, 'primary', ?, ?, ?, ?)`,
		[id, `会话 ${id}`, JSON.stringify(traits), NOW, NOW],
	);
}

function insertTeam(id: string, withLiveItem = false) {
	sqlite.run(
		`INSERT INTO project_teams (narrator_id, project_id, base_branch, created_at, updated_at)
		VALUES (?, ?, 'main', ?, ?)`,
		[id, PROJECT, NOW, NOW],
	);
	sqlite.run(
		`INSERT INTO team_work_events (id, team_id, kind, actor_kind, created_at)
		VALUES (?, ?, 'team.created', 'system', ?)`,
		[`ev-${id}`, id, NOW],
	);
	if (withLiveItem)
		sqlite.run(
			`INSERT INTO team_work_items (id, team_id, project_id, title, state, created_at, updated_at)
			VALUES (?, ?, ?, 'work', 'in_progress', ?, ?)`,
			[`wi-${id}`, id, PROJECT, NOW, NOW],
		);
}

async function exportZip(): Promise<ArrayBuffer> {
	return toArrayBuffer(await readFile((await exportData()).zipPath));
}

beforeEach(() => {
	sqlite.run("DELETE FROM team_work_events");
	sqlite.run("DELETE FROM team_work_items");
	sqlite.run("DELETE FROM project_teams");
	sqlite.run("DELETE FROM narrator_message_refs");
	sqlite.run("DELETE FROM narrator_messages");
	sqlite.run("DELETE FROM narrators");
	sqlite.run(
		`INSERT OR IGNORE INTO projects (id, name, git_path, created_at, updated_at)
		VALUES (?, 'teams', ?, ?, ?)`,
		[PROJECT, join(testHome, "repo"), NOW, NOW],
	);
});

describe("data portability · project teams", () => {
	test("team 表不在快照里", async () => {
		const exported = Object.values(SNAPSHOT_TABLES).flat() as string[];
		for (const table of ["project_teams", "team_work_items", "team_work_events"])
			expect(exported).not.toContain(table);
		insertNarrator("n-lead", ["team"]);
		insertTeam("n-lead", true);
		const preview = await previewImport(await exportZip(), "export.zip");
		const snap = new Database(preview.snapshotPath, { readonly: true });
		const tables = (
			snap.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{
				name: string;
			}>
		).map((t) => t.name);
		snap.close();
		expect(tables).toContain("narrators");
		expect(tables).not.toContain("project_teams");
		expect(tables).not.toContain("team_work_items");
	});

	test("导入的新会话没有本机 team 行：去掉 team trait，其它 trait 保留", async () => {
		insertNarrator("n-away", ["standalone", "team"]);
		insertTeam("n-away");
		const zip = await exportZip();
		await clearData("sessions");
		expect(count("narrators")).toBe(0);
		const preview = await previewImport(zip, "export.zip");
		const result = await applyImport(preview.token, { conflictDefault: "overwrite" });
		expect(result.sessionsInserted).toBe(1);
		expect(traitsOf("n-away")).toEqual(["standalone"]);
		expect(count("project_teams")).toBe(0);
	});

	test("覆盖本机协调者：保留 team trait、team 行和工作记录", async () => {
		insertNarrator("n-local", ["standalone"]);
		const zip = await exportZip();
		// Locally it became a coordinator after the export (an id collision of this kind only
		// happens when a backup is restored onto the machine it came from).
		sqlite.run(`UPDATE narrators SET traits = '["standalone","team"]' WHERE id = 'n-local'`);
		insertTeam("n-local", true);
		const preview = await previewImport(zip, "export.zip");
		const result = await applyImport(preview.token, { conflictDefault: "overwrite" });
		expect(result.sessionsOverwritten).toBe(1);
		expect(traitsOf("n-local")).toEqual(["standalone", "team"]);
		expect(count("project_teams")).toBe(1);
		expect(count("team_work_items")).toBe(1);
		expect(count("team_work_events")).toBe(1);
	});

	test("不相关的本机会话不被导入改动", async () => {
		insertNarrator("n-other", ["team"]);
		insertTeam("n-other");
		const zip = await exportZip();
		insertNarrator("n-unrelated", ["team"]); // a broken local row the import must not touch
		const preview = await previewImport(zip, "export.zip");
		await applyImport(preview.token, { conflictDefault: "skip" });
		expect(traitsOf("n-other")).toEqual(["team"]);
		expect(traitsOf("n-unrelated")).toEqual(["team"]);
	});

	test("清空会话一起清掉 team 表（含进行中的工作项），没有外键错误", async () => {
		insertNarrator("n-clear", ["team"]);
		insertTeam("n-clear", true);
		const result = await clearData("sessions");
		expect(result.deleted.sessions).toBe(1);
		for (const table of ["narrators", "project_teams", "team_work_items", "team_work_events"])
			expect(count(table)).toBe(0);
		// The project itself is not session data.
		expect(count("projects")).toBe(1);
	});

	test("IM 网关记住的「是不是 team 会话」：导入、清空和删除会话后都忘掉 (M1)", async () => {
		insertNarrator("n-memo", ["team"]);
		insertTeam("n-memo");
		expect(isTeamSessionCached("n-memo")).toBe(true);
		const zip = await exportZip();
		// Cleared: the id is gone, so is what was remembered about it.
		await clearData("sessions");
		expect(teamSessionMemoSize()).toBe(0);
		// Imported back without a local team row: no longer a team session.
		expect(isTeamSessionCached("n-memo")).toBe(false);
		const preview = await previewImport(zip, "export.zip");
		await applyImport(preview.token, { conflictDefault: "overwrite" });
		expect(teamSessionMemoSize()).toBe(0);
		expect(isTeamSessionCached("n-memo")).toBe(false);
		// Made a coordinator here, and its memo dropped when the narrator is deleted.
		insertTeam("n-memo");
		eventBus.emit({ type: "narrator:deleted", narratorId: "n-memo", title: null });
		expect(isTeamSessionCached("n-memo")).toBe(true);
	});
});
