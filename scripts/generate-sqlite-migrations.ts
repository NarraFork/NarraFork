import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { safeSpawn } from "../server/lib/spawn";
import {
	assertResourceMigrationValidated,
	finalizeResourceMigration,
	type ResourceMigrationSnapshot,
} from "./finalize-sqlite-resource-migration";
import { acquireSqliteGenerationLock } from "./lib/sqlite-generation-lock";

interface Entry {
	tag: string;
	idx: number;
}
interface Journal {
	entries: Entry[];
	[key: string]: unknown;
}
interface GeneratedIdentity {
	tag: string;
	idx: number;
	rawDigest: string;
	snapshotDigest: string;
	journalDigest: string;
}
interface Pending {
	version: 1;
	phase: "started" | "generated" | "validated";
	args: string[];
	schemaDigest: string;
	baseline: Journal;
	baselineSnapshotDigest: string;
	baselineSqlDigest: string;
	baselineSqlDigests: Record<string, string>;
	generated?: GeneratedIdentity;
	finalDigest?: string;
}
interface GenerateResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	stdoutTruncated?: boolean;
	stderrTruncated?: boolean;
}
export interface SqliteGeneratorOptions {
	/** Fixture-only filesystem/child seams; production uses the current repository. */
	root?: string;
	runGenerate?: (root: string, args: string[]) => Promise<GenerateResult>;
	finalize?: typeof finalizeResourceMigration;
	beforeCommit?: () => void | Promise<void>;
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function readBounded(path: string, max: number): string {
	if (statSync(path).size > max) throw new Error("Schema generator input exceeds byte budget");
	return readFileSync(path, "utf8");
}
function journalOf(source: string): Journal {
	const parsed = JSON.parse(source) as Journal;
	if (
		!parsed ||
		!Array.isArray(parsed.entries) ||
		!parsed.entries.length ||
		parsed.entries.length > 4096 ||
		new Set(parsed.entries.map((entry) => entry?.tag)).size !== parsed.entries.length ||
		parsed.entries.some(
			(entry, index) =>
				!entry ||
				!Number.isSafeInteger(entry.idx) ||
				entry.idx < 0 ||
				!/^[\p{L}\p{N}_-]{1,128}$/u.test(entry.tag) ||
				(index > 0 && entry.idx !== parsed.entries[index - 1].idx + 1),
		)
	)
		throw new Error("Invalid SQLite generator journal");
	return parsed;
}
function validateArgs(args: string[]) {
	if (args.length > 2) throw new Error("Unsupported SQLite generator arguments");
	if (!args.length) return;
	const name =
		args.length === 1 && args[0].startsWith("--name=")
			? args[0].slice(7)
			: args.length === 2 && args[0] === "--name"
				? args[1]
				: "";
	if (!/^[\p{L}\p{N}_-]{1,128}$/u.test(name))
		throw new Error("Unsupported SQLite generator arguments; history rewrite flags are forbidden");
}
/** Generation provenance is persisted BEFORE Drizzle mutates the journal. Failures retain
 * raw/snapshot/source digests and must resume that batch; no-changes cannot hide a failure.
 * Only a new, receipt-bound batch may be rewritten. Existing history is read-only validated.
 * No migration/database execution occurs here. */
export async function generateSqliteMigrations(
	args: string[] = process.argv.slice(2),
	options: SqliteGeneratorOptions = {},
): Promise<void> {
	validateArgs(args);
	const root = options.root ?? resolve(import.meta.dir, "..");
	const release = acquireSqliteGenerationLock(resolve(root, "drizzle/meta"));
	try {
		await generateLocked(args, options, root);
	} finally {
		release();
	}
}
async function generateLocked(
	args: string[],
	options: SqliteGeneratorOptions,
	root: string,
): Promise<void> {
	const folder = resolve(root, "drizzle");
	const journalPath = resolve(folder, "meta/_journal.json");
	const pendingPath = resolve(folder, "meta/_generation_pending.json");
	const receiptPath = resolve(folder, "meta/_generation_validated.json");
	const schemaPath = resolve(root, "server/db/schema.ts");
	const snapshotPath = (idx: number) =>
		resolve(folder, `meta/${String(idx).padStart(4, "0")}_snapshot.json`);
	const snapshot = (idx: number) =>
		JSON.parse(readBounded(snapshotPath(idx), 8 * 1024 * 1024)) as ResourceMigrationSnapshot;
	const sqlPath = (tag: string) => resolve(folder, `${tag}.sql`);
	const save = (state: Pending) => writeFileSync(pendingPath, JSON.stringify(state));
	const schemaDigest = digest(readBounded(schemaPath, 1024 * 1024));
	let pending: Pending;
	if (existsSync(pendingPath)) {
		pending = JSON.parse(readBounded(pendingPath, 2 * 1024 * 1024)) as Pending;
		if (
			pending.version !== 1 ||
			!pending.baselineSqlDigests ||
			typeof pending.baselineSqlDigests !== "object" ||
			!["started", "generated", "validated"].includes(pending.phase) ||
			pending.schemaDigest !== schemaDigest ||
			JSON.stringify(pending.args) !== JSON.stringify(args)
		)
			throw new Error("Pending generation source/arguments changed; refusing history rewrite");
		journalOf(JSON.stringify(pending.baseline));
	} else {
		const baseline = journalOf(readBounded(journalPath, 1024 * 1024));
		const latest = baseline.entries.at(-1) as Entry;
		const baselineSqlDigests: Record<string, string> = {};
		let baselineBytes = 0;
		for (const entry of baseline.entries) {
			const source = readBounded(sqlPath(entry.tag), 1024 * 1024);
			baselineBytes += Buffer.byteLength(source);
			if (baselineBytes > 32 * 1024 * 1024)
				throw new Error("Migration history exceeds provenance budget");
			baselineSqlDigests[entry.tag] = digest(source);
		}
		pending = {
			version: 1,
			phase: "started",
			args: [...args],
			schemaDigest,
			baseline,
			baselineSqlDigests,
			baselineSnapshotDigest: digest(readBounded(snapshotPath(latest.idx), 8 * 1024 * 1024)),
			baselineSqlDigest: digest(readBounded(sqlPath(latest.tag), 1024 * 1024)),
		};
		// Exclusive creation prevents a new run from overwriting an unresolved receipt.
		writeFileSync(pendingPath, JSON.stringify(pending), { flag: "wx" });
	}
	const baselineLast = pending.baseline.entries.at(-1) as Entry;
	const assertBaseline = () => {
		if (
			digest(readBounded(schemaPath, 1024 * 1024)) !== pending.schemaDigest ||
			digest(readBounded(snapshotPath(baselineLast.idx), 8 * 1024 * 1024)) !==
				pending.baselineSnapshotDigest ||
			digest(readBounded(sqlPath(baselineLast.tag), 1024 * 1024)) !== pending.baselineSqlDigest
		)
			throw new Error("Pending source/baseline digest changed; refusing history rewrite");
		for (const entry of pending.baseline.entries) {
			if (
				digest(readBounded(sqlPath(entry.tag), 1024 * 1024)) !==
				pending.baselineSqlDigests[entry.tag]
			)
				throw new Error("Published migration digest changed; refusing history rewrite");
		}
	};
	assertBaseline();
	const identifyNewBatch = (journal: Journal): GeneratedIdentity => {
		const latest = journal.entries.at(-1) as Entry;
		if (
			journal.entries.length !== pending.baseline.entries.length + 1 ||
			latest.idx !== baselineLast.idx + 1 ||
			JSON.stringify({ ...journal, entries: journal.entries.slice(0, -1) }) !==
				JSON.stringify(pending.baseline)
		)
			throw new Error("Journal differs from one appended generation; refusing history rewrite");
		assertBaseline();
		return {
			tag: latest.tag,
			idx: latest.idx,
			rawDigest: digest(readBounded(sqlPath(latest.tag), 1024 * 1024)),
			snapshotDigest: digest(readBounded(snapshotPath(latest.idx), 8 * 1024 * 1024)),
			journalDigest: digest(JSON.stringify(journal)),
		};
	};
	const captureChildArtifacts = () => {
		const journal = journalOf(readBounded(journalPath, 1024 * 1024));
		if (JSON.stringify(journal) !== JSON.stringify(pending.baseline)) {
			pending.generated = identifyNewBatch(journal);
			pending.phase = "generated";
			save(pending);
		}
		return journal;
	};
	let current = journalOf(readBounded(journalPath, 1024 * 1024));
	if (pending.phase === "started" && JSON.stringify(current) === JSON.stringify(pending.baseline)) {
		const result = await (options.runGenerate
			? options.runGenerate(root, args)
			: safeSpawn({
					cmd: [
						"bunx",
						"drizzle-kit",
						"generate",
						"--config",
						resolve(root, "drizzle.config.ts"),
						...args,
					],
					cwd: root,
					timeout: 60_000,
					maxOutputBytes: 256 * 1024,
				})
		).catch((cause) => {
			captureChildArtifacts();
			throw cause;
		});
		// Record emitted artifacts even when Drizzle reports a failure after writing them.
		current = captureChildArtifacts();
		if (result.exitCode !== 0 || result.stdoutTruncated || result.stderrTruncated)
			throw new Error(`SQLite schema generation failed: ${result.stderr.slice(0, 4000)}`);
		if (result.stdout) console.log(result.stdout);
		assertBaseline();
		current = journalOf(readBounded(journalPath, 1024 * 1024));
	}
	if (JSON.stringify(current) === JSON.stringify(pending.baseline)) {
		if (pending.phase !== "started") throw new Error("Pending generated batch disappeared");
		const previous = current.entries.at(-2);
		if (!previous) throw new Error("Cannot validate existing migration without previous snapshot");
		const original = readBounded(sqlPath(baselineLast.tag), 1024 * 1024);
		// Old receipts may predate stronger DDL validation; digests prove identity, not
		// constraints. Always validate history read-only, even if a receipt is present.
		assertResourceMigrationValidated(original, snapshot(previous.idx), snapshot(baselineLast.idx));
		unlinkSync(pendingPath);
		console.log(JSON.stringify({ tag: baselineLast.tag, generated: false, validated: true }));
		return;
	}
	if (pending.phase === "started")
		throw new Error("Interrupted generation has no captured raw digest; refusing receipt adoption");
	const identity = identifyNewBatch(current);
	const latest = current.entries.at(-1) as Entry;
	const path = sqlPath(latest.tag);
	const original = readBounded(path, 1024 * 1024);
	const expected = pending.generated;
	if (
		!expected ||
		expected.tag !== identity.tag ||
		expected.idx !== identity.idx ||
		expected.snapshotDigest !== identity.snapshotDigest ||
		expected.journalDigest !== identity.journalDigest ||
		(identity.rawDigest !== expected.rawDigest &&
			!(pending.phase === "validated" && identity.rawDigest === pending.finalDigest))
	)
		throw new Error("Pending generated SQL/snapshot digest changed; refusing history rewrite");
	const finalized = (options.finalize ?? finalizeResourceMigration)(
		original,
		snapshot(baselineLast.idx),
		snapshot(latest.idx),
	);
	const finalDigest = digest(finalized);
	if (pending.phase === "validated" && pending.finalDigest !== finalDigest)
		throw new Error("Pending finalizer result changed");
	pending.finalDigest = finalDigest;
	pending.phase = "validated";
	save(pending);
	await options.beforeCommit?.();
	assertBaseline();
	if (
		digest(readBounded(path, 1024 * 1024)) !== identity.rawDigest ||
		digest(readBounded(snapshotPath(latest.idx), 8 * 1024 * 1024)) !== expected.snapshotDigest ||
		digest(JSON.stringify(journalOf(readBounded(journalPath, 1024 * 1024)))) !==
			expected.journalDigest
	)
		throw new Error("Generation changed before commit");
	if (original !== finalized) {
		const temporary = `${path}.finalizing-${randomUUID()}`;
		try {
			writeFileSync(temporary, finalized, { flag: "wx" });
			renameSync(temporary, path);
		} finally {
			if (existsSync(temporary)) unlinkSync(temporary);
		}
	}
	writeFileSync(
		receiptPath,
		JSON.stringify({
			tag: latest.tag,
			sqlDigest: finalDigest,
			snapshotDigest: expected.snapshotDigest,
			journalDigest: expected.journalDigest,
		}),
	);
	unlinkSync(pendingPath);
	console.log(
		JSON.stringify({
			tag: latest.tag,
			generated: true,
			finalized: original !== finalized,
			validated: true,
		}),
	);
}
if (import.meta.main) await generateSqliteMigrations();
