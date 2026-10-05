import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { safeSpawn } from "../../../server/lib/spawn";
import type { ResourceMigrationSnapshot } from "../../finalize-sqlite-resource-migration";
import { generateSqliteMigrations } from "../../generate-sqlite-migrations";

const previous: ResourceMigrationSnapshot = {
	tables: {
		resources: {
			columns: {
				id: { name: "id", type: "text", primaryKey: true },
				old: { name: "old", type: "text" },
			},
			indexes: {
				idx_resources_old: { name: "idx_resources_old", columns: ["old"], isUnique: false },
			},
			foreignKeys: {},
		},
	},
};
const next: ResourceMigrationSnapshot = {
	tables: {
		resources: {
			columns: {
				id: { name: "id", type: "text", primaryKey: true },
				renamed: { name: "renamed", type: "text" },
				added: { name: "added", type: "text", default: "'default'" },
			},
			foreignKeys: {},
		},
	},
};
const generated = `ALTER TABLE resources RENAME COLUMN old TO renamed;
CREATE TABLE __new_resources(id text primary key, renamed text, added text default 'default');
INSERT INTO __new_resources(id,renamed,added) SELECT id,renamed,added FROM resources;
DROP TABLE resources; ALTER TABLE __new_resources RENAME TO resources;`;
const roots: string[] = [];
const ok = { exitCode: 0, stdout: "", stderr: "" };
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "nf-generator-provenance-fixture-"));
	roots.push(root);
	mkdirSync(join(root, "drizzle/meta"), { recursive: true });
	mkdirSync(join(root, "server/db"), { recursive: true });
	writeFileSync(join(root, "server/db/schema.ts"), "fixture schema");
	writeFileSync(
		join(root, "drizzle/meta/_journal.json"),
		JSON.stringify({
			version: "7",
			dialect: "sqlite",
			entries: [
				{ idx: 187, tag: "0187_fixture" },
				{ idx: 188, tag: "0188_fixture" },
			],
		}),
	);
	for (const idx of [187, 188]) {
		const state = structuredClone(previous);
		if (idx === 187) delete state.tables.resources.indexes;
		writeFileSync(
			join(root, `drizzle/meta/${idx.toString().padStart(4, "0")}_snapshot.json`),
			JSON.stringify(state),
		);
	}
	writeFileSync(join(root, "drizzle/0187_fixture.sql"), "fixture immutable history");
	writeFileSync(
		join(root, "drizzle/0188_fixture.sql"),
		"PRAGMA foreign_keys=OFF; CREATE INDEX idx_resources_old ON resources(old); PRAGMA foreign_keys=ON;",
	);
	return root;
}
function emit(root: string, source = generated) {
	const journal = JSON.parse(readFileSync(join(root, "drizzle/meta/_journal.json"), "utf8"));
	journal.entries.push({ idx: 189, tag: "0189_fixture" });
	writeFileSync(join(root, "drizzle/meta/_journal.json"), JSON.stringify(journal));
	writeFileSync(join(root, "drizzle/meta/0189_snapshot.json"), JSON.stringify(next));
	writeFileSync(join(root, "drizzle/0189_fixture.sql"), source);
	return ok;
}
const pending = (root: string) =>
	JSON.parse(readFileSync(join(root, "drizzle/meta/_generation_pending.json"), "utf8"));
const raw = (root: string) => readFileSync(join(root, "drizzle/0189_fixture.sql"), "utf8");
afterEach(async () => {
	for (const child of children.splice(0)) {
		if (child.exitCode === null) child.kill("SIGKILL");
		await child.exited;
	}
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
test("canonical generation finalizes a new receipt-bound batch, is idempotent and preserves memory SQLite rename values", async () => {
	const root = fixture();
	let runs = 0;
	await generateSqliteMigrations([], {
		root,
		runGenerate: async () => {
			runs++;
			return emit(root);
		},
	});
	const finalized = raw(root);
	expect(finalized).toContain("SELECT id, renamed FROM resources");
	expect(existsSync(join(root, "drizzle/meta/_generation_pending.json"))).toBe(false);
	const sqlite = new Database(":memory:");
	try {
		sqlite.exec(
			"CREATE TABLE resources(id text primary key, old text); INSERT INTO resources VALUES ('fixture','原文');",
		);
		sqlite.exec(finalized);
		expect(sqlite.query("SELECT * FROM resources").get()).toEqual({
			id: "fixture",
			renamed: "原文",
			added: "default",
		});
	} finally {
		sqlite.close();
	}
	await generateSqliteMigrations([], {
		root,
		runGenerate: async () => {
			runs++;
			return ok;
		},
	});
	expect(raw(root)).toBe(finalized);
	expect(runs).toBe(2);
	expect(readFileSync(join(root, "drizzle/0187_fixture.sql"), "utf8")).toBe(
		"fixture immutable history",
	);
});
test("a failed finalizer stays pending; a no-changes retry cannot silently accept raw SQL", async () => {
	const root = fixture();
	let runs = 0;
	const failure = () => {
		throw new Error("finalizer unavailable");
	};
	await expect(
		generateSqliteMigrations([], {
			root,
			runGenerate: async () => {
				runs++;
				return emit(root);
			},
			finalize: failure,
		}),
	).rejects.toThrow("unavailable");
	expect(pending(root).phase).toBe("generated");
	expect(pending(root).generated.rawDigest).toHaveLength(64);
	expect(pending(root).schemaDigest).toHaveLength(64);
	await expect(
		generateSqliteMigrations([], {
			root,
			runGenerate: async () => {
				runs++;
				return ok;
			},
			finalize: failure,
		}),
	).rejects.toThrow("unavailable");
	expect(runs).toBe(1);
	expect(raw(root)).toBe(generated);
	await generateSqliteMigrations([], {
		root,
		runGenerate: async () => {
			throw new Error("must resume pending, not rerun Drizzle");
		},
	});
	expect(raw(root)).not.toBe(generated);
});
test("Drizzle failure after emitting artifacts captures original digests before throwing", async () => {
	const root = fixture();
	await expect(
		generateSqliteMigrations([], {
			root,
			runGenerate: async () => {
				emit(root);
				return { ...ok, exitCode: 1, stderr: "Drizzle fixture failure" };
			},
		}),
	).rejects.toThrow("Drizzle fixture failure");
	expect(pending(root).phase).toBe("generated");
	expect(pending(root).generated.rawDigest).toHaveLength(64);
	await generateSqliteMigrations([], {
		root,
		runGenerate: async () => {
			throw new Error("must not rerun");
		},
	});
	expect(raw(root)).toContain("SELECT id, renamed FROM resources");
});
test("uncaptured crash-gap artifacts and duplicate historical tags never grant rewrite authority", async () => {
	const root = fixture();
	await expect(
		generateSqliteMigrations([], {
			root,
			runGenerate: async () => {
				throw new Error("crash before capture");
			},
		}),
	).rejects.toThrow("crash");
	emit(root);
	await expect(generateSqliteMigrations([], { root, runGenerate: async () => ok })).rejects.toThrow(
		"no captured raw digest",
	);
	expect(raw(root)).toBe(generated);
	const second = fixture();
	await expect(
		generateSqliteMigrations([], {
			root: second,
			runGenerate: async () => {
				const path = join(second, "drizzle/meta/_journal.json");
				const journal = JSON.parse(readFileSync(path, "utf8"));
				journal.entries.push({ idx: 189, tag: "0188_fixture" });
				writeFileSync(path, JSON.stringify(journal));
				return ok;
			},
		}),
	).rejects.toThrow("Invalid SQLite generator journal");
	expect(readFileSync(join(second, "drizzle/0188_fixture.sql"), "utf8")).toContain("CREATE INDEX");
});

test("a crash after validation but before commit resumes safely from the captured digests", async () => {
	const root = fixture();
	await expect(
		generateSqliteMigrations([], {
			root,
			runGenerate: async () => emit(root),
			beforeCommit: () => {
				throw new Error("crash fixture");
			},
		}),
	).rejects.toThrow("crash");
	expect(pending(root).phase).toBe("validated");
	expect(raw(root)).toBe(generated);
	await generateSqliteMigrations([], {
		root,
		runGenerate: async () => {
			throw new Error("must not spawn");
		},
	});
	expect(raw(root)).toContain("SELECT id, renamed FROM resources");
	expect(existsSync(join(root, "drizzle/meta/_generation_pending.json"))).toBe(false);
});
test("pending SQL, source schema, baseline and new snapshot tampering never rewrites history", async () => {
	for (const target of [
		"drizzle/0189_fixture.sql",
		"server/db/schema.ts",
		"drizzle/0188_fixture.sql",
		"drizzle/meta/0189_snapshot.json",
	]) {
		const root = fixture();
		await expect(
			generateSqliteMigrations([], {
				root,
				runGenerate: async () => emit(root),
				finalize: () => {
					throw new Error("pause");
				},
			}),
		).rejects.toThrow("pause");
		const path = join(root, target);
		const original = readFileSync(path, "utf8");
		writeFileSync(path, `${original}\n `);
		const retained = raw(root);
		await expect(
			generateSqliteMigrations([], { root, runGenerate: async () => ok }),
		).rejects.toThrow();
		expect(raw(root)).toBe(retained);
		expect(existsSync(join(root, "drizzle/meta/_generation_pending.json"))).toBe(true);
	}
});
test("idx189 does not authorize repairing published history; removed rescue flag always rejects", async () => {
	const root = fixture();
	emit(root);
	const original = raw(root);
	await expect(
		generateSqliteMigrations(["--finalize-unshipped-resource"], {
			root,
			runGenerate: async () => ok,
		}),
	).rejects.toThrow("history rewrite flags");
	expect(raw(root)).toBe(original);
	expect(existsSync(join(root, "drizzle/meta/_generation_pending.json"))).toBe(false);
	// A clone that lost pending provenance still may not treat a raw malformed COPY as a baseline.
	await expect(generateSqliteMigrations([], { root, runGenerate: async () => ok })).rejects.toThrow(
		"Unvalidated",
	);
	expect(raw(root)).toBe(original);
});
test("pending failures persist across a cloned fixture and a fresh Bun process", async () => {
	const root = fixture();
	const unsupported = "UPDATE resources SET old = NULL;";
	await expect(
		generateSqliteMigrations([], { root, runGenerate: async () => emit(root, unsupported) }),
	).rejects.toThrow("Unsupported");
	const clone = mkdtempSync(join(tmpdir(), "nf-generator-cloned-fixture-"));
	roots.push(clone);
	cpSync(root, clone, { recursive: true });
	const modulePath = resolve(import.meta.dir, "../../generate-sqlite-migrations.ts");
	const result = await safeSpawn({
		cmd: [
			"bun",
			"-e",
			`import { generateSqliteMigrations } from ${JSON.stringify(modulePath)}; try { await generateSqliteMigrations([], {root:${JSON.stringify(clone)}, runGenerate:async()=>{throw new Error("must not spawn")}}); process.exit(0); } catch(error) { console.error(error.message); process.exit(23); }`,
		],
		timeout: 10_000,
		maxOutputBytes: 4096,
	});
	expect(result.exitCode).toBe(23);
	expect(result.stderr).toContain("Unsupported migration SQL");
	expect(raw(clone)).toBe(unsupported);
	expect(pending(clone).phase).toBe("generated");
	// Even removing the fixture's pending file cannot convert raw SQL to a successful no-changes run.
	unlinkSync(join(clone, "drizzle/meta/_generation_pending.json"));
	await expect(
		generateSqliteMigrations([], { root: clone, runGenerate: async () => ok }),
	).rejects.toThrow("Unsupported");
	expect(raw(clone)).toBe(unsupported);
});

function workerCode(root: string, mode: "producer" | "fast" | "crash" | "recover") {
	const modulePath = resolve(import.meta.dir, "../../generate-sqlite-migrations.ts");
	return `import {generateSqliteMigrations} from ${JSON.stringify(modulePath)};
	import {appendFileSync,readFileSync,writeFileSync} from "node:fs"; import {join} from "node:path";
	const root=${JSON.stringify(root)}, mode=${JSON.stringify(mode)};
	const pause=async()=>{console.log("READY");await new Promise(resolve=>process.stdin.once("data",resolve));};
	const emit=()=>{const path=join(root,"drizzle/meta/_journal.json");const journal=JSON.parse(readFileSync(path,"utf8"));journal.entries.push({idx:189,tag:"0189_fixture"});writeFileSync(path,JSON.stringify(journal));writeFileSync(join(root,"drizzle/meta/0189_snapshot.json"),${JSON.stringify(JSON.stringify(next))});writeFileSync(join(root,"drizzle/0189_fixture.sql"),${JSON.stringify(generated)});};
	try{await generateSqliteMigrations([],{root,runGenerate:async()=>{if(mode==="recover")throw new Error("recovery must not spawn");appendFileSync(join(root,"producer-runs"),"producer\\n");if(mode==="producer")await pause();emit();if(mode==="crash")await pause();return {exitCode:0,stdout:"",stderr:""};},beforeCommit:mode==="recover"?pause:undefined});console.log("SUCCESS");process.exit(0);}catch(error){console.error(error.message);process.exit(23);}`;
}
const children: ReturnType<typeof Bun.spawn>[] = [];
function pausedWorker(root: string, mode: "producer" | "crash" | "recover") {
	const child = Bun.spawn([process.execPath, "-e", workerCode(root, mode)], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	children.push(child);
	let output = "";
	let wake: (() => void) | undefined;
	const read = async (stream: ReadableStream<Uint8Array>, notify: boolean) => {
		const reader = stream.getReader();
		let text = "";
		const decoder = new TextDecoder();
		for (;;) {
			const { value, done } = await reader.read();
			if (done) return text;
			text += decoder.decode(value, { stream: true });
			if (text.length > 65536) {
				child.kill("SIGKILL");
				throw new Error("Fixture child output exceeds budget");
			}
			if (notify) {
				output = text;
				wake?.();
			}
		}
	};
	const stdout = read(child.stdout, true),
		stderr = read(child.stderr, false);
	return {
		child,
		stdout,
		stderr,
		ready: async () => {
			if (output.includes("READY\n")) return;
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => {
					wake = undefined;
					reject(new Error("Fixture child readiness timed out"));
				}, 10000);
				wake = () => {
					if (output.includes("READY\n")) {
						clearTimeout(timer);
						wake = undefined;
						resolve();
					}
				};
				child.exited.then((code) => {
					clearTimeout(timer);
					wake = undefined;
					reject(new Error(`Fixture child exited before pause: ${code}`));
				});
			});
		},
		resume: () => {
			child.stdin.write("continue\n");
			child.stdin.end();
		},
	};
}
async function contender(root: string, mode: "fast" | "recover" = "fast") {
	return safeSpawn({
		cmd: [process.execPath, "-e", workerCode(root, mode)],
		timeout: 10000,
		maxOutputBytes: 4096,
	});
}
test.each([
	false,
	true,
])("two real Bun producers exclude the loser before emitting, including root alias=%s", async (alias) => {
	const root = fixture();
	let secondRoot = root;
	if (alias) {
		secondRoot = join(root, "alias");
		symlinkSync(root, secondRoot, process.platform === "win32" ? "junction" : "dir");
	}
	const first = pausedWorker(root, "producer");
	await first.ready();
	const baseline = readFileSync(join(root, "drizzle/meta/_journal.json"), "utf8");
	const provenance = readFileSync(join(root, "drizzle/meta/_generation_pending.json"), "utf8");
	const loser = await contender(secondRoot);
	expect(loser.exitCode).toBe(23);
	expect(loser.stderr).toContain("lock exists");
	expect(readFileSync(join(root, "producer-runs"), "utf8")).toBe("producer\n");
	expect(readFileSync(join(root, "drizzle/meta/_journal.json"), "utf8")).toBe(baseline);
	expect(readFileSync(join(root, "drizzle/meta/_generation_pending.json"), "utf8")).toBe(
		provenance,
	);
	expect(existsSync(join(root, "drizzle/0189_fixture.sql"))).toBe(false);
	first.resume();
	expect(await first.child.exited).toBe(0);
	expect(await first.stdout).toContain("SUCCESS");
	expect(await first.stderr).toBe("");
	const final = raw(root);
	expect(final).toContain("SELECT id, renamed FROM resources");
	const journal = JSON.parse(readFileSync(join(root, "drizzle/meta/_journal.json"), "utf8"));
	expect(journal.entries.map((entry: { idx: number }) => entry.idx)).toEqual([187, 188, 189]);
	expect(readFileSync(join(root, "producer-runs"), "utf8")).toBe("producer\n");
	expect(raw(root)).toBe(final); // the rejected process has exited, so cannot overwrite later
});
test("abrupt producer death leaves a conservative lock and uncaptured artifacts cannot be adopted", async () => {
	const root = fixture();
	const first = pausedWorker(root, "crash");
	await first.ready();
	const original = raw(root);
	const provenance = readFileSync(join(root, "drizzle/meta/_generation_pending.json"), "utf8");
	first.child.kill("SIGKILL");
	await first.child.exited;
	await first.stdout;
	await first.stderr;
	const loser = await contender(root);
	expect(loser.exitCode).toBe(23);
	expect(loser.stderr).toContain("explicit repair");
	expect(raw(root)).toBe(original);
	expect(readFileSync(join(root, "drizzle/meta/_generation_pending.json"), "utf8")).toBe(
		provenance,
	);
	expect(pending(root).phase).toBe("started");
	// Explicit fixture-only operator repair AFTER the owner process exited. No application
	// code automatically removes this directory, even with a claimed dead PID.
	rmSync(join(root, "drizzle/meta/_generation.lock"), { recursive: true });
	await expect(
		generateSqliteMigrations([], {
			root,
			runGenerate: async () => {
				throw new Error("must not spawn");
			},
		}),
	).rejects.toThrow("no captured raw digest");
	expect(raw(root)).toBe(original);
});
test("two real recoverers cannot concurrently finalize a pending batch", async () => {
	const root = fixture();
	await expect(
		generateSqliteMigrations([], {
			root,
			runGenerate: async () => emit(root),
			finalize: () => {
				throw new Error("pause recovery");
			},
		}),
	).rejects.toThrow("pause recovery");
	const original = raw(root);
	const first = pausedWorker(root, "recover");
	await first.ready();
	const provenance = readFileSync(join(root, "drizzle/meta/_generation_pending.json"), "utf8");
	const loser = await contender(root, "recover");
	expect(loser.exitCode).toBe(23);
	expect(loser.stderr).toContain("lock exists");
	expect(raw(root)).toBe(original);
	expect(readFileSync(join(root, "drizzle/meta/_generation_pending.json"), "utf8")).toBe(
		provenance,
	);
	first.resume();
	expect(await first.child.exited).toBe(0);
	expect(await first.stderr).toBe("");
	await first.stdout;
	expect(raw(root)).toContain("SELECT id, renamed FROM resources");
	expect(existsSync(join(root, "producer-runs"))).toBe(false);
	expect(existsSync(join(root, "drizzle/meta/_generation_pending.json"))).toBe(false);
	expect(
		JSON.parse(readFileSync(join(root, "drizzle/meta/_journal.json"), "utf8")).entries,
	).toHaveLength(3);
});
test("valid receipt-less no-changes history verifies its complete index snapshot", async () => {
	const root = fixture();
	const original = readFileSync(join(root, "drizzle/0188_fixture.sql"), "utf8");
	await generateSqliteMigrations([], { root, runGenerate: async () => ok });
	expect(readFileSync(join(root, "drizzle/0188_fixture.sql"), "utf8")).toBe(original);
	expect(existsSync(join(root, "drizzle/meta/_generation_pending.json"))).toBe(false);
});
test.each([
	false,
	true,
])("no-changes history rejects semantic drift even with matching old receipt=%s", async (withReceipt) => {
	for (const dimension of ["FK", "default", "notNull"]) {
		const root = fixture();
		const source = generated.replace(
			"id,renamed,added) SELECT id,renamed,added",
			"id,renamed) SELECT id,renamed",
		);
		emit(root, source);
		const state = structuredClone(next);
		if (dimension === "FK") {
			state.tables.resources.foreignKeys = {
				owner: {
					columnsFrom: ["renamed"],
					tableTo: "users",
					columnsTo: ["id"],
					onDelete: "restrict",
					onUpdate: "no action",
				},
			};
			state.tables.users = {
				columns: { id: { name: "id", type: "text", primaryKey: true } },
				foreignKeys: {},
			};
			for (const idx of [187, 188]) {
				const path = join(root, `drizzle/meta/0${idx}_snapshot.json`);
				const before = JSON.parse(readFileSync(path, "utf8"));
				before.tables.users = state.tables.users;
				writeFileSync(path, JSON.stringify(before));
			}
		} else if (dimension === "default") state.tables.resources.columns.added.default = "'expected'";
		else state.tables.resources.columns.added.notNull = true;
		const snapshotPath = join(root, "drizzle/meta/0189_snapshot.json");
		writeFileSync(snapshotPath, JSON.stringify(state));
		if (withReceipt) {
			const digest = (s: string) => createHash("sha256").update(s).digest("hex");
			writeFileSync(
				join(root, "drizzle/meta/_generation_validated.json"),
				JSON.stringify({
					tag: "0189_fixture",
					sqlDigest: digest(source),
					snapshotDigest: digest(readFileSync(snapshotPath, "utf8")),
					journalDigest: digest(readFileSync(join(root, "drizzle/meta/_journal.json"), "utf8")),
				}),
			);
		}
		await expect(
			generateSqliteMigrations([], { root, runGenerate: async () => ok }),
		).rejects.toThrow("Target DDL differs");
		expect(raw(root)).toBe(source);
		expect(existsSync(join(root, "drizzle/meta/_generation_pending.json"))).toBe(true);
		expect(existsSync(join(root, "drizzle/meta/_generation.lock"))).toBe(false);
	}
});
test("a gracefully failed started batch releases only its lock and legitimately resumes generation", async () => {
	const root = fixture();
	let runs = 0;
	await expect(
		generateSqliteMigrations([], {
			root,
			runGenerate: async () => {
				runs++;
				throw new Error("before emit fixture failure");
			},
		}),
	).rejects.toThrow("before emit fixture failure");
	expect(pending(root).phase).toBe("started");
	expect(existsSync(join(root, "drizzle/meta/_generation.lock"))).toBe(false);
	await generateSqliteMigrations([], {
		root,
		runGenerate: async () => {
			runs++;
			return emit(root);
		},
	});
	expect(runs).toBe(2);
	expect(raw(root)).toContain("SELECT id, renamed FROM resources");
	expect(existsSync(join(root, "drizzle/meta/_generation_pending.json"))).toBe(false);
});
test("generator constructor errors release the lock without writing pending state", async () => {
	const root = fixture();
	unlinkSync(join(root, "server/db/schema.ts"));
	await expect(
		generateSqliteMigrations([], {
			root,
			runGenerate: async () => {
				throw new Error("must not spawn");
			},
		}),
	).rejects.toThrow();
	expect(existsSync(join(root, "drizzle/meta/_generation.lock"))).toBe(false);
	expect(existsSync(join(root, "drizzle/meta/_generation_pending.json"))).toBe(false);
});
