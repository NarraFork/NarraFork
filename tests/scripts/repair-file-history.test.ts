import { Database } from "bun:sqlite";
import { afterEach, describe, expect, mock, setDefaultTimeout, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	linkSync,
	lstatSync,
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
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	FileHistoryRepairSafetyError,
	parseFileHistoryRepairArguments,
	prepareFileHistoryRepair,
	type RepairArguments,
	type RepairSafetyContext,
	readRepairProcessIdentity,
} from "../../scripts/lib/file-history-repair";
import {
	FileHistoryRepairDataError,
	type RepairPreflight,
	type RepairResult,
	type RepairVerification,
} from "../../scripts/lib/file-history-repair-data";
import { runFileHistoryRepairWorker } from "../../scripts/repair-file-history";
import {
	addFixtureEffect,
	createFileHistoryRepairFixture,
	FIXTURE_CONTENT,
	fixtureSnapshot,
} from "./file-history-repair-data-fixture";

// Each real /proc observation still has its independent 15s hard limit. A CLI
// performs several mandatory observations; the test runner must allow their total.
setDefaultTimeout(120_000);
const roots: string[] = [];
const contexts: RepairSafetyContext[] = [];
const script = resolve("scripts/repair-file-history.ts");
function fixture(): RepairArguments {
	const dataDir = mkdtempSync(join(tmpdir(), "nf-history-cli-"));
	roots.push(dataDir);
	chmodSync(dataDir, 0o700);
	mkdirSync(join(dataDir, "file-change-blobs"), { mode: 0o700 });
	writeFileSync(
		join(dataDir, "file-change-source.json"),
		JSON.stringify({ version: 1, id: randomUUID() }),
		{ mode: 0o600 },
	);
	// Safety tests never open this file with SQLite; only the explicit CLI fixtures do.
	const database = join(dataDir, "narrafork.db");
	writeFileSync(database, Buffer.alloc(4096), { mode: 0o600 });
	return {
		mode: "check",
		dataDir,
		database,
		confirmAutoRestartDisabled: true,
		minFreeBytes: 16_777_216n,
		timeoutMs: 120_000,
	};
}
function argv(args: RepairArguments): string[] {
	return [
		"--data-dir",
		args.dataDir,
		"--database",
		args.database,
		"--confirm-auto-restart-disabled",
		"--timeout-ms",
		String(args.timeoutMs),
		"--min-free-bytes",
		args.minFreeBytes.toString(),
	];
}
function prepare(args: RepairArguments): RepairSafetyContext {
	const context = prepareFileHistoryRepair(args);
	contexts.push(context);
	return context;
}
async function collect(stream: ReadableStream<Uint8Array>, limit = 65536): Promise<string> {
	const reader = stream.getReader();
	let total = 0;
	const chunks: Uint8Array[] = [];
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			total += chunk.value.length;
			if (total > limit) throw new Error("fixture output limit");
			chunks.push(chunk.value);
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks).toString("utf8");
}
function fixtureEnvironment(dataDir: string): NodeJS.ProcessEnv {
	// Bun may create ~/.bun caches. Keep the runtime HOME separate from application data.
	const home = mkdtempSync(`${dataDir}-home-`);
	chmodSync(home, 0o700);
	roots.push(home);
	return {
		...process.env,
		HOME: home,
		USERPROFILE: home,
		NARRAFORK_HOME: home,
		NF_TEST_SQLITE_TEMPLATE: "0",
		NARRAFORK_ALLOW_MULTIPLE: "",
		NARRAFORK_FORCE_UNLOCK: "",
	};
}
async function childResult(command: string[], dataDir: string) {
	const started = performance.now();
	let watchdogExpired = false;
	const child = Bun.spawn(command, {
		env: fixtureEnvironment(dataDir),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const watchdog = setTimeout(() => {
		watchdogExpired = true;
		child.kill("SIGTERM");
	}, 130_000);
	try {
		const [stdout, stderr, code] = await Promise.all([
			collect(child.stdout),
			collect(child.stderr),
			child.exited,
		]);
		return {
			stdout,
			stderr,
			code,
			signal: child.signalCode,
			watchdogExpired,
			elapsedMs: Math.round(performance.now() - started),
		};
	} finally {
		clearTimeout(watchdog);
	}
}
afterEach(() => {
	for (const context of contexts.splice(0)) {
		try {
			context.close();
		} catch {
			/* Deliberately corrupted fixture owners remain isolated. */
		}
	}
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	mock.restore();
});

describe("offline file-history CLI arguments", () => {
	test("defaults to check with explicit canonical absolute pairing", () => {
		const args = fixture();
		expect(parseFileHistoryRepairArguments(argv(args)).mode).toBe("check");
		expect(parseFileHistoryRepairArguments([...argv(args), "--verify"]).mode).toBe("verify");
		expect(
			parseFileHistoryRepairArguments([...argv(args), "--apply", "--confirm-discard-file-history"])
				.mode,
		).toBe("apply");
	});
	test("refuses missing confirmations, conflicting and unsupported arguments", () => {
		const args = fixture();
		for (const input of [
			[],
			["--data-dir", args.dataDir, "--database", args.database],
			[...argv(args), "--apply"],
			[...argv(args), "--check", "--verify"],
			[...argv(args), "--backup"],
			[...argv(args), "--force"],
			[...argv(args), "--confirm-discard-file-history"],
			[...argv(args).slice(0, 5), "--min-free-bytes", "1"],
			[...argv(args).slice(0, 5), "--timeout-ms", "0"],
			[...argv(args), "--database", args.database],
			["--data-dir", "relative", "--database", args.database, "--confirm-auto-restart-disabled"],
		])
			expect(() => parseFileHistoryRepairArguments(input)).toThrow(FileHistoryRepairSafetyError);
	});
	test("CLI rejection never opens or creates a database", async () => {
		const args = fixture();
		const missing = join(args.dataDir, "missing.db");
		const result = await childResult(
			[process.execPath, script, "--data-dir", args.dataDir, "--database", missing, "--apply"],
			args.dataDir,
		);
		expect(result.code).not.toBe(0);
		expect(existsSync(missing)).toBe(false);
		expect(readdirSync(args.dataDir).sort()).toEqual([
			"file-change-blobs",
			"file-change-source.json",
			"narrafork.db",
		]);
	});
});

describe("private paths, source and offline identity", () => {
	test.skipIf(process.geteuid?.() === 0)(
		"unprivileged prepare and CLI refuse maintenance without root proc visibility",
		async () => {
			const args = fixture();
			const before = readFileSync(args.database);
			expect(() => prepareFileHistoryRepair(args)).toThrow("root_proc_visibility_required");
			const result = await childResult([process.execPath, script, ...argv(args)], args.dataDir);
			expect(result.code).not.toBe(0);
			expect(result.stderr).toContain("root_proc_visibility_required");
			expect(readFileSync(args.database)).toEqual(before);
			expect(existsSync(join(args.dataDir, "narrafork.lock"))).toBe(false);
		},
	);
	test.skipIf(process.geteuid?.() !== 0)(
		"reproduces runtime length-prefixed bigint namespace and keeps source/blob/database bytes",
		() => {
			const args = fixture();
			const sourcePath = join(args.dataDir, "file-change-source.json");
			const sourceBytes = readFileSync(sourcePath);
			const databaseBytes = readFileSync(args.database);
			const root = join(args.dataDir, "file-change-blobs");
			writeFileSync(join(root, "physical-blob"), "preserved", { mode: 0o600 });
			const info = lstatSync(root, { bigint: true });
			const parts = [
				JSON.parse(sourceBytes.toString()).id,
				root,
				`${info.dev}:${info.ino}:${info.birthtimeNs > 0n ? info.birthtimeNs : 0n}`,
			];
			const hash = createHash("sha256");
			for (const part of parts) hash.update(`${Buffer.byteLength(part)}:`).update(part);
			const context = prepare(args);
			expect(context.namespaceKey).toBe(hash.digest("hex"));
			context.guard("before_transaction", true);
			expect(readFileSync(sourcePath)).toEqual(sourceBytes);
			expect(readFileSync(args.database)).toEqual(databaseBytes);
			expect(readFileSync(join(root, "physical-blob"), "utf8")).toBe("preserved");
		},
	);
	test("rejects missing source/root, permissions, symlink, DB hardlink and unrelated database path", () => {
		const mutations: ((args: RepairArguments) => void)[] = [
			(a) => unlinkSync(join(a.dataDir, "file-change-source.json")),
			(a) => rmSync(join(a.dataDir, "file-change-blobs"), { recursive: true }),
			(a) => chmodSync(a.dataDir, 0o755),
			(a) => chmodSync(a.database, 0o644),
			(a) => chmodSync(join(a.dataDir, "file-change-source.json"), 0o644),
			(a) => {
				renameSync(a.database, `${a.database}.real`);
				symlinkSync(`${a.database}.real`, a.database);
			},
			(a) => linkSync(a.database, `${a.database}.alias`),
			(a) => {
				a.database = join(a.dataDir, "another.db");
			},
			(a) =>
				writeFileSync(
					join(a.dataDir, "file-change-source.json"),
					'{"version":1,"id":"secret-invalid"}',
				),
		];
		for (const mutate of mutations) {
			const args = fixture();
			mutate(args);
			expect(() => prepareFileHistoryRepair(args)).toThrow();
		}
	});
	test("rejects a canonical data-directory alias without following it", () => {
		const args = fixture();
		const alias = `${args.dataDir}-alias`;
		roots.push(alias);
		symlinkSync(args.dataDir, alias);
		expect(() =>
			prepareFileHistoryRepair({ ...args, dataDir: alias, database: join(alias, "narrafork.db") }),
		).toThrow();
	});
	test.skipIf(process.geteuid?.() !== 0)(
		"rejects insufficient transaction space without making DB copies",
		() => {
			const args = fixture();
			expect(() => prepareFileHistoryRepair(args, { availableBytes: () => 0n })).toThrow(
				"insufficient_transaction_space",
			);
			expect(readdirSync(args.dataDir).sort()).toEqual([
				"file-change-blobs",
				"file-change-source.json",
				"narrafork.db",
			]);
		},
	);
	test.skipIf(process.geteuid?.() !== 0)(
		"unknown, empty and live compatible locks are retained",
		() => {
			for (const payload of ["", "{}", JSON.stringify({ pid: process.pid, token: "unknown" })]) {
				const args = fixture();
				const lock = join(args.dataDir, "narrafork.lock");
				writeFileSync(lock, payload, { mode: 0o600 });
				expect(() => prepareFileHistoryRepair(args)).toThrow();
				expect(readFileSync(lock, "utf8")).toBe(payload);
			}
			const args = fixture();
			const context = prepare(args);
			expect(() => prepareFileHistoryRepair(args)).toThrow("live_or_unknown_lock_holder");
			context.guard("still_owned");
		},
	);
	test.skipIf(process.geteuid?.() !== 0)(
		"a foreign observation domain and unknown tool mutex never grant authority",
		() => {
			const args = fixture();
			const identity = readRepairProcessIdentity();
			writeFileSync(
				join(args.dataDir, "narrafork.lock"),
				JSON.stringify({
					version: 2,
					dbPath: args.database,
					pid: 2147483647,
					token: "foreign",
					uid: process.geteuid?.(),
					maintenanceQualified: true,
					maintenanceIdentity: {
						...identity,
						pid: 2147483647,
						domain: { ...identity.domain, machine: "f".repeat(32) },
					},
				}),
				{ mode: 0o600 },
			);
			expect(() => prepareFileHistoryRepair(args)).toThrow("live_or_unknown_lock_holder");
			const empty = fixture();
			mkdirSync(join(empty.dataDir, ".file-history-repair.lock"), { mode: 0o700 });
			expect(() => prepareFileHistoryRepair(empty)).toThrow("unknown_existing_tool_lock");
		},
	);
	test.skipIf(process.geteuid?.() !== 0)(
		"a second CLI worker refuses an active tool owner without changing its lock",
		async () => {
			const args = fixture();
			const context = prepare(args);
			const before = readFileSync(join(args.dataDir, "narrafork.lock"));
			const second = await childResult([process.execPath, script, ...argv(args)], args.dataDir);
			expect(second.code, JSON.stringify(second)).not.toBe(0);
			expect(second.stderr).toContain("other_storage_holder");
			expect(readFileSync(join(args.dataDir, "narrafork.lock"))).toEqual(before);
			context.guard("second_worker_refused");
		},
	);
	test.skipIf(process.geteuid?.() !== 0)(
		"normal cold-start acquire positively refuses the published maintenance lock",
		async () => {
			const args = fixture();
			const context = prepare(args);
			const module = JSON.stringify(resolve("server/lib/instance-lock.ts"));
			const problems = JSON.stringify(resolve("server/lib/startup-status/startup-problems.ts"));
			const code = `const {acquireInstanceLock}=await import(${module});const {InstanceLockedError}=await import(${problems});try{acquireInstanceLock(process.argv[1]);process.exitCode=7;}catch(error){if(error instanceof InstanceLockedError && error.pid===${context.processIdentity.pid}){console.log('COLD_START_REFUSED');process.exitCode=0;}else{console.error('UNEXPECTED_STARTUP_ERROR');process.exitCode=8;}}`;
			const result = await childResult([process.execPath, "-e", code, args.database], args.dataDir);
			expect(result.code).toBe(0);
			expect(result.stdout).toContain("COLD_START_REFUSED");
			context.guard("cold_start_still_owned");
		},
	);
	test.skipIf(process.geteuid?.() !== 0)(
		"another process holding the fixture DB refuses maintenance, without service signals",
		async () => {
			const args = fixture();
			const code = `const fs=await import('node:fs');fs.openSync(process.argv[1],'r');console.log('READY');process.stdin.resume();`;
			const child = Bun.spawn([process.execPath, "-e", code, args.database], {
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
			try {
				const first = await child.stdout.getReader().read();
				expect(Buffer.from(first.value ?? []).toString()).toContain("READY");
				expect(() => prepareFileHistoryRepair(args)).toThrow("other_storage_holder");
			} finally {
				child.stdin.end();
				await child.exited;
			}
		},
	);
	test.skipIf(process.geteuid?.() !== 0)(
		"source, root and lock replacement are noticed and foreign owners are never released",
		() => {
			for (const change of ["source", "root", "lock"]) {
				const args = fixture();
				const context = prepare(args);
				if (change === "source")
					writeFileSync(
						join(args.dataDir, "file-change-source.json"),
						JSON.stringify({ version: 1, id: randomUUID() }),
					);
				else if (change === "root") {
					renameSync(join(args.dataDir, "file-change-blobs"), join(args.dataDir, "old-blobs"));
					mkdirSync(join(args.dataDir, "file-change-blobs"), { mode: 0o700 });
				} else {
					unlinkSync(join(args.dataDir, "narrafork.lock"));
					writeFileSync(join(args.dataDir, "narrafork.lock"), "foreign-owner", { mode: 0o600 });
				}
				expect(() => context.guard("before_commit", true)).toThrow();
				if (change === "lock") {
					expect(() => context.close({ status: "succeeded", commitState: "committed" })).toThrow();
					expect(readFileSync(join(args.dataDir, "narrafork.lock"), "utf8")).toBe("foreign-owner");
					expect(JSON.parse(readFileSync(context.reportPath, "utf8"))).toMatchObject({
						status: "failed",
						startupAllowed: false,
						commitState: "committed",
					});
				}
			}
		},
	);
	test.skipIf(process.geteuid?.() !== 0)(
		"small reports stay valid across repeated shorter rewrites and reject oversized output",
		() => {
			const context = prepare(fixture());
			context.writeReport({ phase: "longer", processedRows: 123456789, status: "in_progress" });
			context.writeReport({ phase: "done" });
			const raw = readFileSync(context.reportPath, "utf8");
			expect(raw.includes("\0")).toBe(false);
			expect(JSON.parse(raw)).toMatchObject({ phase: "done" });
			expect(lstatSync(context.reportPath).mode & 0o777).toBe(0o600);
			expect(lstatSync(resolve(context.reportPath, "..")).mode & 0o777).toBe(0o700);
			expect(() => context.writeReport({ stage: "x".repeat(8192) })).toThrow("report_size_limit");
			expect(readFileSync(context.reportPath, "utf8")).toBe(raw);
		},
	);
	test.skipIf(process.geteuid?.() !== 0)(
		"report parent failure stops before SQLite is opened",
		() => {
			const args = fixture();
			writeFileSync(join(args.dataDir, "file-history-maintenance"), "not-directory", {
				mode: 0o600,
			});
			const before = readFileSync(args.database);
			expect(() => prepareFileHistoryRepair(args)).toThrow();
			expect(readFileSync(args.database)).toEqual(before);
			expect(existsSync(join(args.dataDir, "narrafork.lock"))).toBe(false);
		},
	);
});

describe.skipIf(process.geteuid?.() !== 0)("isolated Bun CLI end-to-end", () => {
	test("signal cancellation affects only fixture-owned workers and never reports success", async () => {
		const args = fixture();
		unlinkSync(args.database);
		const db = new Database(args.database, { create: true });
		chmodSync(args.database, 0o600);
		createFileHistoryRepairFixture(db);
		db.transaction(() => {
			for (let index = 0; index < 2048; index++) addFixtureEffect(db, `signal-effect-${index}`);
			db.exec(
				"UPDATE file_change_operations SET expected_effect_count=2049,prepared_effect_count=2049,settled_effect_count=2049",
			);
		})();
		const before = fixtureSnapshot(db);
		db.close(false);
		const child = Bun.spawn(
			[process.execPath, script, ...argv(args), "--apply", "--confirm-discard-file-history"],
			{
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				env: fixtureEnvironment(args.dataDir),
			},
		);
		const watchdog = setTimeout(() => child.kill("SIGTERM"), 60_000);
		const reader = child.stdout.getReader();
		try {
			const first = await reader.read();
			expect(Buffer.from(first.value ?? []).toString()).toContain("offline_preflight");
			child.kill("SIGINT");
			reader.releaseLock();
			const [, stderr, status] = await Promise.all([
				collect(child.stdout),
				collect(child.stderr),
				child.exited,
			]);
			expect(status).not.toBe(0);
			expect(stderr).toContain("禁止启动");
			const after = new Database(args.database, { create: false, readonly: true });
			expect(fixtureSnapshot(after)).toEqual(before);
			after.close(false);
			for (const name of readdirSync(join(args.dataDir, "file-history-maintenance")))
				expect(
					JSON.parse(readFileSync(join(args.dataDir, "file-history-maintenance", name), "utf8"))
						.status,
				).not.toBe("succeeded");
		} finally {
			clearTimeout(watchdog);
			if (child.exitCode === null) child.kill("SIGTERM");
			await child.exited;
		}
	}, 120_000);
	test("default check, apply and verify preserve business/source/blob and expire history", async () => {
		const args = fixture();
		unlinkSync(args.database);
		const initial = new Database(args.database, { create: true, strict: true });
		chmodSync(args.database, 0o600);
		createFileHistoryRepairFixture(initial);
		const protectedTables = [
			"users",
			"narrators",
			"narrator_messages",
			"narrator_message_refs",
			"narrator_tool_calls",
			"unrelated_business",
			"file_attributions",
			"file_change_operations",
			"file_history_clock",
		];
		const businessBefore = fixtureSnapshot(initial, protectedTables);
		const historyBefore = fixtureSnapshot(initial);
		initial.close(false);
		const sourcePath = join(args.dataDir, "file-change-source.json");
		const sourceBefore = readFileSync(sourcePath);
		const blobPath = join(args.dataDir, "file-change-blobs", "retained-object");
		writeFileSync(blobPath, FIXTURE_CONTENT, { mode: 0o600 });
		const check = await childResult([process.execPath, script, ...argv(args)], args.dataDir);
		expect(check.code, JSON.stringify(check)).toBe(0);
		const checked = new Database(args.database, { readonly: true, create: false });
		expect(fixtureSnapshot(checked)).toEqual(historyBefore);
		checked.close(false);
		const apply = await childResult(
			[process.execPath, script, ...argv(args), "--apply", "--confirm-discard-file-history"],
			args.dataDir,
		);
		expect(apply.code, JSON.stringify(apply)).toBe(0);
		expect(apply.stdout).toContain("提交状态: committed");
		expect(`${apply.stdout}${apply.stderr}`).not.toContain("private fixture secret");
		expect(`${apply.stdout}${apply.stderr}`).not.toContain("business body must remain");
		const repaired = new Database(args.database, { readonly: true, create: false });
		expect(fixtureSnapshot(repaired, protectedTables)).toEqual(businessBefore);
		expect(
			repaired
				.query(
					"SELECT used_bytes,reserved_bytes,quota_bytes,generation FROM file_change_storage_budgets",
				)
				.get(),
		).toMatchObject({ used_bytes: 0, reserved_bytes: 0, quota_bytes: 987654321, generation: 42 });
		expect(
			repaired.query("SELECT status FROM revert_operations WHERE id='revert-planned'").get(),
		).toEqual({ status: "expired" });
		const afterApply = fixtureSnapshot(repaired);
		repaired.close(false);
		const verify = await childResult(
			[process.execPath, script, ...argv(args), "--verify"],
			args.dataDir,
		);
		expect(verify.code, JSON.stringify(verify)).toBe(0);
		for (const run of [check, apply, verify]) expect(run.watchdogExpired).toBe(false);
		console.info(
			`CLI fixture durations: check_ms=${check.elapsedMs}, apply_ms=${apply.elapsedMs}, verify_ms=${verify.elapsedMs}`,
		);
		const verified = new Database(args.database, { readonly: true, create: false });
		expect(fixtureSnapshot(verified)).toEqual(afterApply);
		verified.close(false);
		expect(readFileSync(sourcePath)).toEqual(sourceBefore);
		expect(readFileSync(blobPath, "utf8")).toBe(FIXTURE_CONTENT);
		const reportDir = join(args.dataDir, "file-history-maintenance");
		const reports = readdirSync(reportDir);
		expect(reports).toHaveLength(3);
		for (const name of reports) {
			const bytes = readFileSync(join(reportDir, name));
			expect(bytes.length).toBeLessThanOrEqual(8192);
			const report = JSON.parse(bytes.toString());
			expect(report).toMatchObject({
				status: "succeeded",
				startupAllowed: report.mode !== "check",
			});
		}
		expect(readdirSync(args.dataDir).some((name) => /backup|copy|dump/i.test(name))).toBe(false);
	}, 400_000);
});

function workerHarness(
	args: RepairArguments,
	failure: "verify" | "close" | "after_close" | "none",
	mode: RepairArguments["mode"] = "apply",
) {
	const records: Record<string, unknown>[] = [];
	const context: RepairSafetyContext = {
		namespaceKey: "a".repeat(64),
		reportPath: join(args.dataDir, "summary.json"),
		processIdentity: readRepairProcessIdentity(),
		guard(phase) {
			if (failure === "after_close" && phase === "after_database_close")
				throw new FileHistoryRepairSafetyError("other_storage_holder");
		},
		writeReport(report) {
			records.push(report);
		},
		close(report) {
			if (report) records.push(report);
		},
	};
	const database = {
		exec() {},
		close() {
			if (failure === "close") throw new Error("close");
		},
	} as unknown as Database;
	const parent = { ...readRepairProcessIdentity(), pid: process.ppid };
	const code = runFileHistoryRepairWorker({ ...args, mode }, JSON.stringify(parent), {
		prepare: () => context,
		openDatabase: () => database,
		preflight: () => ({ processedRows: 1, namespaceMatches: false }) as RepairPreflight,
		apply: (_db, _identity, options) => {
			options?.afterCommit?.();
			return { committed: true, processedRows: 1 } as RepairResult;
		},
		verify: () => {
			if (failure === "verify")
				throw new FileHistoryRepairDataError("post_commit_fixture", "redacted");
			return { verified: true } as RepairVerification;
		},
	});
	return { records, code };
}
describe("worker commit and final report semantics", () => {
	test("a successful mismatched-namespace check never grants startup authority", () => {
		const { records, code } = workerHarness(fixture(), "none", "check");
		expect(code).toBe(0);
		expect(records.at(-1)).toMatchObject({
			status: "succeeded",
			startupAllowed: false,
			summary: { namespaceMatches: false },
		});
	});
	test("holder reappearance after database close is caught before lock release", () => {
		const { records, code } = workerHarness(fixture(), "after_close");
		expect(code).not.toBe(0);
		expect(records.at(-1)).toMatchObject({
			status: "failed",
			startupAllowed: false,
			code: "other_storage_holder",
			commitState: "committed",
		});
	});
	test("post-commit verification failure retains committed state and startup prohibition", () => {
		const { records, code } = workerHarness(fixture(), "verify");
		expect(code).not.toBe(0);
		expect(records.at(-1)).toMatchObject({
			status: "failed",
			commitState: "committed",
			startupAllowed: false,
		});
	});
	test("database close failure is recorded before final success can be published", () => {
		const { records, code } = workerHarness(fixture(), "close");
		expect(code).not.toBe(0);
		expect(records.some((r) => r.status === "succeeded")).toBe(false);
		expect(records.at(-1)).toMatchObject({
			status: "failed",
			code: "database_close_failed",
			commitState: "committed",
		});
	});
	test("success follows verification and cleanup with bounded numeric summaries", () => {
		const { records, code } = workerHarness(fixture(), "none");
		expect(code).toBe(0);
		expect(records.at(-1)).toMatchObject({ status: "succeeded", commitState: "committed" });
	});
});
