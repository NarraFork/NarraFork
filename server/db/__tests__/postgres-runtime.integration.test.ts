/**
 * PostgreSQL production wiring, end to end against a real temporary PostgreSQL 17.
 *
 * WHAT THIS PINS
 * --------------
 * The P1 package's claim is that the REAL startup path — `server/db/index.ts`'s module
 * evaluation, not a test-only injection — can boot on PostgreSQL: create the client, apply
 * the disk `drizzle-postgres` baseline through the drizzle migrator (not a psql relay),
 * install the FTS catalog, report the backend, and close honestly. And that every
 * misconfiguration (unreachable server, unknown backend, missing URL) is an explicit,
 * credential-free failure instead of a boot on the wrong database.
 *
 * Shape:
 *   - gated by PG_INTEGRATION=1: a temporary podman container per run (`withPostgres`,
 *     random name/credentials — never the developer's real `narrafork-pg` or user data).
 *     When integration is requested, an unavailable database must FAIL, never pass as
 *     "blocked".
 *   - the misconfiguration cases need no server at all (a closed loopback port, a bad
 * selector) and run ungated, each in a SUBPROCESS so the boot path under test is the
 *     real module evaluation, including its refusal to boot.
 *   - no test here starts, stops, or contacts a running NarraFork (ports 7778/7779 are
 *     never bound; `server/main.ts` is never imported).
 */
import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { withPostgres } from "../../../tests/db/pg-test-harness";
import {
	DATABASE_BACKEND_ENV,
	DATABASE_URL_ENV,
	type ResolvedPostgresConfig,
	resolveDatabaseBackendConfig,
	startPostgresRuntime,
} from "../postgres-runtime";

const RUN_TIMEOUT_MS = 420_000;
const BOOT_TIMEOUT_MS = 120_000;
const REPO_ROOT = resolve(import.meta.dir, "../../..");
const migrationJournal = JSON.parse(
	readFileSync(join(REPO_ROOT, "drizzle-postgres/meta/_journal.json"), "utf8"),
) as { entries: { tag: string }[] };
if (!Array.isArray(migrationJournal.entries) || migrationJournal.entries.length === 0) {
	throw new Error("PostgreSQL migration journal must contain at least one migration");
}
const EXPECTED_MIGRATION_COUNT = migrationJournal.entries.length;
const SUBPROCESS_ENTRY = resolve(REPO_ROOT, "tests/db/pg-runtime-subprocess-entry.ts");
// `bun -e` resolves relative imports against a virtual [eval] module, not the cwd —
// always import the database module by absolute path.
const DB_MODULE = resolve(REPO_ROOT, "server/db/index.ts");
const SECRET = "integration-secret-pw";

type BootResult = { code: number; stdout: string; stderr: string };
type BootChild = ReturnType<typeof Bun.spawn>;
interface BootTestOptions {
	/** Private test seam only: callers may shorten, never extend, the production fixture deadline. */
	timeoutMs?: number;
	onChild?: (child: BootChild, ownedHome: string) => void;
}

/**
 * Boot a subprocess against an isolated home with bounded output. The child never inherits
 * NF_READ_BACKEND/NF_WRITE_BACKEND or the ambient DATABASE_URL: each case states its full
 * database configuration explicitly.
 */
async function bootSubprocess(
	args: string[],
	databaseEnv: Record<string, string>,
	options: BootTestOptions = {},
): Promise<BootResult> {
	const timeoutMs = options.timeoutMs ?? BOOT_TIMEOUT_MS;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > BOOT_TIMEOUT_MS)
		throw new Error("Invalid shortened boot deadline");
	const home = mkdtempSync(join(tmpdir(), "nf-pg-boot-"));
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined) continue;
		if (key.startsWith("NF_") || key === "DATABASE_URL" || key === "NARRAFORK_HOME") continue;
		env[key] = value;
	}
	Object.assign(env, { NARRAFORK_HOME: home, NODE_ENV: "test" }, databaseEnv);

	let child: BootChild | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let terminationRequested = false;
	const terminateOwnedChild = () => {
		if (child && child.exitCode === null && !terminationRequested) {
			terminationRequested = true;
			child.kill("SIGKILL");
		}
	};
	try {
		const ownedChild = Bun.spawn([process.execPath, ...args], {
			cwd: REPO_ROOT,
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		child = ownedChild;
		options.onChild?.(ownedChild, home);
		const readCapped = async (stream: ReadableStream<Uint8Array>, cap = 64 * 1024) => {
			const reader = stream.getReader();
			const chunks: Uint8Array[] = [];
			let length = 0;
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				if (length + value.byteLength > cap) {
					terminateOwnedChild();
					throw new Error("subprocess output exceeded the cap");
				}
				length += value.byteLength;
				chunks.push(value.slice());
			}
			const bytes = new Uint8Array(length);
			let offset = 0;
			for (const chunk of chunks) {
				bytes.set(chunk, offset);
				offset += chunk.byteLength;
			}
			return new TextDecoder().decode(bytes);
		};
		const timeout = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => {
				try {
					terminateOwnedChild();
				} catch (error) {
					reject(error);
					return;
				}
				reject(new Error("subprocess boot timed out"));
			}, timeoutMs);
		});
		const [code, stdout, stderr] = await Promise.race([
			Promise.all([
				ownedChild.exited,
				readCapped(ownedChild.stdout),
				readCapped(ownedChild.stderr),
			]),
			timeout,
		]);
		return { code, stdout, stderr };
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		if (child) {
			terminateOwnedChild();
			await child.exited;
		}
		// A failed/timeout reader must not remove the home while its owned child is live.
		rmSync(home, { recursive: true, force: true });
	}
}

describe("owned boot subprocess deadline lifecycle", () => {
	const shortDeadlineMs = 500;
	function observeChild() {
		let child: BootChild | undefined;
		let home: string | undefined;
		let countKills = () => 0;
		let restoreKill = () => {};
		return {
			options: {
				timeoutMs: shortDeadlineMs,
				onChild(ownedChild: BootChild, ownedHome: string) {
					child = ownedChild;
					home = ownedHome;
					// Observe only this real child's method; no global Bun.spawn mock.
					const kill = spyOn(ownedChild, "kill");
					countKills = () => kill.mock.calls.length;
					restoreKill = () => kill.mockRestore();
				},
			} satisfies BootTestOptions,
			get() {
				if (!child || !home) throw new Error("Missing owned boot child observation");
				return { child, home, killCount: countKills() };
			},
			restore: () => restoreKill(),
		};
	}

	test("a fast real child receives no late kill after its cancelled deadline", async () => {
		const observed = observeChild();
		try {
			const result = await bootSubprocess(
				["--eval", 'console.log("fast boot complete")'],
				{},
				observed.options,
			);
			expect(result.code).toBe(0);
			expect(result.stdout.trim()).toBe("fast boot complete");
			expect(result.stderr).toBe("");
			// The former uncancelled Bun.sleep deadline would call this child's kill here.
			await Bun.sleep(shortDeadlineMs + 150);
			const receipt = observed.get();
			expect(receipt.child.exitCode).toBe(0);
			expect(receipt.killCount).toBe(0);
			expect(existsSync(receipt.home)).toBe(false);
		} finally {
			observed.restore();
		}
	});

	test("a real stalled child is killed and reaped before timeout cleanup deletes its home", async () => {
		const observed = observeChild();
		try {
			let failure: unknown;
			try {
				await bootSubprocess(["--eval", "await Bun.sleep(60000)"], {}, observed.options);
			} catch (error) {
				failure = error;
			}
			if (!(failure instanceof Error)) throw new Error("Stalled boot did not reject");
			expect(failure.message).toBe("subprocess boot timed out");
			const receipt = observed.get();
			expect(receipt.killCount).toBe(1);
			// Signal termination leaves exitCode null; exited is the reaped numeric result.
			const reapedCode = await receipt.child.exited;
			expect(reapedCode).toBeNumber();
			expect(reapedCode).not.toBe(0);
			expect(existsSync(receipt.home)).toBe(false);
		} finally {
			observed.restore();
		}
	});

	test("a real stdout cap error reaps its child and retires the pending deadline", async () => {
		const observed = observeChild();
		try {
			let failure: unknown;
			try {
				await bootSubprocess(
					["--eval", 'process.stdout.write("x".repeat(128 * 1024)); await Bun.sleep(60000)'],
					{},
					observed.options,
				);
			} catch (error) {
				failure = error;
			}
			if (!(failure instanceof Error)) throw new Error("Oversized stdout did not reject");
			expect(failure.message).toBe("subprocess output exceeded the cap");
			await Bun.sleep(shortDeadlineMs + 150);
			const receipt = observed.get();
			expect(receipt.killCount).toBe(1);
			// Signal termination leaves exitCode null; exited is the reaped numeric result.
			const reapedCode = await receipt.child.exited;
			expect(reapedCode).toBeNumber();
			expect(reapedCode).not.toBe(0);
			expect(existsSync(receipt.home)).toBe(false);
		} finally {
			observed.restore();
		}
	});
});

function postgresConfig(
	port: number,
	credentials: { user: string; password: string; database: string },
): ResolvedPostgresConfig {
	const url = `postgres://${encodeURIComponent(credentials.user)}:${encodeURIComponent(credentials.password)}@127.0.0.1:${port}/${credentials.database}`;
	const resolved = resolveDatabaseBackendConfig(
		{ [DATABASE_BACKEND_ENV]: "postgres", [DATABASE_URL_ENV]: url },
		undefined,
	);
	if (resolved.backend !== "postgres") throw new Error("expected a postgres config");
	return resolved;
}

describe("postgres runtime on a real PostgreSQL 17", () => {
	test.skipIf(process.env.PG_INTEGRATION !== "1")(
		"startup applies the disk baseline and the FTS catalog; shutdown closes and gates",
		async () => {
			const result = await withPostgres(async ({ port, credentials }) => {
				try {
					const config = postgresConfig(port, credentials);
					const runtime = await startPostgresRuntime(config);
					try {
						// The disk drizzle-postgres baseline really ran: the drizzle ledger has the
						// migration and the real tables exist.
						const migrations = await runtime.readMigrationState();
						expect(migrations.length).toBe(EXPECTED_MIGRATION_COUNT);
						expect(migrations[0]?.hash).toBeTruthy();
						await runtime.executor.unsafe(`SELECT 1 FROM "chapters" LIMIT 0`);
						await runtime.executor.unsafe(`SELECT 1 FROM "knowledge_entries" LIMIT 0`);

						// The FTS catalog is complete and the trigger invariant works through this
						// runtime: a base-row write maintains its shadow row in the same transaction.
						const clean = await runtime.probeFtsDrift();
						expect(clean.drifted).toBe(false);
						const now = new Date().toISOString();
						await runtime.executor.unsafe(
							`INSERT INTO users (id, username, password_hash, created_at) VALUES ($1, $1, 'x', $2)`,
							["p1rt-user", now],
						);
						await runtime.executor.unsafe(
							`INSERT INTO projects (id, name, created_at, updated_at) VALUES ($1, $1, $2, $2)`,
							["p1rt-project", now],
						);
						await runtime.executor.unsafe(
							`INSERT INTO chapters (id, project_id, title, description, branch, base_branch, created_at, updated_at)
						 VALUES ($1, $2, $3, $4, 'b1', 'main', $5, $5)`,
							["p1rt-chapter", "p1rt-project", "runtime chapter", "via the runtime", now],
						);
						expect(
							await runtime.executor.unsafe(
								`SELECT title FROM "search_chapters" WHERE id = 'p1rt-chapter'`,
							),
						).toEqual([{ title: "runtime chapter" }]);

						// Shutdown: close is idempotent and the executor refuses new work immediately.
						await runtime.close();
						await runtime.close();
						await expect(runtime.executor.unsafe("SELECT 1")).rejects.toThrow(/no longer accepted/);

						// A second startup over the same database is idempotent: no re-migration
						// error, no drift.
						const restarted = await startPostgresRuntime(config);
						try {
							expect((await restarted.readMigrationState()).length).toBe(EXPECTED_MIGRATION_COUNT);
							expect((await restarted.probeFtsDrift()).drifted).toBe(false);
						} finally {
							await restarted.close();
						}
						return "ok";
					} catch (error) {
						await runtime.close().catch(() => {});
						throw error;
					}
				} catch (error) {
					// withPostgres reduces a callback throw to a generic "callback failed"; keep
					// the real reason in the returned string so the assertion diff shows it.
					return `callback-error: ${error instanceof Error ? error.message : String(error)}`;
				}
			});
			if (typeof result !== "string") {
				throw new Error(
					`postgres-runtime integration unavailable: ${
						result.status === "blocked" || result.status === "failed"
							? result.reason
							: "unexpected harness result"
					}`,
				);
			}
			expect(result).toBe("ok");
		},
		RUN_TIMEOUT_MS,
	);

	test.skipIf(process.env.PG_INTEGRATION !== "1")(
		"the real db module boots in PG mode in a subprocess: backend, stores, health shape, shutdown",
		async () => {
			const result = await withPostgres(async ({ port, credentials }) => {
				const url = `postgres://${encodeURIComponent(credentials.user)}:${encodeURIComponent(credentials.password)}@127.0.0.1:${port}/${credentials.database}`;
				try {
					const boot = await bootSubprocess([SUBPROCESS_ENTRY], {
						[DATABASE_BACKEND_ENV]: "postgres",
						[DATABASE_URL_ENV]: url,
					});
					// Credentials must not survive into ANY subprocess output.
					expect(boot.stderr).not.toContain(credentials.password);
					expect(boot.stdout).not.toContain(credentials.password);
					expect(boot.stderr).not.toContain(url);
					if (boot.code !== 0) {
						throw new Error(
							`PG-mode boot subprocess exited ${boot.code}: ${boot.stderr.slice(-800)}`,
						);
					}
					// The logger writes its own JSON lines to stdout too (some carrying a
					// "backend" field); the entry's two descriptor lines are identified by
					// their own distinctive keys.
					const lines = boot.stdout
						.trim()
						.split("\n")
						.map((line) => {
							try {
								return JSON.parse(line) as Record<string, unknown>;
							} catch {
								return null;
							}
						})
						.filter(
							(line): line is Record<string, unknown> =>
								line !== null && ("accounts" in line || "executorRejectedAfterClose" in line),
						);
					expect(lines[0]).toMatchObject({
						backend: "postgres",
						// The composition seam injected every store from this one runtime: registration
						// answered a real COUNT over PG, and search resolved to the postgres backend.
						searchBackend: "postgres",
						accounts: 0,
						ftsDrifted: false,
						missingTriggers: [],
						migrationCount: EXPECTED_MIGRATION_COUNT,
						// No clean-shutdown marker concept: reported as "cannot skip verification".
						wasClean: false,
					});
					expect(lines[1]).toEqual({ executorRejectedAfterClose: true });
					return "ok";
				} catch (error) {
					// withPostgres reduces a callback throw to a generic "callback failed"; keep
					// the real reason in the returned string so the assertion diff shows it.
					return `callback-error: ${error instanceof Error ? error.message : String(error)}`;
				}
			});
			if (typeof result !== "string") {
				throw new Error(
					`PG-mode boot integration unavailable: ${
						result.status === "blocked" || result.status === "failed"
							? result.reason
							: "unexpected harness result"
					}`,
				);
			}
			expect(result).toBe("ok");
		},
		RUN_TIMEOUT_MS,
	);
});

describe("main.ts wiring (source-level; main.ts binds ports and cannot be imported)", () => {
	// Same pattern as routes/__tests__/graph-read-backend-gate.test.ts: the entrypoint's
	// wiring is pinned by source assertions, while the behaviour it wires is covered by the
	// subprocess boot above.
	const mainSource = readFileSync(resolve(REPO_ROOT, "server/main.ts"), "utf8");

	test("health reports the active backend", () => {
		expect(mainSource).toContain("database: { backend: activeDatabaseBackend }");
	});

	test("the SQLite-only integrity probe is gated off the PostgreSQL backend", () => {
		expect(mainSource).toContain(
			'if (activeDatabaseBackend === "sqlite") {\n\tscheduleBackgroundIntegrityCheck(startupShutdownState);',
		);
	});

	test("graceful shutdown closes the PostgreSQL runtime in drain order", () => {
		expect(mainSource).toContain('"postgresRuntime.close"');
		// After the drain steps, before the clean-marker/lock decision.
		const drainIndex = mainSource.indexOf('"websocketHandlers.drain"');
		const closeIndex = mainSource.indexOf('"postgresRuntime.close"');
		const markerIndex = mainSource.indexOf("markDatabaseCleanShutdown()", drainIndex);
		expect(drainIndex).toBeGreaterThan(-1);
		expect(closeIndex).toBeGreaterThan(drainIndex);
		expect(markerIndex).toBeGreaterThan(closeIndex);
	});

	test("the composition seam is invoked exactly once, from the runtime", () => {
		expect(mainSource).toContain("if (postgresRuntime) {");
		expect(mainSource).toContain("composePostgresStores(postgresRuntime)");
	});
});

describe("fail-closed boot (no PostgreSQL server needed)", () => {
	test("postgres selected without a URL refuses to boot", async () => {
		const boot = await bootSubprocess(["-e", `await import(${JSON.stringify(DB_MODULE)})`], {
			[DATABASE_BACKEND_ENV]: "postgres",
		});
		expect(boot.code).not.toBe(0);
		expect(boot.stderr).toContain("no connection URL");
	});

	test("an unknown backend refuses to boot", async () => {
		const boot = await bootSubprocess(["-e", `await import(${JSON.stringify(DB_MODULE)})`], {
			[DATABASE_BACKEND_ENV]: "couchdb",
		});
		expect(boot.code).not.toBe(0);
		expect(boot.stderr).toContain("Unknown database backend");
	});

	test("an unreachable PostgreSQL fails at the connection stage, without credentials", async () => {
		const url = `postgres://nf:${SECRET}@127.0.0.1:1/narrafork`;
		const boot = await bootSubprocess(["-e", `await import(${JSON.stringify(DB_MODULE)})`], {
			[DATABASE_BACKEND_ENV]: "postgres",
			[DATABASE_URL_ENV]: url,
		});
		expect(boot.code).not.toBe(0);
		expect(boot.stderr).toContain('PostgreSQL startup failed at stage "connection"');
		expect(boot.stderr).not.toContain(SECRET);
		expect(boot.stderr).not.toContain(url);
	});

	test("the SQLite default ignores an ambient DATABASE_URL and boots normally", async () => {
		const boot = await bootSubprocess(
			[
				"-e",
				`const m = await import(${JSON.stringify(DB_MODULE)}); ` +
					"console.log(JSON.stringify({ backend: m.activeDatabaseBackend })); " +
					"m.releaseDatabaseInstanceLockOnly(); process.exit(0);",
			],
			{ DATABASE_URL: `postgres://nf:${SECRET}@127.0.0.1:1/narrafork` },
		);
		expect(boot.code).toBe(0);
		// The logger writes its own JSON lines to stdout (including exit-handler lines AFTER
		// the descriptor); find the descriptor by its distinctive key.
		const descriptorLine = boot.stdout
			.trim()
			.split("\n")
			.find((line) => line.includes('"backend"'));
		expect(descriptorLine).toBeDefined();
		expect(JSON.parse(descriptorLine ?? "")).toEqual({ backend: "sqlite" });
		// The ambient URL is reported as ignored, but its value never appears anywhere.
		expect(boot.stderr).not.toContain(SECRET);
	});
});
