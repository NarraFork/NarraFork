import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import { chmod, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse, resolve } from "node:path";
import {
	initializeAbsentReceiptProtectionSource,
	installResourceProtectionTriggers,
	receiptProjectionPrefix,
} from "../db/resource-protection-index";
import type { WorktreeJournalRecord } from "./narrator-worktree-journal";
import {
	canonicalProtectionPath,
	createResourceProtectionIndex,
} from "./resource-protection-index";
import {
	legacyTreeSnapshotPhysicalDir,
	treeSnapshotKey,
	treeSnapshotPhysicalDir,
} from "./tree-snapshot-paths";
import {
	createLifecycleGuard,
	type LifecycleTarget,
	type ResourceClaim,
} from "./worktree-lifecycle-guard";

let database: Database;
let root: string;
let receipts: string;
let service: ReturnType<typeof createResourceProtectionIndex>;
const deadline = () => performance.now() + 15_000;
function changes() {
	return (database.query("SELECT total_changes() AS n").get() as { n: number }).n;
}
async function collectClaims(
	result: Awaited<ReturnType<typeof service.read>>,
): Promise<ResourceClaim[]> {
	if (!result.complete) throw new Error("incomplete");
	const resultClaims: ResourceClaim[] = [];
	for await (const claim of result.claims) resultClaims.push(claim);
	return resultClaims;
}
async function claims(
	targets: LifecycleTarget[],
	includeLegacyReceipts = true,
): Promise<ResourceClaim[]> {
	// The index consumes comparison identities already canonicalized by its guard.
	const canonicalTargets = await Promise.all(
		targets.map(async (target) => ({
			...target,
			...(target.path && (target.deviceId ?? "local") === "local"
				? { path: await canonicalProtectionPath(target.path) }
				: {}),
		})),
	);
	return collectClaims(
		await service.read(canonicalTargets, deadline(), undefined, includeLegacyReceipts),
	);
}
async function bootstrap() {
	for (let attempt = 0; attempt < 1000; attempt++) {
		await service.maintain(deadline());
		const pending = database
			.query(
				"SELECT 1 FROM resource_protection_sources WHERE (source_id = '' AND complete = 0) OR dirty = 1 LIMIT 1",
			)
			.get();
		if (!pending) return;
	}
	throw new Error("Bootstrap never completed");
}
function narrator(id: string, path: string, context?: object) {
	database
		.query("INSERT INTO narrators (id, cwd, workspace_context) VALUES (?, ?, ?)")
		.run(id, path, context ? JSON.stringify(context) : null);
}
function registry(id: string, path: string, project: string | null = null, device = "local") {
	database
		.query(`INSERT INTO narrator_worktree_resources
		(id, device_id, worktree_path, repository_key, scope_project_id, state) VALUES (?, ?, ?, ?, ?, 'ready')`)
		.run(id, device, path, `repo-${id}`, project);
}
function receipt(destination: string): WorktreeJournalRecord {
	return { destination, repositoryKey: "receipt-repository" } as WorktreeJournalRecord;
}

beforeEach(async () => {
	root = await canonicalProtectionPath(await mkdtemp(join(tmpdir(), "nf-protection-index-")));
	receipts = join(root, "worktree-requests");
	database = new Database(":memory:");
	database.exec(`
		CREATE TABLE narrators(id TEXT PRIMARY KEY, cwd TEXT, default_device_id TEXT,
			workspace_context TEXT, workspace_revision INTEGER NOT NULL DEFAULT 0, title TEXT);
		CREATE TABLE narrator_worktree_resources(id TEXT PRIMARY KEY, device_id TEXT NOT NULL,
			worktree_path TEXT NOT NULL, repository_key TEXT NOT NULL, scope_project_id TEXT, state TEXT, owner_narrator_id TEXT);
		CREATE TABLE resource_protection_sources(source TEXT NOT NULL, source_id TEXT NOT NULL,
			revision INTEGER NOT NULL DEFAULT 1, dirty INTEGER NOT NULL DEFAULT 1, cursor TEXT,
			complete INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(source, source_id));
		CREATE INDEX idx_protection_dirty ON resource_protection_sources(dirty, source, source_id);
		CREATE TABLE resource_protection_paths(source TEXT NOT NULL, source_id TEXT NOT NULL, slot INTEGER NOT NULL,
			device_id TEXT NOT NULL, canonical_path TEXT, repository_key TEXT, shadow_key TEXT, scope_project_id TEXT,
			alias_sensitive INTEGER NOT NULL DEFAULT 0, claim_json TEXT NOT NULL, PRIMARY KEY(source, source_id, slot));
		CREATE INDEX idx_protection_path ON resource_protection_paths(device_id, canonical_path, source, source_id, slot);
		CREATE INDEX idx_protection_repository ON resource_protection_paths(device_id, repository_key, source, source_id, slot);
		CREATE INDEX idx_protection_shadow ON resource_protection_paths(shadow_key, source, source_id, slot);
		CREATE INDEX idx_protection_scope ON resource_protection_paths(scope_project_id, source, source_id, slot);
		CREATE INDEX idx_protection_alias ON resource_protection_paths(alias_sensitive, source, source_id, slot);
	`);
	installResourceProtectionTriggers(database);
	service = createResourceProtectionIndex(database, receipts);
});
afterEach(async () => {
	database.close();
	await rm(root, { recursive: true, force: true });
});

describe("absent legacy namespace startup", () => {
	function receiptHead() {
		return database
			.query(`SELECT cursor, complete FROM resource_protection_sources
			WHERE source = 'receipt' AND source_id = ''`)
			.get();
	}
	test("an absent namespace is ready before the first zero-write read", async () => {
		initializeAbsentReceiptProtectionSource(database, receipts);
		expect(receiptHead()).toEqual({ cursor: "eof", complete: 1 });
		narrator("n", root);
		const before = changes();
		expect((await claims([{ path: root }])).some((claim) => claim.id === "n")).toBe(true);
		expect(changes()).toBe(before);
		initializeAbsentReceiptProtectionSource(database, receipts);
		expect(changes()).toBe(before);
	});
	test("an existing directory or dangling namespace symlink is not absent", async () => {
		await mkdir(receipts);
		initializeAbsentReceiptProtectionSource(database, receipts);
		expect(receiptHead()).toEqual({ cursor: null, complete: 0 });
		await rm(receipts, { recursive: true });
		await symlink(join(root, "missing"), receipts);
		initializeAbsentReceiptProtectionSource(database, receipts);
		expect(receiptHead()).toEqual({ cursor: null, complete: 0 });
	});
	test("filesystem access errors leave bootstrap incomplete without writes", () => {
		const stat = spyOn(fsSync, "lstatSync").mockImplementation(() => {
			throw Object.assign(new Error("access denied"), { code: "EACCES" });
		});
		try {
			const before = changes();
			initializeAbsentReceiptProtectionSource(database, receipts);
			expect(stat).toHaveBeenCalledWith(receipts);
			expect(receiptHead()).toEqual({ cursor: null, complete: 0 });
			expect(changes()).toBe(before);
		} finally {
			stat.mockRestore();
		}
	});
	test("a missing namespace cannot bypass an already dirty legacy receipt", async () => {
		database
			.query(`INSERT INTO resource_protection_sources(source, source_id)
			VALUES ('receipt', ?)`)
			.run(join(receipts, "unimported.json"));
		const before = changes();
		initializeAbsentReceiptProtectionSource(database, receipts);
		expect(receiptHead()).toEqual({ cursor: null, complete: 0 });
		expect((await service.read([{ path: root }], deadline())).complete).toBe(false);
		expect(changes()).toBe(before);
	});
	test("clean durable pins survive absent-namespace initialization", async () => {
		await mkdir(receipts);
		await writeFile(join(receipts, `${"a".repeat(64)}.json`), JSON.stringify(receipt(root)));
		await bootstrap();
		const pins = database
			.query("SELECT * FROM resource_protection_paths WHERE source='receipt'")
			.all();
		expect(pins).toHaveLength(1);
		await rm(receipts, { recursive: true });
		database
			.query(`UPDATE resource_protection_sources SET complete = 0
			WHERE source = 'receipt' AND source_id = ''`)
			.run();
		initializeAbsentReceiptProtectionSource(database, receipts);
		expect(receiptHead()).toEqual({ cursor: "eof", complete: 1 });
		expect(
			database.query("SELECT * FROM resource_protection_paths WHERE source='receipt'").all(),
		).toEqual(pins);
		expect((await claims([{ path: root }])).some((claim) => claim.kind === "receipt")).toBe(true);
	});
});

describe("resource protection reverse index", () => {
	test("small fresh inventory is proved in memory with zero writes", async () => {
		narrator("n", root);
		const before = changes();
		expect((await claims([{ path: root }], false)).some((claim) => claim.id === "n")).toBe(true);
		expect(changes()).toBe(before);
		expect(
			database
				.query(
					"SELECT complete FROM resource_protection_sources WHERE source='narrator' AND source_id=''",
				)
				.get(),
		).toEqual({ complete: 0 });
	});
	test("trigger actual-field changes, raw SQL delete and rollback stay transactionally correct", async () => {
		narrator("n", root);
		await bootstrap();
		const before = database
			.query(
				"SELECT revision, dirty FROM resource_protection_sources WHERE source='narrator' AND source_id='n'",
			)
			.get();
		database.query("UPDATE narrators SET title = 'unrelated', cwd = cwd WHERE id = 'n'").run();
		expect(
			database
				.query(
					"SELECT revision, dirty FROM resource_protection_sources WHERE source='narrator' AND source_id='n'",
				)
				.get(),
		).toEqual(before);
		database.exec("BEGIN");
		database.query("UPDATE narrators SET cwd = ? WHERE id = 'n'").run(join(root, "new"));
		database.exec("ROLLBACK");
		expect(
			database
				.query(
					"SELECT revision, dirty FROM resource_protection_sources WHERE source='narrator' AND source_id='n'",
				)
				.get(),
		).toEqual(before);
		database.query("UPDATE narrators SET cwd = ? WHERE id = 'n'").run(join(root, "new"));
		const total = changes();
		expect((await claims([{ path: join(root, "new") }])).some((claim) => claim.id === "n")).toBe(
			true,
		);
		expect(changes()).toBe(total);
		database.query("DELETE FROM narrators WHERE id = 'n'").run();
		expect(await claims([{ path: root }])).toEqual([]);
	});
	test("reinstallation replaces stale trigger definitions without resetting source state", async () => {
		narrator("n", root);
		await bootstrap();
		const before = database
			.query(`SELECT revision, dirty FROM resource_protection_sources
			WHERE source = 'narrator' AND source_id = 'n'`)
			.get();
		database.exec(`DROP TRIGGER resource_protection_narrator_update;
			CREATE TRIGGER resource_protection_narrator_update AFTER UPDATE ON narrators
			BEGIN SELECT 1; END;`);
		installResourceProtectionTriggers(database);
		expect(
			database
				.query(`SELECT revision, dirty FROM resource_protection_sources
			WHERE source = 'narrator' AND source_id = 'n'`)
				.get(),
		).toEqual(before);
		database.query("UPDATE narrators SET cwd = ? WHERE id = 'n'").run(join(root, "new"));
		expect((await claims([{ path: join(root, "new") }])).some((claim) => claim.id === "n")).toBe(
			true,
		);
		expect(
			database
				.query<{ dirty: number }, []>(`SELECT dirty FROM resource_protection_sources
			WHERE source = 'narrator' AND source_id = 'n'`)
				.get()?.dirty,
		).toBe(1);
	});

	test("scope is independent of device; owner deletion does not delete registry evidence", async () => {
		registry("r", "/remote/path", "project", "remote-device");
		database
			.query("UPDATE narrator_worktree_resources SET owner_narrator_id = NULL WHERE id = 'r'")
			.run();
		await bootstrap();
		expect(
			(await claims([{ scopeProjectId: "project", deviceId: "local" }])).map((claim) => claim.id),
		).toContain("r");
		expect(await claims([{ path: root }])).toEqual([]);
	});
	test("legacy device/revision and repository claims remain intact", async () => {
		narrator("n", root, { cwd: root, deviceId: "local", git: { repositoryKey: "rk" } });
		await bootstrap();
		const found = await claims([{ path: root }]);
		expect(found.some((claim) => claim.kind === "narrator" && claim.revision === 0)).toBe(true);
		expect((await claims([{ repositoryKey: "rk" }])).some((claim) => claim.id === "n")).toBe(true);
	});
	test("rows of the removed chapter source are purged in bounded maintenance pages", async () => {
		initializeAbsentReceiptProtectionSource(database, receipts);
		await bootstrap();
		const old = join(root, "old-chapter-checkout");
		const source =
			database.query(`INSERT INTO resource_protection_sources(source, source_id, dirty, complete)
			VALUES ('chapter', ?, 0, 1)`);
		const path = database.query(`INSERT INTO resource_protection_paths
			(source, source_id, slot, device_id, canonical_path, claim_json) VALUES ('chapter', ?, 0, 'local', ?, ?)`);
		source.run("");
		for (let i = 0; i < 130; i++) {
			const id = `chapter-${i.toString().padStart(3, "0")}`;
			source.run(id);
			path.run(id, old, JSON.stringify({ kind: "chapter", id, path: old }));
		}
		// Model the upgraded database at process start: the rows predate this index instance.
		service = createResourceProtectionIndex(database, receipts);
		const remaining = (table: string) =>
			(
				database.query(`SELECT count(*) AS n FROM ${table} WHERE source = 'chapter'`).get() as {
					n: number;
				}
			).n;
		await service.maintain(deadline());
		// One bounded page per pass, never one unbounded delete on the main thread.
		expect(remaining("resource_protection_paths")).toBe(130 - 64);
		expect(remaining("resource_protection_sources")).toBe(131 - 64);
		for (let pass = 0; pass < 3; pass++) await service.maintain(deadline());
		expect(remaining("resource_protection_paths")).toBe(0);
		expect(remaining("resource_protection_sources")).toBe(0);
		expect(await claims([{ path: old }])).toEqual([]);
	});
	test("guard-canonicalized parent aliases and native case identities reach fresh and clean claims without writes", async () => {
		const physical = join(root, "Physical-Root");
		const alias = join(root, "Visible-Alias");
		await mkdir(physical);
		await symlink(physical, alias, process.platform === "win32" ? "junction" : "dir");
		const raw = join(alias, "Checkout");
		await mkdir(raw);
		narrator("parent-alias", raw);
		const requested = process.platform === "win32" ? raw.toUpperCase() : raw;
		const canonical = await canonicalProtectionPath(requested);
		const read = spyOn(service, "read");
		try {
			const before = changes();
			expect(
				(await claims([{ path: requested }], false)).some(
					(claim) => claim.id === "parent-alias" && claim.path === raw,
				),
			).toBe(true);
			expect(read.mock.calls[0]?.[0]).toEqual([{ path: canonical }]);
			expect(changes()).toBe(before);
			await bootstrap();
			const warm = changes();
			expect(
				(await claims([{ path: requested }])).some(
					(claim) => claim.id === "parent-alias" && claim.path === raw,
				),
			).toBe(true);
			expect(read.mock.calls.at(-1)?.[0]).toEqual([{ path: canonical }]);
			expect(changes()).toBe(warm);
			expect(
				database
					.query(`SELECT canonical_path, alias_sensitive FROM resource_protection_paths
				WHERE source='narrator' AND source_id='parent-alias'`)
					.get(),
			).toEqual({ canonical_path: canonical, alias_sensitive: 1 });
		} finally {
			read.mockRestore();
		}
	});
	test("warm known aliases are revalidated without maintenance writes", async () => {
		const one = join(root, "one"),
			two = join(root, "two"),
			alias = join(root, "alias");
		await mkdir(one);
		await mkdir(two);
		await symlink(one, alias);
		narrator("alias", alias);
		await bootstrap();
		await rm(alias);
		await symlink(two, alias);
		const before = changes();
		expect((await claims([{ path: two }])).some((claim) => claim.id === "alias")).toBe(true);
		expect(changes()).toBe(before);
	});
	test("revision changes during canonicalization cannot publish stale clean rows", async () => {
		narrator("n", root);
		await bootstrap();
		database.query("UPDATE narrators SET cwd = ? WHERE id = 'n'").run(join(root, "intermediate"));
		const maintaining = service.maintain(deadline());
		database.query("UPDATE narrators SET cwd = ? WHERE id = 'n'").run(join(root, "new"));
		await maintaining;
		expect(
			database
				.query(
					"SELECT dirty FROM resource_protection_sources WHERE source='narrator' AND source_id='n'",
				)
				.get(),
		).toEqual({ dirty: 1 });
		expect(
			(await claims([{ path: join(root, "new") }])).some(
				(claim) => claim.path === join(root, "new"),
			),
		).toBe(true);
	});
	test("concurrent evidence mutation rejects final clear and expired/cancelled reads reject", async () => {
		await bootstrap();
		const result = await service.read([{ path: root }], deadline());
		narrator("later", root);
		await expect(
			(async () => {
				for await (const _claim of result.claims) {
					/* exhaust proof */
				}
			})(),
		).rejects.toThrow("changed during inspection");
		await expect(service.read([{ path: root }], performance.now() - 1)).rejects.toThrow();
		await expect(service.read([{ path: root }], deadline(), AbortSignal.abort())).rejects.toThrow();
	});
	test("unrelated writes do not invalidate clear; index publication does", async () => {
		narrator("n", root);
		await bootstrap();
		const unrelated = [{ path: await canonicalProtectionPath(join(root, "..", "unrelated")) }];
		const result = await service.read(unrelated, deadline());
		database.query("UPDATE narrators SET title='chat only' WHERE id='n'").run();
		const found: ResourceClaim[] = [];
		for await (const claim of result.claims) found.push(claim);
		expect(found).toEqual([]);
		database.query("UPDATE narrators SET cwd=? WHERE id='n'").run(join(root, "new"));
		const publishing = await service.read(unrelated, deadline());
		await service.maintain(deadline());
		await expect(
			(async () => {
				for await (const _claim of publishing.claims) {
					/* exhaust proof */
				}
			})(),
		).rejects.toThrow("changed during inspection");
	});
	test("idle maintenance performs no writes and missing ordinary paths are not volatile aliases", async () => {
		for (let i = 0; i < 1100; i++) narrator(`missing-${i}`, join(root, `absent-${i}`));
		await bootstrap();
		expect(
			database
				.query("SELECT count(*) AS n FROM resource_protection_paths WHERE alias_sensitive=1")
				.get(),
		).toEqual({ n: 0 });
		const before = changes();
		await service.maintain(deadline());
		expect(changes()).toBe(before);
		expect(await claims([{ path: join(root, "unrelated") }])).toEqual([]);
	});
	test("descendant keyset pages follow path index order and equal-key lookups retain null paths", async () => {
		for (let i = 0; i < 150; i++)
			registry(`r${String(149 - i).padStart(3, "0")}`, join(root, String(i).padStart(3, "0")));
		registry("no-path", "", "scope-without-path");
		await bootstrap();
		const descendants = await claims([{ path: root }]);
		expect(new Set(descendants.map((claim) => claim.id)).size).toBe(150);
		expect(
			(await claims([{ scopeProjectId: "scope-without-path" }])).map((claim) => claim.id),
		).toEqual(["no-path"]);
		expect((await claims([{ repositoryKey: "repo-no-path" }])).map((claim) => claim.id)).toEqual([
			"no-path",
		]);
	});
	test("raw empty workspace_context remains malformed JSON instead of an empty inventory", async () => {
		narrator("empty-context", root);
		database.query("UPDATE narrators SET workspace_context='' WHERE id='empty-context'").run();
		await expect(claims([{ path: join(root, "unrelated") }], false)).rejects.toThrow();
	});
	test("oversized raw legacy scalars reject before entering the JavaScript projection", async () => {
		registry("large", "x".repeat(200_000));
		await expect(claims([{ path: root }], false)).rejects.toThrow("row budget");
	});
	test("uninitialised inventory beyond one page is never complete", async () => {
		for (let i = 0; i < 65; i++) registry(`r${i}`, root);
		expect((await service.read([{ path: root }], deadline())).complete).toBe(false);
		await bootstrap();
		expect((await service.read([{ path: root }], deadline())).complete).toBe(true);
	});
	test("more than old row/byte limits stays queryable through targeted indexes", async () => {
		database.transaction(() => {
			for (let i = 0; i < 8500; i++)
				registry(`r${String(i).padStart(5, "0")}`, root, `project-${i}`);
		})();
		await bootstrap();
		const before = changes();
		expect((await claims([{ repositoryKey: "repo-r08499" }])).map((claim) => claim.id)).toEqual([
			"r08499",
		]);
		expect(await claims([{ path: join(root, "unrelated") }])).toHaveLength(8500); // all are ancestors, no artificial cap
		expect(changes()).toBe(before);
		for (const [where, args, expected] of [
			["device_id = ? AND canonical_path = ?", ["local", root], "idx_protection_path"],
			[
				"device_id = ? AND canonical_path >= ? AND canonical_path < ?",
				["local", `${root}/`, `${root}0`],
				"idx_protection_path",
			],
			[
				"device_id = ? AND repository_key = ?",
				["local", "repo-r08499"],
				"idx_protection_repository",
			],
			["scope_project_id = ?", ["project-8499"], "idx_protection_scope"],
			["shadow_key = ?", ["key"], "idx_protection_shadow"],
		] as const) {
			const pathOrder = where.includes("canonical_path >=");
			const order = pathOrder ? "canonical_path,source,source_id,slot" : "source,source_id,slot";
			const parameters = pathOrder ? "?,?,?,?" : "?,?,?";
			const cursor = pathOrder ? ["", "", "", -1] : ["", "", -1];
			const plan = database
				.query(`EXPLAIN QUERY PLAN SELECT source, source_id, slot, claim_json, canonical_path FROM resource_protection_paths WHERE ${where}
					AND (${order}) > (${parameters}) ORDER BY ${order} LIMIT 64`)
				.all(...args, ...cursor);
			expect(JSON.stringify(plan)).toContain(expected);
			expect(JSON.stringify(plan)).not.toContain("USE TEMP B-TREE");
		}
	}, 60_000);
	test("a slow first dirty item cannot starve the rest of a short page", async () => {
		const slow = join(root, "slow");
		narrator("a-slow", slow);
		narrator("z-fast", root);
		database.query("UPDATE resource_protection_sources SET complete=1 WHERE source_id=''").run();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<string>();
		const realpath = fs.realpath;
		const spy = spyOn(fs, "realpath").mockImplementation(((
			path: Parameters<typeof fs.realpath>[0],
		) => {
			if (path === slow) {
				entered.resolve();
				return release.promise;
			}
			return realpath(path);
		}) as typeof fs.realpath);
		try {
			const controller = new AbortController();
			const work = service.maintain(deadline(), controller.signal);
			await entered.promise;
			controller.abort();
			await expect(work).rejects.toThrow();
			await service.maintain(deadline());
			expect(
				database
					.query(
						"SELECT source_id, dirty FROM resource_protection_sources WHERE source='narrator' AND source_id!='' ORDER BY source_id",
					)
					.all(),
			).toEqual([
				{ source_id: "a-slow", dirty: 1 },
				{ source_id: "z-fast", dirty: 0 },
			]);
		} finally {
			release.resolve(slow);
			spy.mockRestore();
		}
	});
	test("raw candidate pages stay bounded with many dirty same-path aliases; actual plans never temp-sort", async () => {
		const owned = join(root, "owned"),
			alias = join(root, "alias");
		await mkdir(owned);
		await symlink(owned, alias);
		for (let i = 0; i < 240; i++) narrator(`dirty-${String(i).padStart(3, "0")}`, alias);
		narrator("z-keeper", alias);
		await bootstrap();
		database
			.query("UPDATE narrators SET cwd = ? WHERE id != 'z-keeper'")
			.run(join(root, "elsewhere"));
		const pages: { sql: string; args: unknown[]; size: number }[] = [];
		const query = database.query.bind(database);
		const spy = spyOn(database, "query").mockImplementation(((sql: string) => {
			const statement = query(sql);
			if (!/^SELECT source, source_id, slot, canonical_path/.test(sql)) return statement;
			return new Proxy(statement, {
				get(target, property) {
					if (property === "all")
						return (...args: never[]) => {
							const rows = target.all(...args);
							pages.push({ sql, args, size: rows.length });
							return rows;
						};
					const value = Reflect.get(target, property, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
		}) as typeof database.query);
		const before = changes();
		try {
			expect(new Set((await claims([{ path: owned }])).map((claim) => claim.id))).toEqual(
				new Set(["z-keeper"]),
			);
		} finally {
			spy.mockRestore();
		}
		expect(changes()).toBe(before);
		expect(pages.filter((page) => page.size === 64).length).toBeGreaterThanOrEqual(6);
		for (const page of pages) {
			expect(page.size).toBeLessThanOrEqual(64);
			expect(page.args.at(-1)).toBe(64);
			expect(page.sql).not.toMatch(/NOT EXISTS|JOIN|dirty/i);
			const plan = JSON.stringify(
				query(`EXPLAIN QUERY PLAN ${page.sql}`).all(...(page.args as never[])),
			);
			expect(plan).toContain(
				page.sql.includes("alias_sensitive") ? "idx_protection_alias" : "idx_protection_path",
			);
			expect(plan).not.toContain("USE TEMP B-TREE");
		}
	});
});

describe("device ownership and native path identities", () => {
	for (const path of ["/", "/remote/linux/workspace", "C:\\Remote\\Workspace"])
		test(`committed remote context never invents local ownership for ${path}`, async () => {
			narrator("remote", path, {
				cwd: path,
				deviceId: "remote-device",
				pathFlavor: path.startsWith("/") ? "posix" : "windows",
				revision: 4,
				git: { repositoryKey: "remote-repository" },
			});
			database.query("UPDATE narrators SET workspace_revision=4 WHERE id='remote'").run();
			const localTargets = [{ path: root }, { path: await canonicalProtectionPath(resolve("/")) }];
			const realpath = spyOn(fs, "realpath").mockImplementation(async () => {
				throw new Error("Remote cwd must not touch the host filesystem");
			});
			try {
				const before = changes();
				for (const target of localTargets)
					expect(
						await collectClaims(await service.read([target], deadline(), undefined, false)),
					).toEqual([]);
				const remote = await claims([{ deviceId: "remote-device", path }], false);
				expect(remote.length).toBeGreaterThan(0);
				expect(
					remote.every((claim) => claim.deviceId === "remote-device" && claim.revision === 4),
				).toBe(true);
				expect(changes()).toBe(before);
				await bootstrap();
				for (const target of localTargets)
					expect(await collectClaims(await service.read([target], deadline()))).toEqual([]);
				expect(
					(await claims([{ deviceId: "remote-device", repositoryKey: "remote-repository" }])).map(
						(claim) => claim.id,
					),
				).toEqual(["remote"]);
				expect(realpath).not.toHaveBeenCalled();
			} finally {
				realpath.mockRestore();
			}
		});
	test("an explicit default device owns pre-context cwd without inventing a local root", async () => {
		narrator("pre-context", "/");
		database
			.query("UPDATE narrators SET default_device_id='remote-device' WHERE id='pre-context'")
			.run();
		await bootstrap();
		expect(await claims([{ path: root }])).toEqual([]);
		expect(await claims([{ path: "/" }])).toEqual([]);
		const found = await claims([{ deviceId: "remote-device", path: "/" }]);
		expect(found.map((claim) => claim.id)).toEqual(["pre-context"]);
		expect(found.every((claim) => claim.deviceId === "remote-device")).toBe(true);
	});
	for (const cwd of [".", "/"]) {
		test(`remote default cannot prove a context's absent device even when cwd matches: ${cwd}`, async () => {
			narrator("ambiguous", cwd, { cwd });
			database
				.query("UPDATE narrators SET default_device_id='remote-device' WHERE id='ambiguous'")
				.run();
			const before = changes();
			await expect(claims([{ path: root }], false)).rejects.toThrow(
				"Legacy context device is unverifiable",
			);
			expect(changes()).toBe(before);
			await service.maintain(deadline());
			expect(
				database
					.query(`SELECT dirty FROM resource_protection_sources
				WHERE source='narrator' AND source_id='ambiguous'`)
					.get(),
			).toEqual({ dirty: 1 });
			await expect(claims([{ deviceId: "remote-device", path: cwd }], false)).rejects.toThrow(
				"unverifiable",
			);
		});
	}
	for (const remoteCwd of ["./remote-context", "/remote/workspace", "C:\\Remote\\Workspace"])
		test(`a distinct legacy remote context retains the previous absolute host owner: ${remoteCwd}`, async () => {
			const host = join(root, "previous-host-workspace");
			const context = { cwd: remoteCwd, deviceId: "remote-device", revision: 3 };
			narrator("legacy-switched", host, context);
			database
				.query(`UPDATE narrators SET default_device_id='remote-device', workspace_revision=3
			WHERE id='legacy-switched'`)
				.run();
			const before = changes();
			expect(await claims([{ path: host }], false)).toEqual([
				{
					kind: "narrator",
					id: "legacy-switched",
					revision: 3,
					deviceId: "local",
					path: host,
				},
			]);
			expect(
				(await claims([{ deviceId: "remote-device", path: context.cwd }], false)).map(
					(claim) => claim.path,
				),
			).toEqual([context.cwd]);
			expect(changes()).toBe(before);
			await bootstrap();
			expect((await claims([{ path: host }])).map((claim) => claim.deviceId)).toEqual(["local"]);
			expect(await claims([{ path: parse(host).root }])).toHaveLength(1); // Probe the host's drive, not the runner cwd's drive.
			expect(
				database
					.query(
						"SELECT cwd, default_device_id, workspace_context FROM narrators WHERE id='legacy-switched'",
					)
					.get(),
			).toEqual({
				cwd: host,
				default_device_id: "remote-device",
				workspace_context: JSON.stringify(context),
			});
		});
	test("a committed context device wins over a stale default without a fabricated local claim", async () => {
		narrator("remote", root, { cwd: "/", deviceId: "context-device" });
		database.query("UPDATE narrators SET default_device_id='stale-device' WHERE id='remote'").run();
		await bootstrap();
		expect(await claims([{ path: root }])).toEqual([]);
		expect(await claims([{ deviceId: "stale-device", path: root }])).toEqual([]);
		expect((await claims([{ deviceId: "context-device", path: "/" }])).length).toBeGreaterThan(0);
	});
	test("genuine local legacy and relative cwd keep the null-device contract", async () => {
		narrator("legacy", root);
		narrator("relative", "relative-local-workspace");
		await bootstrap();
		expect((await claims([{ path: root }])).map((claim) => claim.id)).toEqual(["legacy"]);
		const relative = await claims([{ path: resolve("relative-local-workspace") }]);
		expect(relative).toEqual([
			{
				kind: "narrator",
				id: "relative",
				revision: 0,
				deviceId: "local",
				path: resolve("relative-local-workspace"),
			},
		]);
	});
	test.skipIf(process.platform === "win32")(
		"POSIX backslash components remain distinct without alias churn",
		async () => {
			const literal = join(root, "repository\\checkout");
			const separators = join(root, "repository", "checkout");
			await mkdir(literal);
			narrator("literal", literal);
			await bootstrap();
			expect(await canonicalProtectionPath(literal)).toBe(literal);
			expect((await claims([{ path: literal }])).map((claim) => claim.id)).toEqual(["literal"]);
			expect(await claims([{ path: separators }])).toEqual([]);
			expect((await claims([{ path: root }])).map((claim) => claim.id)).toEqual(["literal"]);
			expect(
				database
					.query(`SELECT canonical_path, alias_sensitive FROM resource_protection_paths
			WHERE source = 'narrator' AND source_id = 'literal'`)
					.get(),
			).toEqual({
				canonical_path: literal,
				alias_sensitive: 0,
			});
			const before = changes();
			await service.maintain(deadline());
			expect(changes()).toBe(before);
		},
	);
});

describe("persisted projection upgrades", () => {
	function oldProjection() {
		database.exec(`DROP TRIGGER resource_protection_narrator_insert;
			CREATE TRIGGER resource_protection_narrator_insert AFTER INSERT ON narrators
			BEGIN SELECT 1; END;`);
	}
	function localPaths() {
		return (
			database
				.query(`SELECT count(*) AS n FROM resource_protection_paths
			WHERE source = 'narrator' AND device_id = 'local'`)
				.get() as { n: number }
		).n;
	}
	async function receiptProjectionFixture(count: number, dirty: readonly number[] = []) {
		await bootstrap();
		await mkdir(receipts);
		const files: string[] = [];
		const paths: string[] = [];
		for (let i = 0; i < count; i++) {
			const file = join(receipts, `${i.toString(16).padStart(64, "0")}.json`);
			const path = join(root, `pin-${i.toString().padStart(3, "0")}`);
			files.push(file);
			paths.push(path);
			await mkdir(path);
			await writeFile(join(path, "history.bin"), `history-${i}`);
			database
				.query(`INSERT INTO resource_protection_sources(source, source_id, dirty)
				VALUES ('receipt', ?, ?)`)
				.run(file, dirty.includes(i) ? 1 : 0);
			if (dirty.includes(i)) {
				await writeFile(file, JSON.stringify(receipt(path)));
			} else {
				database
					.query(`INSERT INTO resource_protection_paths
					(source, source_id, slot, device_id, canonical_path, claim_json)
					VALUES ('receipt', ?, 0, 'local', ?, ?)`)
					.run(
						file,
						join(root, `old-${i}`),
						JSON.stringify({
							kind: "receipt",
							id: file,
							deviceId: "local",
							path,
							repositoryKey: "historical-repository",
						}),
					);
			}
		}
		database
			.query(`UPDATE resource_protection_sources SET cursor='eof', complete=?
			WHERE source='receipt' AND source_id=''`)
			.run(dirty.length ? 0 : 1);
		oldProjection();
		installResourceProtectionTriggers(database);
		service = createResourceProtectionIndex(database, receipts);
		const progress = () =>
			database
				.query(`SELECT cursor, complete FROM resource_protection_sources
			WHERE source='receipt' AND source_id=''`)
				.get() as { cursor: string; complete: number };
		return { files, paths, progress };
	}
	test("old clean local ghosts are ignored immediately and reprojected without rewriting business rows", async () => {
		narrator("remote", "/", { cwd: "/", deviceId: "remote-device", revision: 1 });
		database
			.query("UPDATE narrators SET default_device_id='remote-device', workspace_revision=1")
			.run();
		registry("registry-evidence", join(root, "retained"));
		await bootstrap();
		database
			.query(`UPDATE resource_protection_paths SET device_id='local', canonical_path='/', claim_json=?
			WHERE source='narrator'`)
			.run(JSON.stringify({ kind: "narrator", id: "remote", deviceId: "local", path: "/" }));
		const business = database.query("SELECT * FROM narrators").all();
		const registryEvidence = database.query("SELECT * FROM narrator_worktree_resources").all();
		const paths = database.query("SELECT * FROM resource_protection_paths").all();
		oldProjection();
		const before = changes();
		installResourceProtectionTriggers(database);
		expect(changes() - before).toBeLessThanOrEqual(3); // Fixed heads only, never historical row UPDATE.
		expect(database.query("SELECT * FROM resource_protection_paths").all()).toEqual(paths);
		service = createResourceProtectionIndex(database, receipts);
		const reading = changes();
		expect(await claims([{ path: join(root, "unrelated") }], false)).toEqual([]);
		expect(
			(await claims([{ deviceId: "remote-device", path: "/" }], false)).length,
		).toBeGreaterThan(0);
		expect(changes()).toBe(reading);
		await bootstrap();
		expect(localPaths()).toBe(0);
		expect(await claims([{ path: join(root, "unrelated") }])).toEqual([]);
		expect(database.query("SELECT * FROM narrators").all()).toEqual(business);
		expect(database.query("SELECT * FROM narrator_worktree_resources").all()).toEqual(
			registryEvidence,
		);
		service = createResourceProtectionIndex(database, receipts);
		const idle = changes();
		installResourceProtectionTriggers(database);
		await service.maintain(deadline());
		expect(changes()).toBe(idle);
	});
	test("reprojection advances only 64 existing clean rows per pass and resumes after restart", async () => {
		for (let i = 0; i < 130; i++) {
			const id = `remote-${i.toString().padStart(3, "0")}`;
			narrator(id, "/");
			database.query("UPDATE narrators SET default_device_id='remote-device' WHERE id=?").run(id);
		}
		await bootstrap();
		database
			.query(`UPDATE resource_protection_paths SET device_id='local', canonical_path='/'
			WHERE source='narrator'`)
			.run();
		oldProjection();
		installResourceProtectionTriggers(database);
		service = createResourceProtectionIndex(database, receipts);
		expect(localPaths()).toBe(130);
		const reading = changes();
		expect((await service.read([{ path: root }], deadline(), undefined, false)).complete).toBe(
			false,
		);
		expect(changes()).toBe(reading);
		await service.maintain(deadline());
		expect(localPaths()).toBe(66);
		const progress = database
			.query(`SELECT cursor, complete FROM resource_protection_sources
			WHERE source='narrator' AND source_id=''`)
			.get();
		expect(progress).toEqual({ cursor: "remote-063", complete: 0 });
		service = createResourceProtectionIndex(database, receipts);
		const restarting = changes();
		installResourceProtectionTriggers(database);
		expect(changes()).toBe(restarting);
		expect(
			database
				.query(`SELECT cursor, complete FROM resource_protection_sources
			WHERE source='narrator' AND source_id=''`)
				.get(),
		).toEqual(progress);
		await service.maintain(deadline());
		expect(localPaths()).toBe(2);
		await bootstrap();
		expect(localPaths()).toBe(0);
		expect(await claims([{ path: root }])).toEqual([]);
		expect(await claims([{ deviceId: "remote-device", path: "/" }])).toHaveLength(130);
	});
	test.skipIf(process.platform === "win32")(
		"upgrading an immutable v1 shadow pin preserves its old physical footprint and exact source JSON",
		async () => {
			await bootstrap();
			const logicalPath = join(root, "historical\\checkout");
			const oldPhysical = legacyTreeSnapshotPhysicalDir("local", logicalPath);
			const newPhysical = treeSnapshotPhysicalDir("local", logicalPath);
			expect(oldPhysical).not.toBe(newPhysical);
			await mkdir(oldPhysical, { recursive: true });
			await writeFile(join(oldPhysical, "history.bin"), Buffer.from([0, 255, 13, 10]));
			const file = join(receipts, `${"a".repeat(64)}.json`);
			const rawKey = `local\0${logicalPath}`;
			const rawJson = JSON.stringify(
				{
					kind: "receipt",
					id: file,
					deviceId: "local",
					repositoryKey: "historical-pin",
					shadowKey: rawKey,
				},
				null,
				2,
			);
			database
				.query(`INSERT INTO resource_protection_sources(source, source_id, dirty)
			VALUES ('receipt', ?, 0)`)
				.run(file);
			database
				.query(`INSERT INTO resource_protection_paths
			(source, source_id, slot, device_id, canonical_path, shadow_key, claim_json)
			VALUES ('receipt', ?, -1, 'local', ?, ?, ?)`)
				.run(file, oldPhysical, rawKey, rawJson);
			oldProjection();
			installResourceProtectionTriggers(database);
			service = createResourceProtectionIndex(database, receipts);
			await bootstrap();
			const projected = database
				.query(`SELECT slot, canonical_path, shadow_key, claim_json
			FROM resource_protection_paths WHERE source='receipt' AND source_id=? ORDER BY slot`)
				.all(file) as {
				slot: number;
				canonical_path: string;
				shadow_key: string | null;
				claim_json: string;
			}[];
			expect(projected).toHaveLength(2);
			expect(projected[0]).toEqual({
				slot: -1,
				canonical_path: newPhysical,
				shadow_key: treeSnapshotKey("local", logicalPath),
				claim_json: rawJson,
			});
			expect(projected[1]?.shadow_key).toBeNull();
			expect(JSON.parse(projected[1]?.claim_json ?? "null")).toMatchObject({
				kind: "receipt",
				id: file,
				deviceId: "local",
				path: oldPhysical,
			});
			const guard = createLifecycleGuard({
				canonicalPath: canonicalProtectionPath,
				readClaims: (budget, signal, targets) => service.read(targets ?? [], budget, signal),
			});
			for (const path of [oldPhysical, newPhysical])
				expect(await guard.inspect([{ path }], "historical shadow retirement")).toMatchObject({
					status: "protected",
					complete: true,
				});
			expect(await fs.readFile(join(oldPhysical, "history.bin"))).toEqual(
				Buffer.from([0, 255, 13, 10]),
			);
			oldProjection();
			installResourceProtectionTriggers(database);
			service = createResourceProtectionIndex(database, receipts);
			await bootstrap();
			expect(
				database
					.query(`SELECT slot, canonical_path, shadow_key, claim_json
			FROM resource_protection_paths WHERE source='receipt' AND source_id=? ORDER BY slot`)
					.all(file),
			).toEqual(projected);
			const before = changes();
			await service.maintain(deadline());
			expect(changes()).toBe(before);
		},
	);
	for (const interruption of ["deadline", "cancel"] as const) {
		test(`receipt reprojection commits interrupted page prefixes and eventually traverses 64+ pins: ${interruption}`, async () => {
			const { files, paths, progress } = await receiptProjectionFixture(70, [0, 37]);
			const attempts = new Map<string, number>();
			const ownedPaths = new Set(paths);
			const realpath = fs.realpath;
			let controller = new AbortController();
			let lookups = 0;
			const spy = spyOn(fs, "realpath").mockImplementation((async (path) => {
				if (typeof path === "string" && ownedPaths.has(path)) {
					attempts.set(path, (attempts.get(path) ?? 0) + 1);
					lookups++;
					if (interruption === "deadline") await Bun.sleep(20);
					else if (lookups === 18) controller.abort();
				}
				return realpath(path);
			}) as typeof fs.realpath);
			let interrupted = 0;
			let previous = -1;
			try {
				for (let pass = 0; pass < 8 && !progress().complete; pass++) {
					controller = new AbortController();
					lookups = 0;
					try {
						// The production per-pass budget stays 1s, with legal 20ms filesystem calls.
						await service.maintain(performance.now() + 1000, controller.signal);
					} catch (error) {
						expect(String(error)).toMatch(
							/Protection index (?:budget exceeded|deadline|cancelled)/,
						);
						interrupted++;
					}
					const head = progress();
					const after = head.cursor.startsWith(receiptProjectionPrefix)
						? files.indexOf(JSON.parse(head.cursor.slice(receiptProjectionPrefix.length)).after)
						: files.length;
					expect(after).toBeGreaterThanOrEqual(previous);
					if (pass === 0) {
						expect(interrupted).toBe(1);
						expect(after).toBeGreaterThan(0);
						expect(after).toBeLessThan(files.length - 1);
						expect(
							database
								.query(`SELECT dirty FROM resource_protection_sources
							WHERE source='receipt' AND source_id=?`)
								.get(files[0]),
						).toEqual({ dirty: 1 });
						// A new instance must resume the durable prefix, not just an in-memory offset.
						service = createResourceProtectionIndex(database, receipts);
					}
					previous = after;
				}
				expect(interrupted).toBeGreaterThan(0);
				expect(progress()).toEqual({ cursor: "eof", complete: 1 });
				expect(attempts.get(paths[1] ?? "")).toBe(1); // The saved prefix is never re-read.
				expect(await claims([{ path: root }])).toHaveLength(70);
				expect(
					database
						.query(`SELECT 1 FROM resource_protection_sources
					WHERE source='receipt' AND source_id!='' AND dirty=1 LIMIT 1`)
						.get(),
				).toBeNull();
				for (let i = 0; i < paths.length; i++)
					expect(await fs.readFile(join(paths[i] ?? "", "history.bin"), "utf8")).toBe(
						`history-${i}`,
					);
				const before = changes();
				await service.maintain(deadline());
				expect(changes()).toBe(before);
			} finally {
				spy.mockRestore();
			}
		});
	}
	for (const concurrentChange of ["pin", "cursor"] as const) {
		test(`receipt reprojection rejects a stale per-pin ${concurrentChange} CAS without rewinding or revoking evidence`, async () => {
			const { files, paths, progress } = await receiptProjectionFixture(3);
			const initial = progress();
			const advanced =
				receiptProjectionPrefix +
				JSON.stringify({
					...JSON.parse(initial.cursor.slice(receiptProjectionPrefix.length)),
					after: files[0],
				});
			const realpath = fs.realpath;
			let changed = false;
			const spy = spyOn(fs, "realpath").mockImplementation((async (path) => {
				if (!changed && path === paths[0]) {
					changed = true;
					if (concurrentChange === "pin") {
						database
							.query(`UPDATE resource_protection_sources SET revision=revision+1
							WHERE source='receipt' AND source_id=?`)
							.run(files[0]);
					} else {
						database
							.query(`UPDATE resource_protection_sources SET cursor=?, revision=revision+1
							WHERE source='receipt' AND source_id=''`)
							.run(advanced);
					}
				}
				return realpath(path);
			}) as typeof fs.realpath);
			try {
				await expect(service.maintain(deadline())).rejects.toThrow(
					concurrentChange === "pin"
						? "Receipt pin changed during projection"
						: "Receipt projection cursor or pin changed",
				);
			} finally {
				spy.mockRestore();
			}
			expect(changed).toBe(true);
			expect(progress()).toEqual(
				concurrentChange === "pin" ? initial : { ...initial, cursor: advanced },
			);
			expect(
				database
					.query(`SELECT canonical_path FROM resource_protection_paths
				WHERE source='receipt' AND source_id=?`)
					.get(files[0]),
			).toEqual({
				canonical_path: concurrentChange === "pin" ? join(root, "old-0") : paths[0],
			});
			expect(
				database
					.query(`SELECT count(*) AS n FROM resource_protection_paths WHERE source='receipt'`)
					.get(),
			).toEqual({ n: 3 });
			service = createResourceProtectionIndex(database, receipts);
			await bootstrap();
			expect(progress()).toEqual({ cursor: "eof", complete: 1 });
			expect(await claims([{ path: root }])).toHaveLength(3);
			for (let i = 0; i < paths.length; i++)
				expect(await fs.readFile(join(paths[i] ?? "", "history.bin"), "utf8")).toBe(`history-${i}`);
		});
	}
	test("a cursor write failure after saving a pin keeps its evidence and safely repeats only that pin", async () => {
		const { files, paths, progress } = await receiptProjectionFixture(3);
		const before = progress();
		database.exec(`CREATE TRIGGER fail_receipt_projection_cursor BEFORE UPDATE ON resource_protection_sources
			WHEN OLD.source='receipt' AND OLD.source_id='' AND NEW.cursor IS NOT OLD.cursor
			BEGIN SELECT RAISE(ABORT, 'injected projection cursor failure'); END`);
		await expect(service.maintain(deadline())).rejects.toThrow(
			"injected projection cursor failure",
		);
		expect(progress()).toEqual(before);
		expect(
			database
				.query(`SELECT canonical_path FROM resource_protection_paths
			WHERE source='receipt' AND source_id=?`)
				.get(files[0]),
		).toEqual({ canonical_path: paths[0] });
		expect(
			database
				.query(`SELECT count(*) AS n FROM resource_protection_paths WHERE source='receipt'`)
				.get(),
		).toEqual({ n: 3 });
		expect((await service.read([{ path: root }], deadline())).complete).toBe(false);
		database.exec("DROP TRIGGER fail_receipt_projection_cursor");
		service = createResourceProtectionIndex(database, receipts);
		await bootstrap();
		expect(progress()).toEqual({ cursor: "eof", complete: 1 });
		expect(await claims([{ path: root }])).toHaveLength(3);
		for (let i = 0; i < paths.length; i++)
			expect(await fs.readFile(join(paths[i] ?? "", "history.bin"), "utf8")).toBe(`history-${i}`);
	});
	test("cancelled receipt reprojection retains its durable cursor and pins for restart", async () => {
		await mkdir(receipts);
		const file = join(receipts, `${"a".repeat(64)}.json`);
		await writeFile(file, JSON.stringify(receipt(root)));
		await bootstrap();
		oldProjection();
		installResourceProtectionTriggers(database);
		service = createResourceProtectionIndex(database, receipts);
		const head = () =>
			database
				.query(`SELECT cursor, complete FROM resource_protection_sources
			WHERE source='receipt' AND source_id=''`)
				.get();
		const pins = database
			.query("SELECT * FROM resource_protection_paths WHERE source='receipt'")
			.all();
		const progress = head();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<string>();
		const realpath = fs.realpath;
		const spy = spyOn(fs, "realpath").mockImplementation((async (path) => {
			if (path === root) {
				entered.resolve();
				return release.promise;
			}
			return realpath(path);
		}) as typeof fs.realpath);
		try {
			const controller = new AbortController();
			const work = service.maintain(deadline(), controller.signal);
			await entered.promise;
			controller.abort();
			await expect(work).rejects.toThrow();
			expect(head()).toEqual(progress);
			expect(
				database.query("SELECT * FROM resource_protection_paths WHERE source='receipt'").all(),
			).toEqual(pins);
			expect((await service.read([{ path: root }], deadline())).complete).toBe(false);
		} finally {
			release.resolve(root);
			spy.mockRestore();
		}
		service = createResourceProtectionIndex(database, receipts);
		installResourceProtectionTriggers(database);
		expect(head()).toEqual(progress);
		await rm(file);
		await bootstrap();
		expect((await claims([{ path: root }])).map((claim) => claim.id)).toEqual([file]);
	});
	test("oversized historical receipt projections stay pinned and incomplete without weakening ordinary reads", async () => {
		await bootstrap();
		const file = join(receipts, `${"a".repeat(64)}.json`);
		database
			.query(`INSERT INTO resource_protection_sources(source, source_id, dirty)
			VALUES ('receipt', ?, 0)`)
			.run(file);
		database
			.query(`INSERT INTO resource_protection_paths
			(source, source_id, slot, device_id, canonical_path, claim_json)
			VALUES ('receipt', ?, 0, 'local', ?, ?)`)
			.run(file, root, "x".repeat(200_000));
		oldProjection();
		installResourceProtectionTriggers(database);
		service = createResourceProtectionIndex(database, receipts);
		await expect(service.maintain(deadline())).rejects.toThrow("row budget");
		expect(
			database
				.query(`SELECT dirty FROM resource_protection_sources
			WHERE source='receipt' AND source_id=?`)
				.get(file),
		).toEqual({ dirty: 0 });
		expect(
			database
				.query(`SELECT canonical_path, length(claim_json) AS n FROM resource_protection_paths
			WHERE source='receipt' AND source_id=?`)
				.get(file),
		).toEqual({ canonical_path: root, n: 200_000 });
		expect((await service.read([{ path: root }], deadline())).complete).toBe(false);
		const before = changes();
		expect(await claims([{ path: root }], false)).toEqual([]);
		expect(changes()).toBe(before);
	});
	test.skipIf(process.platform === "win32")(
		"receipt pin projection is paged and restartable without rereading removed or rewritten journals",
		async () => {
			const literal = join(root, "historic\\checkout");
			const oldCanonical = join(root, "historic", "checkout");
			await mkdir(receipts);
			const state =
				database.query(`INSERT INTO resource_protection_sources(source, source_id, dirty)
			VALUES ('receipt', ?, 0)`);
			const pin = database.query(`INSERT INTO resource_protection_paths
			(source, source_id, slot, device_id, canonical_path, claim_json)
			VALUES ('receipt', ?, 0, 'local', ?, ?)`);
			for (let i = 0; i < 130; i++) {
				const file = join(receipts, `${i.toString().padStart(64, "0")}.json`);
				state.run(file);
				pin.run(
					file,
					oldCanonical,
					JSON.stringify({
						kind: "receipt",
						id: file,
						deviceId: "local",
						path: literal,
						repositoryKey: "historic-repository",
					}),
				);
			}
			database
				.query(`UPDATE resource_protection_sources SET cursor='eof', complete=1
			WHERE source='receipt' AND source_id=''`)
				.run();
			await writeFile(
				join(receipts, `${"0".repeat(64)}.json`),
				JSON.stringify({ dispatchState: "not_started" }),
			);
			await writeFile(join(receipts, `${"f".repeat(64)}.json`), JSON.stringify(receipt(root)));
			oldProjection();
			installResourceProtectionTriggers(database);
			const head = () =>
				database
					.query(`SELECT cursor, complete FROM resource_protection_sources
			WHERE source='receipt' AND source_id=''`)
					.get() as { cursor: string; complete: number };
			expect(head().cursor.startsWith(receiptProjectionPrefix)).toBe(true);
			const open = spyOn(fs, "open");
			const opendir = spyOn(fs, "opendir");
			try {
				await service.maintain(deadline());
				const updated = () =>
					database
						.query(`SELECT count(*) AS n FROM resource_protection_paths
				WHERE source='receipt' AND canonical_path=?`)
						.get(literal);
				expect(updated()).toEqual({ n: 64 });
				const progress = head();
				expect(progress.complete).toBe(0);
				expect((await service.read([{ path: literal }], deadline())).complete).toBe(false);
				await rm(receipts, { recursive: true });
				const before = changes();
				initializeAbsentReceiptProtectionSource(database, receipts);
				expect(head()).toEqual(progress); // Missing namespace cannot bypass projection.
				expect(changes()).toBe(before);
				service = createResourceProtectionIndex(database, receipts);
				installResourceProtectionTriggers(database);
				expect(head()).toEqual(progress);
				await service.maintain(deadline());
				expect(updated()).toEqual({ n: 128 });
				await bootstrap();
				expect(updated()).toEqual({ n: 130 });
				expect(head()).toEqual({ cursor: "eof", complete: 1 });
				expect(await claims([{ path: literal }])).toHaveLength(130);
				expect(await claims([{ path: oldCanonical }])).toEqual([]);
				expect(open).not.toHaveBeenCalled();
				expect(opendir).not.toHaveBeenCalled();
				const idle = changes();
				await service.maintain(deadline());
				expect(changes()).toBe(idle);
			} finally {
				open.mockRestore();
				opendir.mockRestore();
			}
		},
	);
});

describe("one-time legacy receipt pins", () => {
	for (const path of ["C:\\Remote\\Workspace", "\\\\Server\\Share\\Workspace"])
		test(`remote Windows receipt and shadow pins never require host absolute syntax: ${path}`, async () => {
			await mkdir(receipts);
			const file = join(receipts, `${"e".repeat(64)}.json`);
			await writeFile(file, JSON.stringify({ ...receipt(path), deviceId: "remote-device" }));
			await bootstrap();
			expect(
				(await claims([{ deviceId: "remote-device", path }])).map((claim) => claim.id),
			).toEqual([file]);
			expect(await claims([{ path: root }])).toEqual([]);
			const shadowKey = treeSnapshotKey("remote-device", path);
			database
				.query(`UPDATE resource_protection_paths SET claim_json=?, shadow_key=NULL
				WHERE source='receipt' AND source_id=?`)
				.run(
					JSON.stringify({
						kind: "receipt",
						id: file,
						deviceId: "remote-device",
						shadowKey,
					}),
					file,
				);
			database.exec(`DROP TRIGGER resource_protection_narrator_insert;
				CREATE TRIGGER resource_protection_narrator_insert AFTER INSERT ON narrators
				BEGIN SELECT 1; END;`);
			installResourceProtectionTriggers(database);
			service = createResourceProtectionIndex(database, receipts);
			await rm(file);
			await bootstrap();
			expect((await claims([{ shadowKey }])).map((claim) => claim.id)).toEqual([file]);
			expect(await claims([{ path: root }])).toEqual([]);
		});
	for (const phase of ["pending not_started", "failed not_started", "legacy validation failure"]) {
		test(`${phase} completes import without pinning rejected destinations`, async () => {
			await mkdir(receipts);
			const file = join(receipts, `${"f".repeat(64)}.json`);
			const failure = {
				outcome: "failed",
				worktree: null,
				error: { code: "INVALID_DESTINATION", message: "rejected before dispatch" },
				residuals: { destinationExists: null, branchExists: null },
			};
			await writeFile(
				file,
				JSON.stringify({
					destination: "\0rejected",
					repositoryKey: "not-a-pin",
					expectedHead: "",
					...(phase === "legacy validation failure" ? {} : { dispatchState: "not_started" }),
					...(phase === "pending not_started" ? {} : { result: failure }),
				}),
			);
			await bootstrap();
			expect(
				database
					.query(
						"SELECT dirty FROM resource_protection_sources WHERE source='receipt' AND source_id=?",
					)
					.get(file),
			).toEqual({ dirty: 0 });
			expect(
				database.query("SELECT 1 FROM resource_protection_paths WHERE source='receipt'").get(),
			).toBeNull();
			expect(await claims([{ path: root }])).toEqual([]);
			service = createResourceProtectionIndex(database, receipts);
			const before = changes();
			await service.maintain(deadline());
			expect(changes()).toBe(before);
		});
	}
	test("rewriting a previously imported pin to no-dispatch cannot revoke its protection", async () => {
		await mkdir(receipts);
		const file = join(receipts, `${"f".repeat(64)}.json`);
		await writeFile(file, JSON.stringify(receipt(root)));
		await bootstrap();
		const pins = database
			.query("SELECT * FROM resource_protection_paths WHERE source='receipt'")
			.all();
		await writeFile(file, JSON.stringify({ ...receipt(root), dispatchState: "not_started" }));
		service = createResourceProtectionIndex(database, receipts);
		await service.maintain(deadline());
		expect((await claims([{ path: root }])).map((claim) => claim.id)).toEqual([file]);
		expect(
			database.query("SELECT * FROM resource_protection_paths WHERE source='receipt'").all(),
		).toEqual(pins);
	});
	test("a failed retry-row write retains the consumed entry, then imports later records and restarts idempotently", async () => {
		await mkdir(receipts);
		const files = ["a", "b"].map((letter) => join(receipts, `${letter.repeat(64)}.json`));
		for (const file of files) await writeFile(file, JSON.stringify(receipt(root)));
		database.exec(`CREATE TRIGGER fail_receipt_registration BEFORE INSERT ON resource_protection_sources
			WHEN NEW.source = 'receipt' AND NEW.source_id != '' BEGIN
			SELECT RAISE(ABORT, 'injected receipt write failure'); END`);
		await expect(service.maintain(deadline())).rejects.toThrow("injected receipt write failure");
		expect(database.query("SELECT count(*) AS n FROM resource_protection_paths").get()).toEqual({
			n: 0,
		});
		expect((await service.read([{ path: root }], deadline())).complete).toBe(false);
		database.exec("DROP TRIGGER fail_receipt_registration");
		await service.maintain(deadline());
		expect(
			database
				.query("SELECT count(*) AS n FROM resource_protection_paths WHERE source='receipt'")
				.get(),
		).toEqual({ n: 2 });
		for (const file of files) await writeFile(file, "{");
		service = createResourceProtectionIndex(database, receipts);
		await bootstrap();
		expect((await claims([{ path: root }])).map((claim) => claim.id).sort()).toEqual(files);
		const before = changes();
		await service.maintain(deadline());
		expect(changes()).toBe(before);
	});
	for (const stage of ["open", "read", "close"] as const) {
		test(`pending receipt ${stage} is bounded, pauses only legacy import and advances short retry pages`, async () => {
			await mkdir(receipts);
			const files = ["a", "b"].map((letter) => join(receipts, `${letter.repeat(64)}.json`));
			for (const file of files) await writeFile(file, "{");
			await service.maintain(deadline()); // Reach EOF with two durable retry rows.
			for (const file of files) await writeFile(file, JSON.stringify(receipt(root)));
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const closed = Promise.withResolvers<void>();
			const open = fs.open;
			let opens = 0;
			const spy = spyOn(fs, "open").mockImplementation(async (...args) => {
				const file = await open(...args);
				if (++opens !== 1) return file;
				const close = file.close.bind(file);
				spyOn(file, "close").mockImplementation(async () => {
					if (stage === "close") {
						entered.resolve();
						await release.promise;
					}
					await close();
					closed.resolve();
				});
				if (stage === "read") {
					const read = file.read.bind(file);
					spyOn(file, "read").mockImplementationOnce((async (
						...readArgs: Parameters<typeof file.read>
					) => {
						entered.resolve();
						await release.promise;
						return read(...readArgs);
					}) as typeof file.read);
				}
				if (stage === "open") {
					entered.resolve();
					await release.promise;
				}
				return file;
			});
			try {
				const controller = new AbortController();
				const work = service.maintain(deadline(), controller.signal);
				await entered.promise;
				controller.abort();
				await expect(work).rejects.toThrow();
				narrator("business-narrator", root);
				registry("business-registry", root);
				await service.maintain(deadline());
				expect(opens).toBe(1); // No second open/read while the first IO or its close is unresolved.
				expect(await claims([{ path: root }], false)).toHaveLength(2);
				expect((await service.read([{ path: root }], deadline())).complete).toBe(false);
				release.resolve();
				await closed.promise;
				await new Promise<void>((done) => setTimeout(done, 0));
				await service.maintain(deadline());
				expect(
					database
						.query(
							"SELECT source_id, dirty FROM resource_protection_sources WHERE source='receipt' AND source_id!='' ORDER BY source_id",
						)
						.all(),
				).toEqual([
					{ source_id: files[0], dirty: 1 },
					{ source_id: files[1], dirty: 0 },
				]);
				await bootstrap();
				expect(
					(await claims([{ path: root }])).filter((claim) => claim.kind === "receipt"),
				).toHaveLength(2);
			} finally {
				release.resolve();
				await closed.promise;
				spy.mockRestore();
			}
		});
	}
	test("legacy compatibility waits for background import and ignores ordinary atomic-save temporary files", async () => {
		await mkdir(receipts);
		const file = join(receipts, `${"a".repeat(64)}.json`);
		await writeFile(file, JSON.stringify(receipt(join(root, "legacy"))));
		await writeFile(`${file}.00000000-0000-4000-8000-000000000000.pending`, "{");
		const before = changes();
		expect((await service.read([{ path: join(root, "legacy") }], deadline())).complete).toBe(false);
		expect(await claims([{ path: join(root, "legacy") }], false)).toEqual([]);
		expect(changes()).toBe(before);
		await bootstrap();
		expect((await claims([{ path: join(root, "legacy") }])).map((claim) => claim.id)).toEqual([
			file,
		]);
	});
	test("timed-out directory reads and pending cleanup never block business maintenance or reopen the directory", async () => {
		await mkdir(receipts);
		await writeFile(join(receipts, `${"a".repeat(64)}.json`), JSON.stringify(receipt(root)));
		database
			.query("UPDATE resource_protection_sources SET complete=1 WHERE source!='receipt'")
			.run();
		const reading = Promise.withResolvers<void>();
		const releaseRead = Promise.withResolvers<void>();
		const closing = Promise.withResolvers<void>();
		const releaseClose = Promise.withResolvers<void>();
		const closed = Promise.withResolvers<void>();
		const opendir = fs.opendir;
		let opens = 0;
		let reads = 0;
		let closes = 0;
		const spy = spyOn(fs, "opendir").mockImplementation(async (...args) => {
			const dir = await opendir(...args);
			if (++opens !== 1) return dir;
			const read = dir.read.bind(dir);
			const close = dir.close.bind(dir);
			spyOn(dir, "read").mockImplementationOnce(async () => {
				reads++;
				reading.resolve();
				await releaseRead.promise;
				return read();
			});
			spyOn(dir, "close").mockImplementation(async () => {
				closes++;
				closing.resolve();
				await releaseClose.promise;
				await close();
				closed.resolve();
			});
			return dir;
		});
		try {
			const controller = new AbortController();
			const work = service.maintain(deadline(), controller.signal);
			await reading.promise;
			controller.abort();
			await expect(work).rejects.toThrow();
			narrator("before-close", root);
			await service.maintain(deadline());
			expect(opens).toBe(1);
			expect(reads).toBe(1);
			releaseRead.resolve();
			await closing.promise;
			narrator("during-close", root);
			await service.maintain(deadline());
			expect(await claims([{ path: root }], false)).toHaveLength(2);
			expect(opens).toBe(1);
			expect(closes).toBe(1);
			releaseClose.resolve();
			await closed.promise;
			await new Promise<void>((done) => setTimeout(done, 0));
			await bootstrap();
			expect(
				(await claims([{ path: root }])).filter((claim) => claim.kind === "receipt"),
			).toHaveLength(1);
		} finally {
			releaseRead.resolve();
			releaseClose.resolve();
			await closed.promise;
			spy.mockRestore();
		}
	});
	test("legacy-only pins survive restart, rewritten and deleted original journals", async () => {
		await mkdir(receipts);
		const file = join(receipts, `${"b".repeat(64)}.json`);
		const destination = join(root, "old");
		await writeFile(file, JSON.stringify(receipt(destination)));
		await bootstrap();
		service = createResourceProtectionIndex(database, receipts);
		await writeFile(file, JSON.stringify(receipt(join(root, "new"))));
		await service.maintain(deadline());
		expect((await claims([{ path: destination }])).map((claim) => claim.id)).toEqual([file]);
		expect(await claims([{ path: join(root, "new") }])).toEqual([]);
		await rm(file);
		service = createResourceProtectionIndex(database, receipts);
		const before = changes();
		await service.maintain(deadline());
		expect((await claims([{ path: destination }])).map((claim) => claim.id)).toEqual([file]);
		expect(await claims([{ path: destination }], false)).toEqual([]);
		expect(changes()).toBe(before);
	});
	test("ordinary capture never decodes even malformed receipt index entries", async () => {
		await mkdir(receipts);
		await writeFile(join(receipts, `${"9".repeat(64)}.json`), JSON.stringify(receipt(root)));
		narrator("cwd", root);
		registry("registry", root);
		await bootstrap();
		database
			.query(
				"UPDATE resource_protection_paths SET claim_json = '{', alias_sensitive = 1 WHERE source = 'receipt'",
			)
			.run();
		const before = changes();
		expect((await claims([{ path: root }], false)).map((claim) => claim.id)).toEqual(
			expect.arrayContaining(["cwd", "registry"]),
		);
		expect(changes()).toBe(before);
		await expect(claims([{ path: root }])).rejects.toThrow();
	});
	test("completed import never reads renamed or unreadable receipt directories again", async () => {
		await mkdir(receipts);
		const file = join(receipts, `${"c".repeat(64)}.json`);
		await writeFile(file, JSON.stringify(receipt(root)));
		await bootstrap();
		const retired = `${receipts}-retired`;
		await rename(receipts, retired);
		await writeFile(receipts, "not a directory");
		await chmod(retired, 0);
		try {
			service = createResourceProtectionIndex(database, receipts);
			const before = changes();
			expect((await claims([{ path: root }])).map((claim) => claim.id)).toEqual([file]);
			await service.maintain(deadline());
			expect(changes()).toBe(before);
		} finally {
			await chmod(retired, 0o700);
		}
	});
	test("damaged legacy finals block compatibility proof, not ordinary cold capture or business claims", async () => {
		await mkdir(receipts);
		const file = join(receipts, `${"d".repeat(64)}.json`);
		narrator("cwd", root);
		registry("registered", root);
		for (const content of [
			"{",
			" ".repeat(32 * 1024 + 1),
			JSON.stringify({ ...receipt(root), deviceId: null }),
		]) {
			await writeFile(file, content);
			expect((await service.read([{ path: root }], deadline())).complete).toBe(false);
			const before = changes();
			expect((await claims([{ path: root }], false)).map((claim) => claim.id)).toEqual(
				expect.arrayContaining(["cwd", "registered"]),
			);
			expect(changes()).toBe(before);
		}
		await service.maintain(deadline());
		await service.maintain(deadline());
		expect(
			database
				.query(
					"SELECT dirty FROM resource_protection_sources WHERE source = 'receipt' AND source_id = ?",
				)
				.get(file),
		).toEqual({ dirty: 1 });
		expect((await service.read([{ path: root }], deadline())).complete).toBe(false);
		expect((await claims([{ path: root }], false)).map((claim) => claim.id)).toEqual(
			expect.arrayContaining(["cwd", "registered"]),
		);
	});
	test("legacy import does not invalidate ordinary capture versions; deletion waits for import", async () => {
		await mkdir(receipts);
		const file = join(receipts, `${"e".repeat(64)}.json`);
		await writeFile(file, JSON.stringify(receipt(root)));
		// Complete only the three business sources before starting either read.
		database
			.query("UPDATE resource_protection_sources SET complete = 1 WHERE source != 'receipt'")
			.run();
		const ordinary = await service.read([{ path: root }], deadline(), undefined, false);
		const destructive = await service.read([{ path: root }], deadline());
		await service.maintain(deadline());
		const found: ResourceClaim[] = [];
		for await (const claim of ordinary.claims) found.push(claim);
		expect(found).toEqual([]);
		expect(destructive.complete).toBe(false);
		await bootstrap();
		expect((await claims([{ path: root }])).map((claim) => claim.id)).toEqual([file]);
	});
	test("more than a batch imports progressively, resumes after restart and retains already imported records", async () => {
		await mkdir(receipts);
		for (let i = 0; i < 520; i++)
			await writeFile(
				join(receipts, `${i.toString(16).padStart(64, "0")}.json`),
				JSON.stringify({ ...receipt(root), padding: "x".repeat(600) }),
			);
		expect((await service.read([{ path: root }], deadline())).complete).toBe(false);
		await service.maintain(deadline());
		const first = database
			.query("SELECT source_id FROM resource_protection_paths WHERE source = 'receipt'")
			.all() as { source_id: string }[];
		expect(first).toHaveLength(64);
		// Finish this process's directory pass, then exercise a restart before completion publication.
		for (let i = 0; i < 8; i++) await service.maintain(deadline());
		database
			.query(
				"UPDATE resource_protection_sources SET cursor = NULL WHERE source = 'receipt' AND source_id = ''",
			)
			.run();
		const imported = first[0];
		if (!imported) throw new Error("No receipt imported");
		await writeFile(imported.source_id, "{");
		service = createResourceProtectionIndex(database, receipts);
		await bootstrap();
		expect(
			(await claims([{ repositoryKey: "receipt-repository" }])).filter(
				(claim) => claim.kind === "receipt",
			),
		).toHaveLength(520);
	}, 30_000);
	test("bad first records cannot starve later pages or bounded round-robin retries", async () => {
		await mkdir(receipts);
		for (let i = 0; i < 130; i++)
			await writeFile(
				join(receipts, `${i.toString(16).padStart(64, "0")}.json`),
				i < 65 ? "{" : JSON.stringify(receipt(join(root, "legacy"))),
			);
		for (let i = 0; i < 4; i++) await service.maintain(deadline());
		expect(
			database
				.query("SELECT count(*) AS n FROM resource_protection_paths WHERE source = 'receipt'")
				.get(),
		).toEqual({ n: 65 });
		expect((await service.read([{ path: root }], deadline())).complete).toBe(false);
		// Leave the earliest corrupt record broken; a later retry page must still be imported.
		const later = join(receipts, `${(64).toString(16).padStart(64, "0")}.json`);
		await writeFile(later, JSON.stringify(receipt(join(root, "recovered"))));
		for (let i = 0; i < 3; i++) await service.maintain(deadline());
		expect(
			database
				.query(
					"SELECT 1 AS present FROM resource_protection_paths WHERE source = 'receipt' AND source_id = ?",
				)
				.get(later),
		).toEqual({ present: 1 });
		expect(await claims([{ path: root }], false)).toEqual([]);
	});
});
