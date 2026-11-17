/**
 * Database cleanup and project teams (P1): a coordinator whose team still has live work items
 * cannot be deleted (`TEAM_HAS_LIVE_WORK`). Cleanup keeps it — reported as blocked with
 * `teamLiveWork` in the preview — and deletes everything else, instead of aborting on the
 * refusal halfway through and never reaching VACUUM.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const previousHome = process.env.NARRAFORK_HOME;
const testHome = mkdtempSync(join(tmpdir(), "narrafork-cleanup-teams-"));
process.env.NARRAFORK_HOME = testHome;

const { sqlite } = await import("../../db");
const { databaseCleanupService } = await import("../database-cleanup-service");
const { shutdownDbWorkerPool } = await import("../../lib/db-worker/pool");

afterAll(async () => {
	await shutdownDbWorkerPool();
	if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = previousHome;
	rmSync(testHome, { recursive: true, force: true });
});

const OLD = "2020-01-01T00:00:00.000Z";
const PROJECT = "cleanup-teams-project";

function narrator(id: string, traits: string[] = []) {
	sqlite.run(
		`INSERT INTO narrators (id, type, title, traits, status, created_at, updated_at)
		VALUES (?, 'primary', ?, ?, 'archived', ?, ?)`,
		[id, id, JSON.stringify(traits), OLD, OLD],
	);
}

function team(id: string, itemState: string) {
	narrator(id, ["team"]);
	sqlite.run(
		`INSERT INTO project_teams (narrator_id, project_id, base_branch, status, created_at, updated_at)
		VALUES (?, ?, 'main', 'archived', ?, ?)`,
		[id, PROJECT, OLD, OLD],
	);
	sqlite.run(
		`INSERT INTO team_work_items (id, team_id, project_id, title, state, created_at, updated_at)
		VALUES (?, ?, ?, 'work', ?, ?, ?)`,
		[`item-${id}`, id, PROJECT, itemState, OLD, OLD],
	);
}

const exists = (id: string) =>
	Boolean(sqlite.prepare(`SELECT 1 FROM narrators WHERE id = ?`).get(id));

beforeAll(() => {
	sqlite.run(`INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, 'p', ?, ?)`, [
		PROJECT,
		OLD,
		OLD,
	]);
	narrator("plain-archived");
	team("lead-busy", "in_progress");
	team("lead-finished", "cancelled");
});

describe("database cleanup with team coordinators", () => {
	test("the preview keeps a coordinator with live work, with the reason", async () => {
		const preview = await databaseCleanupService.previewCleanup("archivedSessions");
		expect(preview.counts.sessions).toBe(2);
		expect(preview.blocked).toEqual([
			expect.objectContaining({
				narratorId: "lead-busy",
				reasonCode: "teamLiveWork",
				blockingNarratorId: "lead-busy",
			}),
		]);
	});

	test("cleanup deletes the rest and keeps that coordinator and its team", async () => {
		const result = await databaseCleanupService.executeCleanup("archivedSessions");
		expect(result.changed).toBe(true);
		expect(exists("plain-archived")).toBe(false);
		expect(exists("lead-finished")).toBe(false);
		expect(exists("lead-busy")).toBe(true);
		const teams = sqlite.prepare(`SELECT narrator_id FROM project_teams`).all() as Array<{
			narrator_id: string;
		}>;
		expect(teams.map((row) => row.narrator_id)).toEqual(["lead-busy"]);
		expect(result.blockedCount).toBe(1);
	});
});
