import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { eq, inArray } from "drizzle-orm";
import { db, sqlite } from "../db";
import { narrators, worktreeTreeSnapshots } from "../db/schema";
import { generateId } from "../lib/id";
import { getNarraforkPath } from "../lib/narrafork-home";
import { safeSpawn } from "../lib/spawn";
import { FileWorktreeJournal, type WorktreeJournalRecord } from "./narrator-worktree-journal";
import * as protectionIndex from "./resource-protection-index";
import { snapshotPathIdentity, treeSnapshotPhysicalDir } from "./tree-snapshot-paths";
import { worktreeTreeSnapshot } from "./worktree-tree-snapshot";

test("production cold snapshot survives history beyond the former global inventory budget", async () => {
	if (process.env.NARRAFORK_TEST !== "1") throw new Error("Isolated database required");
	const root = await realpath(await mkdtemp(join(tmpdir(), "nf-protection-scale-")));
	const ids: string[] = [];
	try {
		await writeFile(join(root, "marker.txt"), "snapshot must remain available\n");
		for (let offset = 0; offset < 2500; offset += 50) {
			const rows = Array.from({ length: Math.min(50, 2500 - offset) }, () => {
				const id = generateId();
				ids.push(id);
				return {
					id,
					title: "historical workspace",
					cwd: join(root, "missing", id),
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				};
			});
			await db.insert(narrators).values(rows);
		}

		for (const deviceId of ["local", "remote-fixture"]) {
			const id = generateId();
			ids.push(id);
			await db.insert(narrators).values({
				id,
				title: "root cwd is a reference, not exclusive cache ownership",
				cwd: deviceId === "local" ? parse(root).root : "/",
				defaultDeviceId: deviceId,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			});
		}
		let ready = false;
		for (let page = 0; page < 128; page++) {
			await protectionIndex.maintainProtectionIndex(performance.now() + 2000);
			const incomplete = sqlite
				.query(`SELECT 1 FROM resource_protection_sources
				WHERE (source_id = '' AND complete = 0) OR (source_id != '' AND dirty = 1)
				LIMIT 1`)
				.get();
			if (!incomplete) {
				ready = true;
				break;
			}
		}
		expect(ready).toBe(true);
		// The two root-cwd controls are not missing historical directories. Require
		// every historical row to be indexed, with none forcing an alias-history scan.
		expect(
			sqlite
				.query<{ n: number; aliases: number }, []>(`SELECT count(*) AS n,
			coalesce(sum(p.alias_sensitive), 0) AS aliases
			FROM resource_protection_paths p JOIN narrators n ON n.id = p.source_id
			WHERE p.source = 'narrator' AND n.title = 'historical workspace'`)
				.get(),
		).toEqual({ n: 2500, aliases: 0 });
		expect(
			sqlite
				.query<{ n: number }, []>(`SELECT count(*) AS n
			FROM resource_protection_paths p JOIN narrators n ON n.id = p.source_id
			WHERE p.source = 'narrator' AND n.title = 'root cwd is a reference, not exclusive cache ownership'`)
				.get()?.n,
		).toBe(2);
		// Volume roots must also keep a stable identity, not become drive-relative aliases.
		expect(
			sqlite
				.query<{ n: number }, []>(`SELECT count(*) AS n FROM resource_protection_paths
			WHERE source = 'narrator' AND alias_sensitive = 1`)
				.get()?.n,
		).toBe(0);
		const heads = () =>
			sqlite
				.query(`SELECT source, revision, cursor, complete
			FROM resource_protection_sources WHERE source_id='' ORDER BY source`)
				.all();
		const before = heads();
		const readClaims = spyOn(protectionIndex, "readProtectionClaims").mockImplementation(
			async () => {
				throw new Error("Cold capture must not inspect global resource inventory");
			},
		);
		try {
			expect(await worktreeTreeSnapshot.tryCaptureHot(root)).toMatch(/^[a-f0-9]{40,64}$/);
			expect(readClaims).not.toHaveBeenCalled();
			expect(heads()).toEqual(before);
			expect(
				await db
					.select()
					.from(worktreeTreeSnapshots)
					.where(eq(worktreeTreeSnapshots.worktreePath, snapshotPathIdentity(root))),
			).toHaveLength(1);
		} finally {
			readClaims.mockRestore();
		}
	} finally {
		for (let offset = 0; offset < ids.length; offset += 50)
			await db.delete(narrators).where(inArray(narrators.id, ids.slice(offset, offset + 50)));
		await db
			.delete(worktreeTreeSnapshots)
			.where(eq(worktreeTreeSnapshots.worktreePath, snapshotPathIdentity(root)));
		await rm(treeSnapshotPhysicalDir("local", root), { recursive: true, force: true });
		await rm(root, { recursive: true, force: true });
	}
}, 30_000);

test("production journal handles idempotency and results without writing resource ownership", async () => {
	const narratorId = generateId();
	const requestId = generateId();
	const destination = getNarraforkPath("journal-conflict-fixture", narratorId);
	const filePath = getNarraforkPath(
		"worktree-requests-v2",
		`${createHash("sha256")
			.update(JSON.stringify([narratorId, requestId]))
			.digest("hex")}.json`,
	);
	const temporary = `${filePath}.00000000-0000-4000-8000-000000000000.pending`;
	const journal = new FileWorktreeJournal(
		getNarraforkPath("worktree-requests-v2"),
		getNarraforkPath("worktree-requests"),
	);
	const record: WorktreeJournalRecord = {
		proposalHash: "original-proposal",
		repositoryKey: "fixture-repository",
		destination,
		deviceId: "local",
		expectedHead: "a".repeat(40),
		request: {
			expectedRevision: 0,
			workspaceKey: "fixture",
			requestId,
			destinationPath: destination,
			branch: { kind: "new", name: "fixture" },
		},
	};
	const before = sqlite.query<{ n: number }, []>("SELECT total_changes() AS n").get()?.n;
	const snapshotRoot = await realpath(await mkdtemp(join(tmpdir(), "nf-journal-cold-snapshot-")));
	try {
		expect((await journal.claim(narratorId, requestId, record)).fresh).toBe(true);
		await expect(
			journal.claim(narratorId, requestId, {
				...record,
				proposalHash: "different-proposal",
				destination: `${destination}-different`,
			}),
		).rejects.toMatchObject({ code: "WORKTREE_REQUEST_CONFLICT" });
		// Replays use the existing canonical destination, not a new ownership intent.
		expect(
			await journal.claim(narratorId, requestId, {
				...record,
				destination: `${destination}-original-spelling`,
			}),
		).toEqual({ fresh: false, record });
		const finished: WorktreeJournalRecord = {
			...record,
			result: {
				outcome: "failed",
				worktree: null,
				residuals: { destinationExists: false, branchExists: false },
			},
		};
		await journal.save(narratorId, requestId, finished);
		expect(await journal.read(narratorId, requestId)).toEqual(finished);
		// A request interrupted during file save is not an instance-wide resource lock.
		await writeFile(temporary, "partial save");
		expect(sqlite.query<{ n: number }, []>("SELECT total_changes() AS n").get()?.n).toBe(before);
		await writeFile(join(snapshotRoot, "observed.txt"), "snapshot remains available\n");
		const readClaims = spyOn(protectionIndex, "readProtectionClaims").mockImplementation(
			async () => {
				throw new Error("Journal retry metadata must not become a snapshot inventory barrier");
			},
		);
		try {
			expect(await worktreeTreeSnapshot.capture(snapshotRoot)).toMatch(/^[a-f0-9]{40,64}$/);
			expect(readClaims).not.toHaveBeenCalled();
			expect(await journal.read(narratorId, requestId)).toEqual(finished);
		} finally {
			readClaims.mockRestore();
		}
		expect(
			sqlite
				.query(`SELECT 1 FROM resource_protection_sources
			WHERE source = 'receipt' AND source_id = ?`)
				.get(filePath),
		).toBeNull();
	} finally {
		await db
			.delete(worktreeTreeSnapshots)
			.where(eq(worktreeTreeSnapshots.worktreePath, snapshotPathIdentity(snapshotRoot)));
		await rm(treeSnapshotPhysicalDir("local", snapshotRoot), { recursive: true, force: true });
		await rm(snapshotRoot, { recursive: true, force: true });
		await rm(filePath, { force: true });
		await rm(temporary, { force: true });
	}
});

test("current journal replays legacy requests but never rewrites the legacy namespace", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "nf-journal-upgrade-")));
	const legacy = new FileWorktreeJournal(join(root, "legacy"));
	const current = new FileWorktreeJournal(join(root, "current"), join(root, "legacy"));
	const record: WorktreeJournalRecord = {
		proposalHash: "legacy-proposal",
		repositoryKey: "repo",
		destination: join(root, "workspace"),
		expectedHead: "a".repeat(40),
		request: {
			expectedRevision: 0,
			workspaceKey: "fixture",
			requestId: "old-request",
			destinationPath: join(root, "workspace"),
			branch: { kind: "new", name: "fixture" },
		},
	};
	try {
		await legacy.claim("actor", "old-request", record);
		expect(await current.claim("actor", "old-request", record)).toEqual({ fresh: false, record });
		await expect(
			current.claim("actor", "old-request", {
				...record,
				proposalHash: "different-proposal",
			}),
		).rejects.toMatchObject({ code: "WORKTREE_REQUEST_CONFLICT" });
		const updated: WorktreeJournalRecord = {
			...record,
			result: {
				outcome: "unknown",
				worktree: null,
				residuals: { destinationExists: true, branchExists: true },
			},
		};
		await current.save("actor", "old-request", updated);
		expect(await current.read("actor", "old-request")).toEqual(updated);
		expect(await legacy.read("actor", "old-request")).toEqual(record);
		expect((await current.claim("actor", "new-request", record)).fresh).toBe(true);
		expect(await legacy.read("actor", "new-request")).toBeNull();
		const currentFile = join(
			root,
			"current",
			`${createHash("sha256")
				.update(JSON.stringify(["actor", "old-request"]))
				.digest("hex")}.json`,
		);
		for (const damaged of ["null", "false", "0", '""', "[]"]) {
			await writeFile(currentFile, damaged);
			await expect(current.read("actor", "old-request")).rejects.toThrow(
				"Invalid worktree receipt",
			);
			await expect(current.claim("actor", "old-request", record)).rejects.toThrow(
				"Invalid worktree receipt",
			);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("real startup resumes legacy import after a process exits without manual maintenance", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "nf-protection-startup-")));
	const home = join(root, "home");
	const directory = join(home, "worktree-requests");
	await mkdir(directory, { recursive: true });
	const target = join(root, "workspace-128");
	try {
		for (let i = 0; i < 129; i++) {
			await writeFile(
				join(directory, `${i.toString(16).padStart(64, "0")}.json`),
				JSON.stringify({
					destination: join(root, `workspace-${i}`),
					repositoryKey: "startup-repository",
				}),
			);
		}
		const script = `
			const { sqlite, markDatabaseCleanShutdown, releaseDatabaseInstanceLockOnly } = await import("./server/db/index.ts");
			const { canonicalProtectionPath, readProtectionClaims } = await import("./server/services/resource-protection-index.ts");
			const phase = process.env.PROTECTION_STARTUP_PHASE;
			const deadline = Date.now() + 20000;
			while (Date.now() < deadline) {
				const progress = sqlite.query("SELECT complete FROM resource_protection_sources WHERE source = 'receipt' AND source_id = ''").get();
				const pins = sqlite.query("SELECT source_id FROM resource_protection_paths WHERE source = 'receipt' LIMIT 130").all();
				if (phase === "interrupt" && pins.length > 0 && !progress.complete) {
					console.log("STARTUP_RESULT " + JSON.stringify({ interrupted: true, pins: pins.length }));
					releaseDatabaseInstanceLockOnly();
					sqlite.close();
					process.exit(0);
				}
				if (phase === "resume" && progress.complete) {
					const target = await canonicalProtectionPath(process.env.PROTECTION_STARTUP_TARGET);
					const result = await readProtectionClaims([{ path: target }], performance.now() + 5000);
					let protectedTarget = false;
					for await (const claim of result.claims) if (claim.kind === "receipt") protectedTarget = true;
					console.log("STARTUP_RESULT " + JSON.stringify({ complete: result.complete, pins: pins.length, protectedTarget }));
					markDatabaseCleanShutdown();
					sqlite.close();
					process.exit(0);
				}
				await Bun.sleep(20);
			}
			throw new Error("Automatic protection maintenance did not reach the expected startup phase");
		`;
		const run = async (phase: string) => {
			const result = await safeSpawn({
				cmd: [process.execPath, "--eval", script],
				cwd: process.cwd(),
				env: {
					...process.env,
					NARRAFORK_HOME: home,
					NARRAFORK_TEST: "0",
					NF_DATABASE_BACKEND: "sqlite",
					NARRAFORK_ALLOW_MULTIPLE: "0",
					NARRAFORK_FORCE_UNLOCK: "0",
					PROTECTION_STARTUP_PHASE: phase,
					PROTECTION_STARTUP_TARGET: target,
				},
				timeout: 25_000,
				maxOutputBytes: 64 * 1024,
			});
			if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
			expect(result.stdoutTruncated).toBeFalsy();
			const line = result.stdout.split("\n").find((value) => value.startsWith("STARTUP_RESULT "));
			if (!line) throw new Error("Startup fixture did not report its result");
			return JSON.parse(line.slice("STARTUP_RESULT ".length));
		};
		expect(await run("interrupt")).toMatchObject({ interrupted: true });
		expect(await run("resume")).toEqual({ complete: true, pins: 129, protectedTarget: true });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 60_000);
