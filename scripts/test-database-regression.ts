#!/usr/bin/env bun
/**
 * Per-file isolated regression baseline runner for the dual-database work.
 *
 * Why this exists: `bun test <dir>` runs many test files inside one process, so
 * `bun:test` module mocks, module-registry state and same-process SQLite/WAL
 * temp state leak between files. A single aggregate pass/fail count from such a
 * run cannot answer "is this file red on its own?", which is the only question a
 * migration baseline needs. This runner therefore spawns one `bun test <file>`
 * subprocess per file and records an explicit per-file identity.
 *
 * Guarantees, in the order they matter:
 *  1. One subprocess per test file, no shared module registry / mock / WAL state.
 *  2. Small concurrency (hard cap 2) so it never starves the machine that also
 *     hosts a live NarraFork server.
 *  3. Per-file timeout with SIGTERM→SIGKILL escalation; a timeout is NEVER a pass.
 *  4. Bounded stdout/stderr: only `outputCapBytes` are ever retained, the rest is
 *     drained and counted; a flood beyond `hardKillBytes` kills the child and is
 *     reported as `output-overflow`, not as a pass.
 *  5. Cancellable (SIGINT/SIGTERM): running children are killed and partial
 *     results are still written.
 *  6. Skipped / todo / no-test files get their own status; never counted as pass.
 *  7. Data isolation is inherited from `tests/preload.ts` (bunfig `[test].preload`)
 *     and re-verified by a mandatory preflight file. NARRAFORK_HOME and friends
 *     are stripped from the child env, NODE_ENV is forced to "test", so each child
 *     builds its own temp home and keeps the real-database guard armed.
 *  8. Variable-length summary text in `results.json` (failure messages, test
 *     names, list lengths) is capped with the truncation recorded, so one large
 *     assertion diff cannot inflate the report or this process.
 *
 * The runner only ever spawns `bun test <explicit file path>`. It never touches
 * git state, never writes to the real ~/.narrafork, and never talks to a network
 * provider.
 *
 * Usage:
 *   bun scripts/test-database-regression.ts --batch=acceptance1
 *   bun scripts/test-database-regression.ts --batch=extended --concurrency=2
 *   bun scripts/test-database-regression.ts server/db/fts.test.ts
 *   bun scripts/test-database-regression.ts --batch=all --list
 */

import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";

export const REPO_ROOT = resolve(import.meta.dir, "..");
export const ARTIFACT_PARENT = join(REPO_ROOT, "artifacts");
export const ARTIFACT_ROOT = join(ARTIFACT_PARENT, "dual-database-regression");

/** Mandatory preflight: proves the inherited preload really redirects data paths. */
export const PREFLIGHT_FILE = "tests/preload-isolation.test.ts";

export const MAX_CONCURRENCY = 2;
export const DEFAULT_CONCURRENCY = 2;
export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_OUTPUT_CAP_BYTES = 256 * 1024;
/** Beyond this many total bytes on one stream the child is killed as a flood. */
export const OUTPUT_HARD_KILL_FACTOR = 20;
/** Grace period between SIGTERM and SIGKILL. */
export const KILL_GRACE_MS = 3_000;

/**
 * Batch 1: the files this baseline must answer for first.
 *  - the four files of the previously demonstrated same-process pollution chain
 *  - the source-anchor file (`narrators-file-references`)
 *  - `worktree-watcher-poll` (timing-sensitive, suspected order dependent)
 *  - registration-related files and the new db contract/guard files
 *
 * Registration and db-contract files are owned by other agents in this round;
 * they are only READ and RUN here, never edited.
 */
export const BATCH_ACCEPTANCE1: readonly string[] = [
	// pollution chain (routes)
	"server/routes/__tests__/fs-download.test.ts",
	"server/routes/__tests__/trait-layers.test.ts",
	"server/routes/__tests__/project-membership.test.ts",
	"server/routes/__tests__/projects-delete-fallback.test.ts",
	// source-anchor / mock-anchor suspects
	"tests/server/routes/narrators-file-references.test.ts",
	"server/routes/narrator-file-references.test.ts",
	"server/services/worktree-watcher-poll.test.ts",
	// registration domain (other agent's scope, read-only here)
	"server/services/__tests__/registration-code-service.test.ts",
	"server/lib/__tests__/register-closes-registration.test.ts",
	"server/lib/__tests__/registration-attempt-limiter.test.ts",
	"tests/server/routes/admin-users-and-codes.test.ts",
	// database contract / guard files (other agents' scope, read-only here)
	"server/db/transaction-atomicity-contract.test.ts",
	"server/db/sqlite-dialect-inventory.guard.test.ts",
	"server/db/__tests__/sqlite-backend-baseline.test.ts",
	"server/db/run-migrations.test.ts",
	"server/db/__tests__/integrity-check.test.ts",
];

/**
 * Batch 2: a deliberately bounded expansion into database / auth / ACL /
 * project / chapter / message-persistence files. Bounded on purpose: re-running
 * ~600 files tells us nothing new and costs an hour.
 */
export const BATCH_EXTENDED: readonly string[] = [
	// database layer
	"server/db/fts.test.ts",
	"server/db/sqlite-rebuild-copy.test.ts",
	"server/db/__tests__/acl-grant-migration.test.ts",
	"server/db/__tests__/connection-test-guard.test.ts",
	"server/db/__tests__/connection-guard-subprocess.test.ts",
	"server/db/__tests__/subagent-acl-root-backfill.test.ts",
	// ACL / grants
	"server/services/acl/__tests__/acl-core.test.ts",
	"server/services/__tests__/project-acl.test.ts",
	"server/services/__tests__/narrator-acl.test.ts",
	"server/services/__tests__/narrator-acl-delegation.test.ts",
	"server/services/__tests__/knowledge-acl.test.ts",
	"server/services/__tests__/knowledge-collection-acl.test.ts",
	"server/routes/__tests__/project-acl-gate.test.ts",
	"server/routes/__tests__/narrators-acl-gate.test.ts",
	"server/websocket/narrator-ws-acl.test.ts",
	"tests/server/services/search-chapter-acl.test.ts",
	// auth / oauth persistence
	"tests/server/lib/auth.test.ts",
	"server/lib/__tests__/auth-attempt-limiter.test.ts",
	"server/lib/__tests__/auth-settings.test.ts",
	"server/lib/__tests__/oauth-provider.test.ts",
	"server/lib/__tests__/oauth-client-policy.test.ts",
	"server/middleware/__tests__/auth-oauth-boundary.test.ts",
	"server/services/__tests__/oauth-grant-service.test.ts",
	"server/services/__tests__/oauth-resource-access.test.ts",
	// project / chapter persistence
	"tests/server/routes/admin.test.ts",
	"tests/server/routes/api.test.ts",
	"server/routes/__tests__/projects-oauth-runtime.test.ts",
	"server/services/__tests__/chapter-split.test.ts",
	"server/services/__tests__/chapter-edge-idempotent.test.ts",
	"server/services/__tests__/chapter-lifecycle-fixes.test.ts",
	"tests/server/services/chapter-fork.test.ts",
	// message persistence
	"server/services/__tests__/narrator-messages-history.test.ts",
	"tests/server/services/narrator-message-count.test.ts",
	"tests/server/services/narrator-message-queries.test.ts",
	"tests/server/services/narrator-message-search.test.ts",
	"server/services/__tests__/message-origin.test.ts",
	"server/services/__tests__/subagent-message-origin.test.ts",
];

/**
 * Stage 2 final integration batch. This is intentionally an explicit file list:
 * it covers the changed search/knowledge/recall, storage + db-worker, database
 * lifecycle/maintenance/guards, archive replacement/snapshot contracts, the
 * registration contracts, the runner's own self-tests, and the prior extended
 * regression set. No directory or glob is handed to the child runner.
 */
export const BATCH_STAGE2: readonly string[] = [
	...new Set([
		...BATCH_EXTENDED,
		// Search / knowledge ACL / recall
		"server/services/search/__tests__/search-backend-contract.test.ts",
		"tests/server/services/search.test.ts",
		"tests/server/services/search-knowledge.test.ts",
		"tests/server/services/search-chapter-acl.test.ts",
		"tests/server/services/search-narrator-acl.test.ts",
		"tests/server/services/search-store-shapes.test.ts",
		"tests/server/services/recall-search-port.test.ts",
		"server/services/__tests__/knowledge-acl.test.ts",
		"server/services/__tests__/knowledge-collection-acl.test.ts",
		"server/services/__tests__/knowledge-search.test.ts",
		"server/services/__tests__/knowledge-draft-search.test.ts",
		"server/services/__tests__/knowledge-review-lifecycle.test.ts",
		// Storage / db-worker and database lifecycle maintenance
		"server/lib/db-worker/__tests__/module-boundary.test.ts",
		"server/lib/db-worker/__tests__/pool.test.ts",
		"server/lib/db-worker/__tests__/storage-scan-runner.test.ts",
		"server/services/storage/__tests__/storage-scan-database-category.test.ts",
		"server/services/storage/__tests__/database-storage-port-contract.test.ts",
		"server/services/__tests__/storage-service.test.ts",
		"server/services/__tests__/storage-scan-abort.test.ts",
		"server/services/__tests__/storage-ignored-archives.test.ts",
		"server/services/__tests__/storage-uploads-scan.test.ts",
		"tests/server/services/storage-dir-scan.test.ts",
		"tests/server/services/storage-scan-job-cancel.test.ts",
		"server/services/__tests__/database-maintenance-capability.test.ts",
		// Backend, original database, FTS, migrations, connection and guards
		"server/db/backend/__tests__/verification-gate.test.ts",
		"server/db/backend/__tests__/sqlite-lifecycle.test.ts",
		"server/db/backend/__tests__/port-purity.test.ts",
		"server/db/backend/__tests__/sqlite-maintenance.test.ts",
		"server/db/__tests__/sqlite-backend-baseline.test.ts",
		"server/db/fts.test.ts",
		"server/db/run-migrations.test.ts",
		"server/db/sqlite-rebuild-copy.test.ts",
		"server/db/transaction-atomicity-contract.test.ts",
		"server/db/sqlite-dialect-inventory.guard.test.ts",
		"server/db/__tests__/connection-test-guard.test.ts",
		"server/db/__tests__/connection-guard-subprocess.test.ts",
		"server/db/__tests__/integrity-check.test.ts",
		// Project archive, including replacement atomicity and snapshot columns
		"server/services/project-archive/__tests__/manifest-format.test.ts",
		"server/services/project-archive/__tests__/main-store-contract.test.ts",
		"server/services/project-archive/__tests__/paging.test.ts",
		"server/services/project-archive/__tests__/archive-roundtrip.test.ts",
		"server/services/project-archive/__tests__/replace-atomicity.test.ts",
		// Stage 1 registration contracts and existing registration coverage
		"server/lib/__tests__/register-with-code.test.ts",
		"server/services/__tests__/registration-code-service.test.ts",
		// Runner self-tests
		"tests/scripts/test-database-regression.test.ts",
	]),
];

export const BATCHES: Record<string, readonly string[]> = {
	acceptance1: BATCH_ACCEPTANCE1,
	extended: BATCH_EXTENDED,
	stage2: BATCH_STAGE2,
	all: [...BATCH_ACCEPTANCE1, ...BATCH_EXTENDED],
};

// ---------------------------------------------------------------------------
// JUnit parsing
// ---------------------------------------------------------------------------

export type TestCaseStatus = "pass" | "fail" | "skip" | "todo";

export interface JunitTestCase {
	name: string;
	classname: string;
	file: string;
	line: number | null;
	status: TestCaseStatus;
	failureMessage: string | null;
}

export interface JunitReport {
	testcases: JunitTestCase[];
	/** Counts declared by bun on `<testsuites>`, used as a cross-check. */
	declared: { tests: number; failures: number; skipped: number } | null;
	passed: number;
	failed: number;
	skipped: number;
}

const XML_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
};

export function decodeXmlText(value: string): string {
	return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
		if (entity.startsWith("#x") || entity.startsWith("#X")) {
			const code = Number.parseInt(entity.slice(2), 16);
			return Number.isFinite(code) ? String.fromCodePoint(code) : match;
		}
		if (entity.startsWith("#")) {
			const code = Number.parseInt(entity.slice(1), 10);
			return Number.isFinite(code) ? String.fromCodePoint(code) : match;
		}
		const mapped = XML_ENTITIES[entity];
		return mapped ?? match;
	});
}

function parseAttributes(raw: string): Record<string, string> {
	const attributes: Record<string, string> = {};
	for (const match of raw.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) {
		attributes[match[1]] = decodeXmlText(match[2]);
	}
	return attributes;
}

/**
 * Parse bun's JUnit reporter output into per-test results.
 *
 * Deliberately a scanner rather than a full XML parser: the input is produced by
 * one known writer, and a dependency-free parse keeps this runner usable from a
 * clean checkout. Unparseable input yields `null` so the caller can classify the
 * file as a crash instead of silently reporting zero failures.
 */
export function parseJunit(xml: string): JunitReport | null {
	if (!xml.includes("<testsuites")) return null;

	const suitesMatch = xml.match(/<testsuites\b([^>]*)>/);
	const declared = suitesMatch
		? (() => {
				const attributes = parseAttributes(suitesMatch[1]);
				const toInt = (value: string | undefined) => {
					const parsed = Number.parseInt(value ?? "", 10);
					return Number.isFinite(parsed) ? parsed : 0;
				};
				return {
					tests: toInt(attributes.tests),
					failures: toInt(attributes.failures),
					skipped: toInt(attributes.skipped),
				};
			})()
		: null;

	const testcases: JunitTestCase[] = [];
	const tagPattern = /<testcase\b([^>]*?)(\/>|>)/g;
	for (const match of xml.matchAll(tagPattern)) {
		const attributes = parseAttributes(match[1]);
		const selfClosing = match[2] === "/>";
		let body = "";
		if (!selfClosing) {
			const start = (match.index ?? 0) + match[0].length;
			const end = xml.indexOf("</testcase>", start);
			body = end === -1 ? xml.slice(start) : xml.slice(start, end);
		}

		const failureMatch = body.match(/<failure\b([^>]*)>?/);
		const skippedMatch = body.match(/<skipped\b([^>]*)\/?>/);
		let status: TestCaseStatus = "pass";
		let failureMessage: string | null = null;
		if (failureMatch) {
			status = "fail";
			const failureAttributes = parseAttributes(failureMatch[1]);
			failureMessage = failureAttributes.message ?? null;
		} else if (skippedMatch) {
			const skippedAttributes = parseAttributes(skippedMatch[1]);
			status = skippedAttributes.message === "TODO" ? "todo" : "skip";
		}

		const line = Number.parseInt(attributes.line ?? "", 10);
		testcases.push({
			name: attributes.name ?? "",
			classname: attributes.classname ?? "",
			file: attributes.file ?? "",
			line: Number.isFinite(line) ? line : null,
			status,
			failureMessage,
		});
	}

	return {
		testcases,
		declared,
		passed: testcases.filter((t) => t.status === "pass").length,
		failed: testcases.filter((t) => t.status === "fail").length,
		skipped: testcases.filter((t) => t.status === "skip" || t.status === "todo").length,
	};
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Summary field caps
// ---------------------------------------------------------------------------

/**
 * Hard caps on the variable-length text that reaches `results.json`.
 *
 * The stdout/stderr byte caps do not protect this path: failure messages come
 * from the JUnit report, and a single `toEqual` on a large object or a snapshot
 * diff can be megabytes on its own. Every retained failure stays in memory for
 * the whole run (the results array is only serialized at the end), so an
 * uncapped batch of such files inflates both this process and the artifact until
 * the report is unreadable and the runner becomes the memory problem it was
 * written to avoid.
 *
 * Truncation is always recorded alongside the value, never silent: a clipped
 * message that looks complete would send a reader chasing a difference that is
 * only missing from the report.
 */
export const MAX_FAILURE_MESSAGE_CHARS = 4_000;
export const MAX_TEST_NAME_CHARS = 400;
export const MAX_FAILURES_PER_FILE = 100;
export const MAX_SKIPPED_NAMES_PER_FILE = 200;

export interface CappedText {
	text: string;
	truncated: boolean;
	/** Length before truncation, so a report reader knows how much was dropped. */
	originalChars: number;
}

export function capText(value: string, limit: number): CappedText {
	if (value.length <= limit) {
		return { text: value, truncated: false, originalChars: value.length };
	}
	return { text: value.slice(0, limit), truncated: true, originalChars: value.length };
}

export function capOptionalText(value: string | null, limit: number): CappedText | null {
	return value === null ? null : capText(value, limit);
}

export interface CappedList<T> {
	items: T[];
	truncated: boolean;
	/** Count before truncation. */
	originalCount: number;
}

export function capList<T>(values: readonly T[], limit: number): CappedList<T> {
	if (values.length <= limit) {
		return { items: [...values], truncated: false, originalCount: values.length };
	}
	return { items: values.slice(0, limit), truncated: true, originalCount: values.length };
}

export type FileStatus =
	| "pass"
	| "fail"
	| "timeout"
	| "crash"
	| "output-overflow"
	| "no-tests"
	| "skipped"
	| "missing"
	| "cancelled";

/** Statuses that must never be presented as a green file. */
export const NON_PASS_STATUSES: readonly FileStatus[] = [
	"fail",
	"timeout",
	"crash",
	"output-overflow",
	"no-tests",
	"skipped",
	"missing",
	"cancelled",
];

export interface ClassifyInput {
	exitCode: number | null;
	signal: string | null;
	timedOut: boolean;
	cancelled: boolean;
	outputOverflowKilled: boolean;
	reportExists: boolean;
	report: JunitReport | null;
	/** bun printed "filters did not match any test files". */
	filterMissed: boolean;
}

/**
 * Decide one file's identity.
 *
 * Order is load-bearing. A timeout or an output flood is decided before any
 * partial JUnit report is consulted, because a report written before the kill
 * would otherwise look like a clean pass.
 */
export function classifyRunOutcome(input: ClassifyInput): FileStatus {
	if (input.cancelled) return "cancelled";
	if (input.timedOut) return "timeout";
	if (input.outputOverflowKilled) return "output-overflow";
	if (input.filterMissed) return "missing";
	if (!input.reportExists || input.report === null) {
		return input.exitCode === 0 ? "no-tests" : "crash";
	}
	if (input.report.failed > 0) return "fail";
	if ((input.report.declared?.failures ?? 0) > 0) return "fail";
	if (input.exitCode !== 0) return "crash";
	if (input.report.passed === 0) {
		return input.report.skipped > 0 ? "skipped" : "no-tests";
	}
	return "pass";
}

export function resolveConcurrency(requested: number | undefined): number {
	if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_CONCURRENCY;
	const floored = Math.floor(requested);
	if (floored < 1) return 1;
	return Math.min(floored, MAX_CONCURRENCY);
}

// ---------------------------------------------------------------------------
// Bounded stream reading
// ---------------------------------------------------------------------------

export interface BoundedOutput {
	text: string;
	/** Bytes actually retained (<= capBytes). */
	keptBytes: number;
	/** Bytes seen on the stream, including discarded ones. */
	totalBytes: number;
	truncated: boolean;
}

/**
 * Read a child stream while retaining at most `capBytes`.
 *
 * The stream is still drained after the cap so the child never blocks on a full
 * pipe, but nothing past the cap is buffered in this process. `onOverflow` fires
 * once when `hardKillBytes` is crossed so the caller can kill a flooding child
 * instead of spending the rest of the run discarding its output.
 */
export async function readBoundedStream(
	stream: ReadableStream<Uint8Array> | undefined | null,
	capBytes: number,
	options: { hardKillBytes?: number; onOverflow?: () => void } = {},
): Promise<BoundedOutput> {
	if (!stream) return { text: "", keptBytes: 0, totalBytes: 0, truncated: false };

	const chunks: Uint8Array[] = [];
	let keptBytes = 0;
	let totalBytes = 0;
	let truncated = false;
	let overflowSignalled = false;
	const reader = stream.getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value || value.byteLength === 0) continue;
			totalBytes += value.byteLength;
			if (keptBytes < capBytes) {
				const room = capBytes - keptBytes;
				const slice = value.byteLength <= room ? value : value.subarray(0, room);
				chunks.push(slice);
				keptBytes += slice.byteLength;
				if (slice.byteLength < value.byteLength) truncated = true;
			} else {
				truncated = true;
			}
			const hardKill = options.hardKillBytes;
			if (!overflowSignalled && hardKill !== undefined && totalBytes > hardKill) {
				overflowSignalled = true;
				options.onOverflow?.();
			}
		}
	} catch {
		// A killed child tears the pipe down mid-read; keep what we already have.
		truncated = truncated || totalBytes > keptBytes;
	} finally {
		reader.releaseLock();
	}

	const merged = new Uint8Array(keptBytes);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return {
		text: new TextDecoder().decode(merged),
		keptBytes,
		totalBytes,
		truncated,
	};
}

// ---------------------------------------------------------------------------
// Running one file
// ---------------------------------------------------------------------------

export interface RunFileOptions {
	file: string;
	cwd: string;
	timeoutMs: number;
	outputCapBytes: number;
	hardKillBytes?: number;
	signal?: AbortSignal;
	/** Directory for the temporary JUnit file; created and removed by the caller. */
	reportDir: string;
	env?: Record<string, string | undefined>;
}

export interface FileRunResult {
	file: string;
	status: FileStatus;
	exitCode: number | null;
	signal: string | null;
	durationMs: number;
	timedOut: boolean;
	killedForOutput: boolean;
	stdout: BoundedOutput;
	stderr: BoundedOutput;
	tests: { passed: number; failed: number; skipped: number };
	/**
	 * Failures with every variable-length field already capped. Capping happens
	 * here rather than at serialization time so a huge assertion diff is dropped
	 * before it is held for the rest of the run.
	 */
	failures: CappedList<{
		name: CappedText;
		classname: CappedText;
		line: number | null;
		message: CappedText | null;
	}>;
	skippedNames: CappedList<CappedText>;
	reportParsed: boolean;
}

/**
 * Markers bun prints when the argument matched no test file.
 *
 * Two forms, because the wording depends on the argument shape: a bare filter
 * yields "did not match any test files", while an explicit `./path` yields
 * `Test filter "..." had no matches`. Missing only the second one would classify
 * a deleted or renamed file as a crash and send a reader hunting for a stack
 * trace that does not exist.
 */
const FILTER_MISS_MARKERS = ["did not match any test files", "had no matches"] as const;

export function looksLikeFilterMiss(output: string): boolean {
	return FILTER_MISS_MARKERS.some((marker) => output.includes(marker));
}

/**
 * Force bun to treat the argument as a path rather than a substring filter.
 *
 * `bun test foo.test.ts` is a *filter*: it also matches `many-foo.test.ts`, so a
 * child could run several files and destroy the one-file-per-process guarantee
 * this runner exists for. `bun test ./foo.test.ts` is a path. Absolute paths and
 * paths already starting with `./` or `../` are left alone.
 */
export function toPathArgument(file: string): string {
	if (file.startsWith("./") || file.startsWith("../")) return file;
	if (file.startsWith("/") || /^[A-Za-z]:[\\/]/.test(file)) return file;
	return `./${file}`;
}

/**
 * Environment handed to every child.
 *
 * NARRAFORK_HOME / NARRAFORK_ALLOW_MULTIPLE / NARRAFORK_ORIGINAL_HOME are
 * stripped rather than forwarded: `tests/preload.ts` must be the only thing that
 * decides where a test process stores data, and it refuses an explicit home
 * without NARRAFORK_ALLOW_MULTIPLE. Colour is disabled so the byte caps measure
 * content, not escape sequences.
 *
 * NODE_ENV is forced to "test". `bun test` only defaults it to "test" when it is
 * absent — an inherited "production" or "development" survives into the child and
 * silently disables the real-database guard in `server/db/connection.ts`, which
 * short-circuits on `NODE_ENV !== "test"`. Since this runner is expected to be
 * launched from a shell that also runs the production-mode server
 * (`bun run start:dev` sets NODE_ENV=production), inheriting it would remove the
 * one check that stands between a fixture and the real ~/.narrafork database.
 */
export function buildChildEnv(base: Record<string, string | undefined>): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(base)) {
		if (value === undefined) continue;
		if (key === "NARRAFORK_HOME") continue;
		if (key === "NARRAFORK_ALLOW_MULTIPLE") continue;
		if (key === "NARRAFORK_ORIGINAL_HOME") continue;
		env[key] = value;
	}
	env.NODE_ENV = "test";
	env.NO_COLOR = "1";
	env.FORCE_COLOR = "0";
	return env;
}

export async function runTestFile(options: RunFileOptions): Promise<FileRunResult> {
	const started = Bun.nanoseconds();
	const reportPath = join(options.reportDir, "junit.xml");
	const hardKillBytes = options.hardKillBytes ?? options.outputCapBytes * OUTPUT_HARD_KILL_FACTOR;

	if (options.signal?.aborted) {
		return {
			file: options.file,
			status: "cancelled",
			exitCode: null,
			signal: null,
			durationMs: 0,
			timedOut: false,
			killedForOutput: false,
			stdout: { text: "", keptBytes: 0, totalBytes: 0, truncated: false },
			stderr: { text: "", keptBytes: 0, totalBytes: 0, truncated: false },
			tests: { passed: 0, failed: 0, skipped: 0 },
			failures: capList([], MAX_FAILURES_PER_FILE),
			skippedNames: capList([], MAX_SKIPPED_NAMES_PER_FILE),
			reportParsed: false,
		};
	}

	const proc = Bun.spawn({
		cmd: [
			"bun",
			"test",
			toPathArgument(options.file),
			"--reporter=junit",
			"--reporter-outfile",
			reportPath,
			"--no-orphans",
		],
		cwd: options.cwd,
		env: buildChildEnv(options.env ?? process.env),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});

	let timedOut = false;
	let killedForOutput = false;
	let cancelled = false;
	let killTimer: ReturnType<typeof setTimeout> | undefined;

	const escalate = () => {
		killTimer = setTimeout(() => {
			try {
				proc.kill("SIGKILL");
			} catch {
				// already gone
			}
		}, KILL_GRACE_MS);
	};
	const terminate = () => {
		try {
			proc.kill("SIGTERM");
		} catch {
			// already gone
		}
		escalate();
	};

	const timeoutTimer = setTimeout(() => {
		timedOut = true;
		terminate();
	}, options.timeoutMs);

	const onAbort = () => {
		cancelled = true;
		terminate();
	};
	options.signal?.addEventListener("abort", onAbort, { once: true });

	const onOverflow = () => {
		killedForOutput = true;
		terminate();
	};

	const [stdout, stderr] = await Promise.all([
		readBoundedStream(proc.stdout, options.outputCapBytes, { hardKillBytes, onOverflow }),
		readBoundedStream(proc.stderr, options.outputCapBytes, { hardKillBytes, onOverflow }),
	]);
	const exitCode = await proc.exited;
	clearTimeout(timeoutTimer);
	if (killTimer) clearTimeout(killTimer);
	options.signal?.removeEventListener("abort", onAbort);

	const reportExists = existsSync(reportPath);
	let report: JunitReport | null = null;
	if (reportExists) {
		try {
			report = parseJunit(await Bun.file(reportPath).text());
		} catch {
			report = null;
		}
	}

	const combinedOutput = `${stdout.text}\n${stderr.text}`;
	const status = classifyRunOutcome({
		exitCode,
		signal: proc.signalCode ?? null,
		timedOut,
		cancelled,
		outputOverflowKilled: killedForOutput,
		reportExists,
		report,
		filterMissed: looksLikeFilterMiss(combinedOutput),
	});

	return {
		file: options.file,
		status,
		exitCode,
		signal: proc.signalCode ?? null,
		durationMs: Math.round((Bun.nanoseconds() - started) / 1e6),
		timedOut,
		killedForOutput,
		stdout,
		stderr,
		tests: {
			passed: report?.passed ?? 0,
			failed: report?.failed ?? 0,
			skipped: report?.skipped ?? 0,
		},
		failures: capList(
			(report?.testcases ?? [])
				.filter((testcase) => testcase.status === "fail")
				.map((testcase) => ({
					name: capText(testcase.name, MAX_TEST_NAME_CHARS),
					classname: capText(testcase.classname, MAX_TEST_NAME_CHARS),
					line: testcase.line,
					message: capOptionalText(testcase.failureMessage, MAX_FAILURE_MESSAGE_CHARS),
				})),
			MAX_FAILURES_PER_FILE,
		),
		skippedNames: capList(
			(report?.testcases ?? [])
				.filter((testcase) => testcase.status === "skip" || testcase.status === "todo")
				.map((testcase) => capText(testcase.name, MAX_TEST_NAME_CHARS)),
			MAX_SKIPPED_NAMES_PER_FILE,
		),
		reportParsed: report !== null,
	};
}

// ---------------------------------------------------------------------------
// Pool
// ---------------------------------------------------------------------------

export async function runWithConcurrency<T, R>(
	items: readonly T[],
	limit: number,
	worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (true) {
			const index = next++;
			if (index >= items.length) return;
			results[index] = await worker(items[index], index);
		}
	});
	await Promise.all(runners);
	return results;
}

// ---------------------------------------------------------------------------
// CLI plumbing
// ---------------------------------------------------------------------------

export interface CliOptions {
	batch: string | null;
	files: string[];
	concurrency: number;
	timeoutMs: number;
	outputCapBytes: number;
	list: boolean;
	skipPreflight: boolean;
	label: string | null;
}

export function parseCliArgs(argv: readonly string[]): CliOptions {
	const options: CliOptions = {
		batch: null,
		files: [],
		concurrency: DEFAULT_CONCURRENCY,
		timeoutMs: DEFAULT_TIMEOUT_MS,
		outputCapBytes: DEFAULT_OUTPUT_CAP_BYTES,
		list: false,
		skipPreflight: false,
		label: null,
	};
	for (const arg of argv) {
		if (arg === "--list") {
			options.list = true;
		} else if (arg === "--skip-preflight") {
			options.skipPreflight = true;
		} else if (arg.startsWith("--batch=")) {
			options.batch = arg.slice("--batch=".length);
		} else if (arg.startsWith("--concurrency=")) {
			options.concurrency = resolveConcurrency(Number(arg.slice("--concurrency=".length)));
		} else if (arg.startsWith("--timeout=")) {
			const parsed = Number(arg.slice("--timeout=".length));
			if (Number.isFinite(parsed) && parsed > 0) options.timeoutMs = Math.floor(parsed);
		} else if (arg.startsWith("--output-cap=")) {
			const parsed = Number(arg.slice("--output-cap=".length));
			if (Number.isFinite(parsed) && parsed > 1024) options.outputCapBytes = Math.floor(parsed);
		} else if (arg.startsWith("--label=")) {
			options.label = arg.slice("--label=".length).replace(/[^\w.-]+/g, "-");
		} else if (arg.startsWith("--files=")) {
			options.files.push(
				...arg
					.slice("--files=".length)
					.split(",")
					.map((value) => value.trim())
					.filter(Boolean),
			);
		} else if (!arg.startsWith("-")) {
			options.files.push(arg);
		}
	}
	options.concurrency = resolveConcurrency(options.concurrency);
	return options;
}

export function resolveFileList(options: CliOptions): string[] {
	const files = [...options.files];
	if (options.batch) {
		const batch = BATCHES[options.batch];
		if (!batch) {
			throw new Error(
				`Unknown batch "${options.batch}". Known batches: ${Object.keys(BATCHES).join(", ")}`,
			);
		}
		files.push(...batch);
	}
	return [...new Set(files)];
}

export function sanitizeLogName(file: string): string {
	return file.replace(/[\\/]/g, "__").replace(/[^\w.@-]+/g, "_");
}

interface PathSnapshot {
	path: string;
	exists: boolean;
	size: number | null;
	mtimeMs: number | null;
}

/**
 * Read-only observation of the real data directory.
 *
 * This is evidence, not proof: on a developer box the live NarraFork server is
 * writing to these same files, so a changed mtime does not implicate the tests.
 * The authoritative isolation check is the preflight file, which asserts the
 * resolved db path is inside a temp home.
 */
function snapshotRealHome(): PathSnapshot[] {
	const home = process.env.NARRAFORK_ORIGINAL_HOME ?? process.env.HOME ?? "";
	const base = resolve(home, ".narrafork");
	return ["narrafork.db", "narrafork.db-wal", "narrafork.db-shm", "settings.json"].map((name) => {
		const path = join(base, name);
		try {
			const stats = statSync(path);
			return { path, exists: true, size: stats.size, mtimeMs: stats.mtimeMs };
		} catch {
			return { path, exists: false, size: null, mtimeMs: null };
		}
	});
}

function gitInfo(): { head: string | null; dirtyEntries: number | null } {
	const read = (cmd: string[]): string | null => {
		try {
			const proc = Bun.spawnSync({ cmd, cwd: REPO_ROOT, stdout: "pipe", stderr: "ignore" });
			if (proc.exitCode !== 0) return null;
			return new TextDecoder().decode(proc.stdout).trim();
		} catch {
			return null;
		}
	};
	const head = read(["git", "rev-parse", "HEAD"]);
	const status = read(["git", "status", "--porcelain"]);
	return {
		head,
		dirtyEntries: status === null ? null : status.split("\n").filter(Boolean).length,
	};
}

function createRunDirectory(label: string | null): string {
	if (!existsSync(ARTIFACT_PARENT)) mkdirSync(ARTIFACT_PARENT, { recursive: true });
	if (!existsSync(ARTIFACT_ROOT)) mkdirSync(ARTIFACT_ROOT, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const suffix = label ? `-${label}` : "";
	let candidate = join(ARTIFACT_ROOT, `run-${stamp}${suffix}`);
	let counter = 2;
	while (existsSync(candidate)) {
		candidate = join(ARTIFACT_ROOT, `run-${stamp}${suffix}-${counter}`);
		counter += 1;
	}
	mkdirSync(join(candidate, "logs"), { recursive: true });
	return candidate;
}

function statusLabel(status: FileStatus): string {
	switch (status) {
		case "pass":
			return "PASS";
		case "fail":
			return "FAIL";
		case "timeout":
			return "TIMEOUT";
		case "crash":
			return "CRASH";
		case "output-overflow":
			return "OUTPUT-OVERFLOW";
		case "no-tests":
			return "NO-TESTS";
		case "skipped":
			return "SKIPPED-ONLY";
		case "missing":
			return "MISSING";
		case "cancelled":
			return "CANCELLED";
	}
}

async function main(): Promise<void> {
	const options = parseCliArgs(Bun.argv.slice(2));
	const requested = resolveFileList(options);

	if (requested.length === 0) {
		console.error("No test files selected. Pass --batch=<name> or explicit file paths.");
		console.error(`Known batches: ${Object.keys(BATCHES).join(", ")}`);
		process.exitCode = 2;
		return;
	}

	if (options.list) {
		for (const file of requested) {
			console.log(`${existsSync(join(REPO_ROOT, file)) ? "  " : "??"} ${file}`);
		}
		console.log(`\n${requested.length} file(s).`);
		return;
	}

	const controller = new AbortController();
	const onSignal = () => {
		console.error("\nCancellation requested; killing children and writing partial results.");
		controller.abort();
	};
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);

	const runDir = createRunDirectory(options.label);
	// JUnit files live inside this run's own artifact directory rather than a
	// system temp dir: they are the machine-readable evidence behind results.json
	// and are worth keeping next to it.
	const reportRoot = join(runDir, "junit");
	mkdirSync(reportRoot, { recursive: true });
	const realHomeBefore = snapshotRealHome();
	const startedAt = new Date().toISOString();
	const startedNs = Bun.nanoseconds();

	const runOne = async (file: string): Promise<FileRunResult> => {
		const reportDir = join(reportRoot, sanitizeLogName(file));
		mkdirSync(reportDir, { recursive: true });
		const result = await runTestFile({
			file,
			cwd: REPO_ROOT,
			timeoutMs: options.timeoutMs,
			outputCapBytes: options.outputCapBytes,
			signal: controller.signal,
			reportDir,
		});
		const logPath = join(runDir, "logs", `${sanitizeLogName(file)}.log`);
		writeFileSync(
			logPath,
			[
				`# ${file}`,
				`# status=${result.status} exit=${result.exitCode} signal=${result.signal}`,
				`# durationMs=${result.durationMs} timedOut=${result.timedOut}`,
				`# stdout bytes kept=${result.stdout.keptBytes} total=${result.stdout.totalBytes}` +
					` truncated=${result.stdout.truncated}`,
				`# stderr bytes kept=${result.stderr.keptBytes} total=${result.stderr.totalBytes}` +
					` truncated=${result.stderr.truncated}`,
				"",
				"----- stdout -----",
				result.stdout.text,
				"----- stderr -----",
				result.stderr.text,
			].join("\n"),
		);
		console.log(
			`${statusLabel(result.status).padEnd(16)} ${file} ` +
				`(${result.durationMs}ms, pass ${result.tests.passed}, fail ${result.tests.failed}` +
				`, skip ${result.tests.skipped})`,
		);
		return result;
	};

	let preflight: FileRunResult | null = null;
	let aborted = false;
	if (!options.skipPreflight) {
		console.log(`--- preflight isolation check: ${PREFLIGHT_FILE}`);
		preflight = await runOne(PREFLIGHT_FILE);
		if (preflight.status !== "pass") {
			console.error(
				"Preflight isolation check did not pass; refusing to run the batch. " +
					"Test data isolation could not be verified.",
			);
			aborted = true;
		}
	}

	const files = requested.filter((file) => file !== PREFLIGHT_FILE);
	const results = aborted
		? []
		: await runWithConcurrency(files, options.concurrency, (file) => runOne(file));

	const finishedAt = new Date().toISOString();
	const durationMs = Math.round((Bun.nanoseconds() - startedNs) / 1e6);
	const realHomeAfter = snapshotRealHome();
	process.off("SIGINT", onSignal);
	process.off("SIGTERM", onSignal);

	const byStatus = (status: FileStatus) => results.filter((r) => r.status === status);
	const totals = {
		files: results.length,
		pass: byStatus("pass").length,
		fail: byStatus("fail").length,
		timeout: byStatus("timeout").length,
		crash: byStatus("crash").length,
		outputOverflow: byStatus("output-overflow").length,
		noTests: byStatus("no-tests").length,
		skippedOnly: byStatus("skipped").length,
		missing: byStatus("missing").length,
		cancelled: byStatus("cancelled").length,
		testsPassed: results.reduce((sum, r) => sum + r.tests.passed, 0),
		testsFailed: results.reduce((sum, r) => sum + r.tests.failed, 0),
		testsSkipped: results.reduce((sum, r) => sum + r.tests.skipped, 0),
	};

	// Schema 2 adds the per-field truncation flags on failures/skippedNames and
	// forces NODE_ENV=test in children; a consumer written against 1 would read
	// `failures` as an uncapped array without truncation markers.
	const payload = {
		schema: "dual-database-regression/2",
		startedAt,
		finishedAt,
		durationMs,
		aborted,
		cancelled: controller.signal.aborted,
		environment: {
			bunVersion: Bun.version,
			platform: process.platform,
			arch: process.arch,
			hostname: hostname(),
			repoRoot: REPO_ROOT,
			git: gitInfo(),
			batch: options.batch,
			concurrency: options.concurrency,
			perFileTimeoutMs: options.timeoutMs,
			outputCapBytes: options.outputCapBytes,
			outputHardKillBytes: options.outputCapBytes * OUTPUT_HARD_KILL_FACTOR,
			summaryCaps: {
				failureMessageChars: MAX_FAILURE_MESSAGE_CHARS,
				testNameChars: MAX_TEST_NAME_CHARS,
				failuresPerFile: MAX_FAILURES_PER_FILE,
				skippedNamesPerFile: MAX_SKIPPED_NAMES_PER_FILE,
			},
		},
		isolation: {
			preflightFile: PREFLIGHT_FILE,
			preflightStatus: preflight?.status ?? "skipped-by-flag",
			strippedChildEnv: ["NARRAFORK_HOME", "NARRAFORK_ALLOW_MULTIPLE", "NARRAFORK_ORIGINAL_HOME"],
			forcedChildEnv: { NODE_ENV: "test" },
			forcedChildEnvNote:
				"bun test only defaults NODE_ENV to test when it is unset; an inherited " +
				"production value disables the real-database guard in server/db/connection.ts.",
			realHomeBefore,
			realHomeAfter,
			realHomeNote:
				"Observation only. A live NarraFork server writes to these files, so a changed " +
				"mtime does not implicate the test run. The preflight file is the isolation proof.",
		},
		totals,
		files: results.map((result) => ({
			file: result.file,
			status: result.status,
			exitCode: result.exitCode,
			signal: result.signal,
			durationMs: result.durationMs,
			timedOut: result.timedOut,
			killedForOutput: result.killedForOutput,
			reportParsed: result.reportParsed,
			stdout: {
				keptBytes: result.stdout.keptBytes,
				totalBytes: result.stdout.totalBytes,
				truncated: result.stdout.truncated,
			},
			stderr: {
				keptBytes: result.stderr.keptBytes,
				totalBytes: result.stderr.totalBytes,
				truncated: result.stderr.truncated,
			},
			tests: result.tests,
			failures: result.failures.items.map((failure) => ({
				name: failure.name.text,
				nameTruncated: failure.name.truncated,
				classname: failure.classname.text,
				classnameTruncated: failure.classname.truncated,
				line: failure.line,
				message: failure.message?.text ?? null,
				messageTruncated: failure.message?.truncated ?? false,
				messageOriginalChars: failure.message?.originalChars ?? 0,
			})),
			failuresTruncated: result.failures.truncated,
			failuresOriginalCount: result.failures.originalCount,
			skippedNames: result.skippedNames.items.map((name) => name.text),
			skippedNamesTruncated: result.skippedNames.truncated,
			skippedNamesOriginalCount: result.skippedNames.originalCount,
			logPath: join("logs", `${sanitizeLogName(result.file)}.log`),
		})),
	};

	writeFileSync(join(runDir, "results.json"), `${JSON.stringify(payload, null, "\t")}\n`);
	const notGreen = results.filter((r) => r.status !== "pass");
	writeFileSync(
		join(runDir, "rerun.txt"),
		notGreen.length === 0
			? "# every selected file was green in isolation\n"
			: // `./` prefix on purpose: a bare path is a substring filter in bun test.
				`${notGreen.map((r) => `bun test ${toPathArgument(r.file)}`).join("\n")}\n`,
	);

	console.log("\n=== summary ===");
	console.log(
		`files=${totals.files} pass=${totals.pass} fail=${totals.fail} timeout=${totals.timeout} ` +
			`crash=${totals.crash} overflow=${totals.outputOverflow} no-tests=${totals.noTests} ` +
			`skipped-only=${totals.skippedOnly} missing=${totals.missing} ` +
			`cancelled=${totals.cancelled}`,
	);
	console.log(
		`tests: pass=${totals.testsPassed} fail=${totals.testsFailed} skip=${totals.testsSkipped}`,
	);
	console.log(`results: ${join(runDir, "results.json")}`);

	if (notGreen.length > 0) {
		console.log("\nnot green in isolation:");
		for (const result of notGreen) {
			console.log(`  ${statusLabel(result.status).padEnd(16)} ${result.file}`);
		}
	}

	process.exitCode = aborted || notGreen.length > 0 ? 1 : 0;
}

if (import.meta.main) {
	await main();
}

export const __internal = { snapshotRealHome, createRunDirectory, statusLabel };
