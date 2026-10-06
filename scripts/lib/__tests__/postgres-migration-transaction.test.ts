import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { runPostgresKit } from "../postgres-kit";
import {
	CURRENT_SNAPSHOT,
	digest,
	HISTORY_FILE,
	PENDING_FILE,
	readPgMetadata,
} from "../postgres-migration-metadata";
import {
	executePostgresMigrations,
	type PostgresMigrationOptions,
} from "../postgres-migration-transaction";

const roots: string[] = [];
const ZERO = "00000000-0000-0000-0000-000000000000";
const parent = resolve(import.meta.dir, "../../../.narrafork");
const success = (stdout: string) => ({
	exitCode: 0,
	stdout,
	stderr: "",
	stdoutTruncated: false,
	stderrTruncated: false,
});
function fixture() {
	const root = mkdtempSync(join(parent, "pg-tx-fixture-"));
	roots.push(root);
	const folder = join(root, "drizzle-postgres");
	const meta = join(folder, "meta");
	mkdirSync(meta, { recursive: true });
	mkdirSync(join(root, "server/db"), { recursive: true });
	writeFileSync(join(root, "server/db/postgres-schema.ts"), "export const fixtureSchema = {};\n");
	const ids = [randomUUID(), randomUUID()];
	const journal = {
		version: "7",
		dialect: "postgresql",
		entries: ids.map((_, idx) => ({
			idx,
			version: "7",
			when: 1700000000000 + idx,
			tag: `${String(idx).padStart(4, "0")}_fixture_${idx}`,
			breakpoints: true,
		})),
	};
	// Unusual journal whitespace intentionally survives baseline and subsequent append.
	writeFileSync(join(meta, "_journal.json"), `${JSON.stringify(journal, null, 3)}\n`);
	ids.forEach((id, idx) => {
		writeFileSync(
			join(folder, `${journal.entries[idx]?.tag}.sql`),
			`-- preserved SQL ${idx}\nSELECT ${idx};\n`,
		);
		writeFileSync(
			join(meta, `${String(idx).padStart(4, "0")}_snapshot.json`),
			`${JSON.stringify({ id, prevId: idx === 0 ? ZERO : ids[idx - 1], version: "7", dialect: "postgresql", tables: {}, enums: {}, schemas: {}, sequences: {}, roles: {}, policies: {}, views: {}, _meta: { schemas: {}, tables: {}, columns: {} } }, null, 2)}\n`,
		);
	});
	return { root, folder, meta, ids };
}
async function baseline() {
	const f = fixture();
	await executePostgresMigrations("baseline", [], { root: f.root });
	return f;
}
function hashes(folder: string) {
	return readPgMetadata(folder, { allowLegacy: true }).files;
}
const noop: typeof runPostgresKit = async () =>
	success("\u001b[32mNo schema changes, nothing to migrate 😴\u001b[0m");
const check: typeof runPostgresKit = async () => success("Everything's fine 🐶🔥");
function generated(mutate?: (stage: string) => void): typeof runPostgresKit {
	let calls = 0;
	return async ({ root, stageOut, args }) => {
		if (calls++ > 0) return success("No schema changes, nothing to migrate 😴");
		expect(stageOut.startsWith(".narrafork/pg-")).toBe(true);
		expect(stageOut.startsWith("/")).toBe(false);
		const stage = join(root, stageOut);
		const meta = join(stage, "meta");
		const journal = JSON.parse(readFileSync(join(meta, "_journal.json"), "utf8"));
		const last = journal.entries.at(-1);
		const idx = last.idx + 1;
		const old = JSON.parse(
			readFileSync(join(meta, `${String(last.idx).padStart(4, "0")}_snapshot.json`), "utf8"),
		);
		const tag = `${String(idx).padStart(4, "0")}_generated`;
		journal.entries.push({ idx, version: "7", when: last.when + 1, tag, breakpoints: true });
		writeFileSync(join(meta, "_journal.json"), JSON.stringify(journal, null, 2));
		const snapshot = { ...old, id: randomUUID(), prevId: old.id };
		if (!args?.includes("--custom"))
			snapshot.tables = { ...snapshot.tables, [`public.table_${idx}`]: { name: `table_${idx}` } };
		writeFileSync(
			join(meta, `${String(idx).padStart(4, "0")}_snapshot.json`),
			JSON.stringify(snapshot, null, 2),
		);
		writeFileSync(
			join(stage, `${tag}.sql`),
			args?.includes("--custom")
				? "-- Custom SQL migration file, put your code below! --"
				: `CREATE TABLE table_${idx}(id int);\n`,
		);
		mutate?.(stage);
		return success("[✓] Your SQL migration file ➜ generated.sql 🚀");
	};
}
async function interrupted(phase = "snapshot", options: PostgresMigrationOptions = {}) {
	const f = await baseline();
	await expect(
		executePostgresMigrations("generate", [], {
			root: f.root,
			runKit: generated(),
			...options,
			faultInject: (current) => {
				if (current === phase) throw new Error(`injected ${phase}`);
			},
		}),
	).rejects.toThrow(`injected ${phase}`);
	return f;
}
function pending(f: { meta: string }) {
	return JSON.parse(readFileSync(join(f.meta, PENDING_FILE), "utf8"));
}
function savePending(f: { meta: string }, value: unknown) {
	writeFileSync(join(f.meta, PENDING_FILE), JSON.stringify(value));
}
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("PostgreSQL baseline convergence and generation", () => {
	test("dry-run validates all legacy snapshots and makes no filesystem changes", async () => {
		const f = fixture();
		const before = hashes(f.folder);
		expect(
			await executePostgresMigrations("baseline", ["--dry-run"], { root: f.root }),
		).toMatchObject({ changed: true, dryRun: true, migrations: 2 });
		expect(hashes(f.folder)).toEqual(before);
		expect(existsSync(join(f.root, ".narrafork"))).toBe(false);
	});
	test("baseline preserves SQL/journal/latest snapshot bytes and is idempotent", async () => {
		const f = fixture();
		const before = hashes(f.folder);
		const last = readFileSync(join(f.meta, "0001_snapshot.json"));
		expect(await executePostgresMigrations("baseline", [], { root: f.root })).toMatchObject({
			changed: true,
		});
		const after = hashes(f.folder);
		for (const [path, sha] of Object.entries(before))
			if (path.endsWith(".sql") || path === "meta/_journal.json") expect(after[path]).toBe(sha);
		expect(readFileSync(join(f.meta, CURRENT_SNAPSHOT))).toEqual(last);
		expect(readdirSync(f.meta).sort()).toEqual(
			["_journal.json", HISTORY_FILE, CURRENT_SNAPSHOT].sort(),
		);
		expect(await executePostgresMigrations("baseline", [], { root: f.root })).toMatchObject({
			changed: false,
		});
		expect(hashes(f.folder)).toEqual(after);
	});
	test("no-op leaves every committed byte unchanged and cleans only own stage", async () => {
		const f = await baseline();
		mkdirSync(join(f.root, ".narrafork/pg-foreign"));
		writeFileSync(join(f.root, ".narrafork/pg-foreign/evidence"), "do not touch");
		const before = hashes(f.folder);
		expect(
			await executePostgresMigrations("generate", [], { root: f.root, runKit: noop }),
		).toMatchObject({ changed: false });
		expect(hashes(f.folder)).toEqual(before);
		expect(readdirSync(join(f.root, ".narrafork"))).toEqual(["pg-foreign"]);
	});
	test("three appends retain one full snapshot, old SQL and journal entry bytes", async () => {
		const f = await baseline();
		const old = readPgMetadata(f.folder);
		const originalJournal = old.journalText;
		for (let i = 0; i < 3; i++) {
			const previous = readPgMetadata(f.folder);
			expect(
				await executePostgresMigrations("generate", ["--name", `test_${i}`], {
					root: f.root,
					runKit: generated(),
				}),
			).toMatchObject({ changed: true, migrations: 3 + i });
			const current = readPgMetadata(f.folder);
			expect(current.snapshot.prevId).toBe(previous.snapshot.id);
			expect(current.history.entries.slice(0, previous.history.entries.length)).toEqual(
				previous.history.entries,
			);
			expect(
				readdirSync(f.meta)
					.filter((name) => name.includes("snapshot"))
					.sort(),
			).toEqual([HISTORY_FILE, CURRENT_SNAPSHOT].sort());
		}
		const after = readPgMetadata(f.folder);
		for (const [path, sha] of Object.entries(old.files))
			if (path.endsWith(".sql")) expect(after.files[path]).toBe(sha);
		expect(after.journal.entries.slice(0, 2)).toEqual(old.journal.entries);
		const oldEntryText = originalJournal
			.slice(originalJournal.indexOf("[") + 1, originalJournal.lastIndexOf("]"))
			.trimEnd();
		expect(after.journalText).toContain(oldEntryText);
		expect(after.history.entries).toHaveLength(5);
		expect(after.historyText).not.toContain("sqlDigest");
	});
	test("custom uses prior schema even when source contains pending schema changes; SQL can be filled later", async () => {
		const f = await baseline();
		writeFileSync(
			join(f.root, "server/db/postgres-schema.ts"),
			"// pending normal generation changes\n",
		);
		const before = readPgMetadata(f.folder);
		await executePostgresMigrations("generate", ["--custom", "--name=manual"], {
			root: f.root,
			runKit: generated(),
		});
		const after = readPgMetadata(f.folder);
		expect(after.snapshot.tables).toEqual(before.snapshot.tables);
		writeFileSync(join(f.folder, `${after.journal.entries.at(-1)?.tag}.sql`), "SELECT 42;\n");
		expect(
			await executePostgresMigrations("check", [], { root: f.root, runKit: check }),
		).toMatchObject({ changed: false });
	});
	test("rename then custom accepts native Kit resetting only rename annotations", async () => {
		const f = fixture();
		const legacyPath = join(f.meta, "0001_snapshot.json");
		const legacy = JSON.parse(readFileSync(legacyPath, "utf8"));
		legacy.tables = { "public.old_name": { name: "old_name", schema: "public", columns: {} } };
		writeFileSync(legacyPath, JSON.stringify(legacy, null, 2));
		await executePostgresMigrations("baseline", [], { root: f.root });
		await executePostgresMigrations("generate", ["--name=rename"], {
			root: f.root,
			runKit: generated((stage) => {
				const path = join(stage, "meta/0002_snapshot.json");
				const snapshot = JSON.parse(readFileSync(path, "utf8"));
				snapshot.tables = {
					"public.new_name": { name: "new_name", schema: "public", columns: {} },
				};
				snapshot._meta = {
					schemas: {},
					tables: { "public.old_name": "public.new_name" },
					columns: {},
				};
				writeFileSync(path, JSON.stringify(snapshot, null, 2));
				writeFileSync(
					join(stage, "0002_generated.sql"),
					'ALTER TABLE "old_name" RENAME TO "new_name";',
				);
			}),
		});
		const renamed = readPgMetadata(f.folder);
		expect(renamed.snapshot._meta).toEqual({
			schemas: {},
			tables: { "public.old_name": "public.new_name" },
			columns: {},
		});
		await executePostgresMigrations("generate", ["--custom", "--name=manual_after_rename"], {
			root: f.root,
			runKit: generated((stage) => {
				const path = join(stage, "meta/0003_snapshot.json");
				const snapshot = JSON.parse(readFileSync(path, "utf8"));
				// Drizzle 0.31.10 custom omits writeResult._meta; its default resets these maps.
				snapshot._meta = { columns: {}, schemas: {}, tables: {} };
				writeFileSync(path, JSON.stringify(snapshot, null, 2));
			}),
		});
		const current = readPgMetadata(f.folder);
		expect(current.snapshot.tables).toEqual(renamed.snapshot.tables);
		expect(current.snapshot._meta).toEqual({ columns: {}, schemas: {}, tables: {} });
		expect(current.snapshot.prevId).toBe(renamed.snapshot.id);
		expect(current.journal.entries).toHaveLength(4);
		expect(current.files["0002_generated.sql"]).toBe(renamed.files["0002_generated.sql"]);
	});
	test("custom schema comparison ignores object key ordering but preserves all schema data", async () => {
		const f = fixture();
		const path = join(f.meta, "0001_snapshot.json");
		const snapshot = JSON.parse(readFileSync(path, "utf8"));
		snapshot.tables = {
			"public.example": {
				name: "example",
				schema: "public",
				columns: { id: { name: "id", type: "integer", notNull: true } },
			},
		};
		writeFileSync(path, JSON.stringify(snapshot));
		await executePostgresMigrations("baseline", [], { root: f.root });
		const before = readPgMetadata(f.folder);
		const reorder = (value: unknown): unknown => {
			if (Array.isArray(value)) return value.map(reorder);
			if (value && typeof value === "object")
				return Object.fromEntries(
					Object.entries(value)
						.reverse()
						.map(([key, item]) => [key, reorder(item)]),
				);
			return value;
		};
		await executePostgresMigrations("generate", ["--custom"], {
			root: f.root,
			runKit: generated((stage) => {
				const path = join(stage, "meta/0002_snapshot.json");
				writeFileSync(path, JSON.stringify(reorder(JSON.parse(readFileSync(path, "utf8")))));
			}),
		});
		expect(readPgMetadata(f.folder).snapshot.tables).toEqual(before.snapshot.tables);
	});
	test("table identifiers containing failed or conflict are not error diagnostics", async () => {
		const f = await baseline();
		const native = generated((stage) => {
			const path = join(stage, "meta/0002_snapshot.json");
			const snapshot = JSON.parse(readFileSync(path, "utf8"));
			snapshot.tables = {
				"public.failed_jobs": { name: "failed_jobs" },
				"public.conflict_resolution": { name: "conflict_resolution" },
			};
			writeFileSync(path, JSON.stringify(snapshot));
			writeFileSync(
				join(stage, "0002_generated.sql"),
				'CREATE TABLE "failed_jobs"(id int); CREATE TABLE "conflict_resolution"(id int);',
			);
		});
		const output =
			"2 tables\nfailed_jobs 1 columns 0 indexes 0 fks\nconflict_resolution 1 columns 0 indexes 0 fks\n";
		const runner: typeof runPostgresKit = async (opts) => {
			const result = await native(opts);
			return { ...result, stdout: output + result.stdout };
		};
		await executePostgresMigrations("generate", [], { root: f.root, runKit: runner });
		const before = hashes(f.folder);
		await executePostgresMigrations("generate", [], {
			root: f.root,
			runKit: async () => success(`${output}No schema changes, nothing to migrate`),
		});
		expect(hashes(f.folder)).toEqual(before);
		expect(readPgMetadata(f.folder).snapshot.tables).toEqual({
			"public.failed_jobs": { name: "failed_jobs" },
			"public.conflict_resolution": { name: "conflict_resolution" },
		});
	});
	test("check does not write formal metadata or acquire a formal lock", async () => {
		const f = await baseline();
		const before = hashes(f.folder);
		const runner: typeof runPostgresKit = async (opts) => {
			expect(existsSync(join(f.meta, "_generation.lock"))).toBe(false);
			return check(opts);
		};
		await executePostgresMigrations("check", [], { root: f.root, runKit: runner });
		expect(hashes(f.folder)).toEqual(before);
	});
});

describe("fail-closed validation", () => {
	for (const field of [
		"tables",
		"enums",
		"schemas",
		"sequences",
		"roles",
		"policies",
		"views",
		"pluginSchema",
	])
		test(`custom rejects real schema changes to ${field} even when rename metadata resets`, async () => {
			const f = await baseline();
			const before = hashes(f.folder);
			await expect(
				executePostgresMigrations("generate", ["--custom"], {
					root: f.root,
					runKit: generated((stage) => {
						const path = join(stage, "meta/0002_snapshot.json");
						const snapshot = JSON.parse(readFileSync(path, "utf8"));
						delete snapshot._meta;
						snapshot[field] = { tampered: { name: "changed" } };
						writeFileSync(path, JSON.stringify(snapshot));
					}),
				}),
			).rejects.toThrow("custom generation unexpectedly changed");
			expect(hashes(f.folder)).toEqual(before);
		});
	test("custom schema comparison still rejects reordered index-column arrays", async () => {
		const f = fixture();
		const path = join(f.meta, "0001_snapshot.json");
		const snapshot = JSON.parse(readFileSync(path, "utf8"));
		snapshot.tables = {
			"public.example": { indexes: { by_two_columns: { columns: ["first", "second"] } } },
		};
		writeFileSync(path, JSON.stringify(snapshot));
		await executePostgresMigrations("baseline", [], { root: f.root });
		const before = hashes(f.folder);
		await expect(
			executePostgresMigrations("generate", ["--custom"], {
				root: f.root,
				runKit: generated((stage) => {
					const path = join(stage, "meta/0002_snapshot.json");
					const snapshot = JSON.parse(readFileSync(path, "utf8"));
					snapshot.tables["public.example"].indexes.by_two_columns.columns.reverse();
					writeFileSync(path, JSON.stringify(snapshot));
				}),
			}),
		).rejects.toThrow("custom generation unexpectedly changed");
		expect(hashes(f.folder)).toEqual(before);
	});
	test("programmatic callers cannot select an unsupported operation", async () => {
		const f = await baseline();
		const before = hashes(f.folder);
		await expect(
			executePostgresMigrations("up" as never, [], { root: f.root, runKit: generated() }),
		).rejects.toThrow("Unsupported");
		expect(hashes(f.folder)).toEqual(before);
	});
	test("ordinary generated baseline must converge with source in a second native no-op", async () => {
		const f = await baseline();
		const before = hashes(f.folder);
		const runner: typeof runPostgresKit = async (opts) => generated()(opts);
		await expect(
			executePostgresMigrations("generate", [], { root: f.root, runKit: runner }),
		).rejects.toThrow("converge");
		expect(hashes(f.folder)).toEqual(before);
		expect(existsSync(join(f.meta, PENDING_FILE))).toBe(false);
	});
	test("a second native no-op marker cannot hide rewritten stage bytes", async () => {
		const f = await baseline();
		const before = hashes(f.folder);
		const native = generated();
		let calls = 0;
		const runner: typeof runPostgresKit = async (opts) => {
			const outcome = await native(opts);
			if (++calls === 2)
				writeFileSync(
					join(opts.root, opts.stageOut, "0002_generated.sql"),
					"mutated after generated",
				);
			return outcome;
		};
		await expect(
			executePostgresMigrations("generate", [], { root: f.root, runKit: runner }),
		).rejects.toThrow("converge");
		expect(hashes(f.folder)).toEqual(before);
	});
	test("child cancellation/timeout failure releases lock and only own stage", async () => {
		const f = await baseline();
		const before = hashes(f.folder);
		for (const reason of ["timed out", "aborted"]) {
			await expect(
				executePostgresMigrations("generate", [], {
					root: f.root,
					runKit: async () => {
						throw new Error(reason);
					},
				}),
			).rejects.toThrow(reason);
			expect(hashes(f.folder)).toEqual(before);
			expect(existsSync(join(f.meta, "_generation.lock"))).toBe(false);
			expect(readdirSync(join(f.root, ".narrafork"))).toEqual([]);
		}
	});
	for (const flags of [
		["--out", "/tmp/evil"],
		["--config=evil.ts"],
		["--ignore-conflicts"],
		["--name", "../escape"],
		["--custom", "--custom"],
	])
		test(`rejects unsupported flags ${flags.join(" ")}`, async () => {
			const f = await baseline();
			const before = hashes(f.folder);
			await expect(
				executePostgresMigrations("generate", flags, { root: f.root, runKit: generated() }),
			).rejects.toThrow();
			expect(hashes(f.folder)).toEqual(before);
		});
	for (const output of [
		"Error: schema failed",
		"[✓] Your SQL migration file\nTypeError: invalid",
		"untrusted success",
		"No schema changes, nothing to migrate\nfailed",
	])
		test(`rejects child exit-zero error ${output}`, async () => {
			const f = await baseline();
			const before = hashes(f.folder);
			await expect(
				executePostgresMigrations("generate", [], {
					root: f.root,
					runKit: async () => success(output),
				}),
			).rejects.toThrow();
			expect(hashes(f.folder)).toEqual(before);
			expect(readdirSync(join(f.root, ".narrafork"))).toEqual([]);
		});
	for (const path of ["0000_fixture_0.sql", "meta/0001_snapshot.json", "meta/_journal.json"])
		test(`rejects Kit rewriting ${path}`, async () => {
			const f = await baseline();
			const before = hashes(f.folder);
			await expect(
				executePostgresMigrations("generate", [], {
					root: f.root,
					runKit: generated((stage) => writeFileSync(join(stage, path), "tamper")),
				}),
			).rejects.toThrow();
			expect(hashes(f.folder)).toEqual(before);
		});
	test("rejects Kit extra assets, altered old journal entries, malformed parent and custom changes", async () => {
		const mutations = [
			(stage: string) => writeFileSync(join(stage, "meta/foreign.json"), "{}"),
			(stage: string) => {
				const path = join(stage, "meta/_journal.json");
				const value = JSON.parse(readFileSync(path, "utf8"));
				value.entries[0].when++;
				writeFileSync(path, JSON.stringify(value));
			},
			(stage: string) => {
				const path = join(stage, "meta/0002_snapshot.json");
				const value = JSON.parse(readFileSync(path, "utf8"));
				value.prevId = randomUUID();
				writeFileSync(path, JSON.stringify(value));
			},
		];
		for (const mutate of mutations) {
			const f = await baseline();
			const before = hashes(f.folder);
			await expect(
				executePostgresMigrations("generate", [], { root: f.root, runKit: generated(mutate) }),
			).rejects.toThrow();
			expect(hashes(f.folder)).toEqual(before);
		}
		const f = await baseline();
		await expect(
			executePostgresMigrations("generate", ["--custom"], {
				root: f.root,
				runKit: generated((stage) => {
					const path = join(stage, "meta/0002_snapshot.json");
					const value = JSON.parse(readFileSync(path, "utf8"));
					value.tables = { tampered: {} };
					writeFileSync(path, JSON.stringify(value));
				}),
			}),
		).rejects.toThrow("custom");
	});
	for (const path of [
		"0000_fixture_0.sql",
		"meta/current_snapshot.json",
		"server/db/postgres-schema.ts",
	])
		test(`detects beforePublish concurrent modification ${path}`, async () => {
			const f = await baseline();
			const absolute = path.startsWith("server/") ? join(f.root, path) : join(f.folder, path);
			await expect(
				executePostgresMigrations("generate", [], {
					root: f.root,
					runKit: generated(),
					beforePublish: () => {
						writeFileSync(absolute, "concurrent editor change");
					},
				}),
			).rejects.toThrow();
			expect(readFileSync(absolute, "utf8")).toBe("concurrent editor change");
			expect(existsSync(join(f.meta, PENDING_FILE))).toBe(false);
			expect(readdirSync(join(f.root, ".narrafork"))).toEqual([]);
		});
	test("new foreign asset inserted before publication is preserved and rejected", async () => {
		const f = await baseline();
		await expect(
			executePostgresMigrations("generate", [], {
				root: f.root,
				runKit: generated(),
				beforePublish: () => {
					writeFileSync(join(f.folder, "foreign.sql"), "foreign");
				},
			}),
		).rejects.toThrow();
		expect(readFileSync(join(f.folder, "foreign.sql"), "utf8")).toBe("foreign");
	});
	test("check rejects stage modifications and concurrent receipt insertion", async () => {
		const f = await baseline();
		await expect(
			executePostgresMigrations("check", [], {
				root: f.root,
				runKit: async (opts) => {
					writeFileSync(join(opts.root, opts.stageOut, "0000_fixture_0.sql"), "changed");
					return success("Everything's fine");
				},
			}),
		).rejects.toThrow("modified staged");
		await expect(
			executePostgresMigrations("check", [], {
				root: f.root,
				runKit: async () => {
					writeFileSync(join(f.meta, PENDING_FILE), "{}");
					return success("Everything's fine");
				},
			}),
		).rejects.toThrow("pending");
	});
	test("baseline fully validates chain before removing any legacy file", async () => {
		const f = fixture();
		const path = join(f.meta, "0001_snapshot.json");
		const value = JSON.parse(readFileSync(path, "utf8"));
		value.prevId = randomUUID();
		writeFileSync(path, JSON.stringify(value));
		await expect(executePostgresMigrations("baseline", [], { root: f.root })).rejects.toThrow();
		expect(existsSync(join(f.meta, "0000_snapshot.json"))).toBe(true);
		expect(existsSync(path)).toBe(true);
		expect(existsSync(join(f.meta, CURRENT_SNAPSHOT))).toBe(false);
	});
});

describe("receipt recovery across every publication checkpoint", () => {
	test("receipt digest tampering cannot authorize overwriting a concurrent SQL edit", async () => {
		const f = await interrupted("sql");
		writeFileSync(join(f.folder, "0000_fixture_0.sql"), "foreign SQL edit");
		const receipt = pending(f);
		receipt.oldFiles["0000_fixture_0.sql"] = digest("foreign SQL edit");
		savePending(f, receipt);
		await expect(executePostgresMigrations("resume", [], { root: f.root })).rejects.toThrow(
			"manifest",
		);
		expect(readFileSync(join(f.folder, "0000_fixture_0.sql"), "utf8")).toBe("foreign SQL edit");
		expect(existsSync(join(f.meta, PENDING_FILE))).toBe(true);
	});
	test("concurrent edits after publication begins fail closed before the next phase", async () => {
		const f = await baseline();
		const journal = readFileSync(join(f.meta, "_journal.json"));
		await expect(
			executePostgresMigrations("generate", [], {
				root: f.root,
				runKit: generated(),
				faultInject: (phase) => {
					if (phase === "sql")
						writeFileSync(join(f.folder, "0000_fixture_0.sql"), "concurrent midpublish change");
				},
			}),
		).rejects.toThrow("modified asset");
		expect(readFileSync(join(f.meta, "_journal.json"))).toEqual(journal);
		expect(readFileSync(join(f.folder, "0000_fixture_0.sql"), "utf8")).toBe(
			"concurrent midpublish change",
		);
		expect(existsSync(join(f.meta, PENDING_FILE))).toBe(true);
	});
	test("missing legacy snapshot before completed publication cannot be excused as cleanup", async () => {
		const f = fixture();
		await expect(
			executePostgresMigrations("baseline", [], {
				root: f.root,
				faultInject: (phase) => {
					if (phase === "snapshot") throw new Error("early stop");
				},
			}),
		).rejects.toThrow("early stop");
		unlinkSync(join(f.meta, "0000_snapshot.json"));
		await expect(executePostgresMigrations("resume", [], { root: f.root })).rejects.toThrow(
			"missing",
		);
	});
	for (const phase of [
		"receipt",
		"sql",
		"snapshot",
		"history",
		"journal",
		"legacy-cleanup",
		"complete",
	])
		test(`generation resumes ${phase} without regenerating or rolling back journal`, async () => {
			const f = await interrupted(phase);
			const receipt = pending(f);
			expect(existsSync(join(f.root, receipt.stage))).toBe(true);
			expect(existsSync(join(f.meta, "_generation.lock"))).toBe(false);
			await expect(
				executePostgresMigrations("check", [], { root: f.root, runKit: check }),
			).rejects.toThrow("pending");
			const journalAlreadyPublished = ["journal", "legacy-cleanup", "complete"].includes(phase);
			const journal = readFileSync(join(f.meta, "_journal.json"));
			expect(
				await executePostgresMigrations("resume", [], {
					root: f.root,
					runKit: async () => {
						throw new Error("must not regenerate");
					},
				}),
			).toMatchObject({ changed: true, migrations: 3 });
			if (journalAlreadyPublished)
				expect(readFileSync(join(f.meta, "_journal.json"))).toEqual(journal);
			expect(existsSync(join(f.meta, PENDING_FILE))).toBe(false);
			expect(existsSync(join(f.root, receipt.stage))).toBe(false);
		});
	for (const phase of [
		"receipt",
		"sql",
		"snapshot",
		"history",
		"journal",
		"legacy-cleanup",
		"deleted:meta/0000_snapshot.json",
		"deleted:meta/0001_snapshot.json",
		"complete",
	])
		test(`legacy convergence resumes ${phase} including partial deletion`, async () => {
			const f = fixture();
			const before = hashes(f.folder);
			await expect(
				executePostgresMigrations("baseline", [], {
					root: f.root,
					faultInject: (current) => {
						if (current === phase) throw new Error("interrupted baseline");
					},
				}),
			).rejects.toThrow("interrupted baseline");
			await executePostgresMigrations("resume", [], { root: f.root });
			const after = readPgMetadata(f.folder);
			expect(after.mode).toBe("baseline");
			for (const [path, sha] of Object.entries(before))
				if (path.endsWith(".sql") || path === "meta/_journal.json")
					expect(after.files[path]).toBe(sha);
			expect(readdirSync(f.meta).sort()).toEqual(
				["_journal.json", HISTORY_FILE, CURRENT_SNAPSHOT].sort(),
			);
		});
	test("repeated interrupted resume never regresses cleanup phase or loses deletion evidence", async () => {
		const f = fixture();
		await expect(
			executePostgresMigrations("baseline", [], {
				root: f.root,
				faultInject: (phase) => {
					if (phase.startsWith("deleted:")) throw new Error("first crash");
				},
			}),
		).rejects.toThrow("first crash");
		await expect(
			executePostgresMigrations("resume", [], {
				root: f.root,
				faultInject: (phase) => {
					if (phase === "sql") throw new Error("second crash");
				},
			}),
		).rejects.toThrow("second crash");
		expect(pending(f).phase).toBe("legacy-cleanup");
		await executePostgresMigrations("resume", [], { root: f.root });
		expect(readPgMetadata(f.folder).mode).toBe("baseline");
	});
	for (const target of ["formal", "payload", "schema", "foreign-asset"])
		test(`resume refuses ${target} tamper and retains all evidence`, async () => {
			const f = await interrupted("sql");
			const receipt = pending(f);
			const path =
				target === "formal"
					? join(f.folder, "0000_fixture_0.sql")
					: target === "payload"
						? join(f.root, receipt.stage, "publish", "meta", CURRENT_SNAPSHOT)
						: target === "schema"
							? join(f.root, "server/db/postgres-schema.ts")
							: join(f.folder, "unknown.sql");
			writeFileSync(path, "foreign edit");
			await expect(executePostgresMigrations("resume", [], { root: f.root })).rejects.toThrow();
			expect(readFileSync(path, "utf8")).toBe("foreign edit");
			expect(existsSync(join(f.meta, PENDING_FILE))).toBe(true);
			expect(existsSync(join(f.root, receipt.stage))).toBe(true);
		});
	test("deleted stage is a hard failure, never regenerated", async () => {
		const f = await interrupted();
		const receipt = pending(f);
		rmSync(join(f.root, receipt.stage), { recursive: true });
		await expect(executePostgresMigrations("resume", [], { root: f.root })).rejects.toThrow();
		expect(existsSync(join(f.meta, PENDING_FILE))).toBe(true);
	});
	for (const mutate of [
		(value: ReturnType<typeof pending>) => {
			value.stage = ".narrafork/../../escape";
		},
		(value: ReturnType<typeof pending>) => {
			value.newFiles["../escape.sql"] = digest("evil");
		},
		(value: ReturnType<typeof pending>) => {
			value.deletions = ["meta/current_snapshot.json"];
		},
		(value: ReturnType<typeof pending>) => {
			value.schema.path = "../escape.ts";
		},
	])
		test("resume rejects receipt root escape or unauthorized deletion", async () => {
			const f = await interrupted();
			const receipt = pending(f);
			mutate(receipt);
			savePending(f, receipt);
			await expect(executePostgresMigrations("resume", [], { root: f.root })).rejects.toThrow();
			expect(existsSync(join(f.meta, PENDING_FILE))).toBe(true);
		});
	test("missing existing SQL is never treated as an expected legacy deletion", async () => {
		const f = await interrupted("legacy-cleanup");
		unlinkSync(join(f.folder, "0000_fixture_0.sql"));
		await expect(executePostgresMigrations("resume", [], { root: f.root })).rejects.toThrow(
			"missing",
		);
	});
	test("resume requires a receipt rather than generating new work", async () => {
		const f = await baseline();
		const before = hashes(f.folder);
		await expect(executePostgresMigrations("resume", [], { root: f.root })).rejects.toThrow();
		expect(hashes(f.folder)).toEqual(before);
	});
});

describe("path and same-machine lock safety", () => {
	test("dead or absent owner locks are never automatically taken over", async () => {
		const f = await baseline();
		const lock = join(f.meta, "_generation.lock");
		mkdirSync(lock);
		for (const owner of [undefined, { token: "stale", pid: -1 }]) {
			if (owner) writeFileSync(join(lock, "owner.json"), JSON.stringify(owner));
			await expect(
				executePostgresMigrations("generate", [], { root: f.root, runKit: noop }),
			).rejects.toThrow("lock");
			expect(existsSync(lock)).toBe(true);
		}
	});
	test("two live producers cannot publish concurrently", async () => {
		const f = await baseline();
		let unblock: (() => void) | undefined;
		const gate = new Promise<void>((res) => {
			unblock = res;
		});
		let announce: (() => void) | undefined;
		const entered = new Promise<void>((res) => {
			announce = res;
		});
		const first = executePostgresMigrations("generate", [], {
			root: f.root,
			runKit: async () => {
				announce?.();
				await gate;
				return noop({ root: f.root, stageOut: "", operation: "generate" });
			},
		});
		await entered;
		try {
			await expect(
				executePostgresMigrations("generate", [], { root: f.root, runKit: noop }),
			).rejects.toThrow("lock");
		} finally {
			unblock?.();
		}
		await first;
	});
	for (const target of ["folder", "meta", "asset", "stage", "stage-parent"])
		test(`rejects symlink ${target}`, async () => {
			const f = target === "stage" ? await interrupted() : await baseline();
			const path =
				target === "folder"
					? f.folder
					: target === "meta"
						? f.meta
						: target === "asset"
							? join(f.folder, "0000_fixture_0.sql")
							: target === "stage-parent"
								? join(f.root, ".narrafork")
								: join(f.root, pending(f).stage);
			const backup = `${path}-real`;
			renameSync(path, backup);
			symlinkSync(
				backup,
				path,
				target === "asset" ? "file" : process.platform === "win32" ? "junction" : "dir",
			);
			await expect(
				executePostgresMigrations(target === "stage" ? "resume" : "generate", [], {
					root: f.root,
					runKit: noop,
				}),
			).rejects.toThrow();
			expect(existsSync(backup)).toBe(true);
		});
	test("schema file outside root and schema symlink are rejected before child execution", async () => {
		const f = await baseline();
		const external = fixture();
		await expect(
			executePostgresMigrations("generate", [], {
				root: f.root,
				schemaPath: join(external.root, "server/db/postgres-schema.ts"),
				runKit: noop,
			}),
		).rejects.toThrow("within");
		const link = join(f.root, "linked-schema.ts");
		symlinkSync(join(f.root, "server/db/postgres-schema.ts"), link);
		await expect(
			executePostgresMigrations("generate", [], {
				root: f.root,
				schemaPath: "linked-schema.ts",
				runKit: noop,
			}),
		).rejects.toThrow("real file");
	});
});
