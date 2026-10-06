import { randomUUID } from "node:crypto";
import {
	linkSync,
	lstatSync,
	mkdirSync,
	opendirSync,
	realpathSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, stripVTControlCharacters } from "node:util";
import { runPostgresKit } from "./postgres-kit";
import {
	CURRENT_SNAPSHOT,
	digest,
	HISTORY_FILE,
	MAX_SNAPSHOT_BYTES,
	PENDING_FILE,
	parseHistory,
	parseJournal,
	parseSnapshot,
	readBounded,
	readPgMetadata,
	validateHistory,
} from "./postgres-migration-metadata";
import { acquireSqliteGenerationLock } from "./sqlite-generation-lock";

export type PostgresMigrationOperation = "baseline" | "generate" | "check" | "resume";
export interface PostgresMigrationOptions {
	root?: string;
	runKit?: typeof runPostgresKit;
	schemaPath?: string;
	/** Test seam: concurrent edits must be detected after this hook. */
	beforePublish?: () => void | Promise<void>;
	/** Test seam: throws after a durable publication checkpoint. */
	faultInject?: (phase: string) => void | Promise<void>;
}
export interface PostgresMigrationResult {
	operation: PostgresMigrationOperation;
	changed: boolean;
	dryRun: boolean;
	migrations: number;
	snapshotId: string;
}
type Metadata = ReturnType<typeof readPgMetadata>;
type Phase = "receipt" | "sql" | "snapshot" | "history" | "journal" | "legacy-cleanup" | "complete";
interface Receipt {
	version: 1;
	operation: "baseline" | "generate";
	stage: string;
	token: string;
	phase: Phase;
	oldFiles: Record<string, string>;
	newFiles: Record<string, string>;
	deletions: string[];
	schema?: { path: string; digest: string };
}
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_SQL_BYTES = 1024 * 1024;
const MAX_RECEIPT_BYTES = 1024 * 1024;
const MAX_SQL_TOTAL = 32 * 1024 * 1024;
const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const phases: Phase[] = [
	"receipt",
	"sql",
	"snapshot",
	"history",
	"journal",
	"legacy-cleanup",
	"complete",
];
const currentPath = `meta/${CURRENT_SNAPSHOT}`;
const historyPath = `meta/${HISTORY_FILE}`;
const journalPath = "meta/_journal.json";

function exists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}
function directory(path: string): void {
	const stat = lstatSync(path);
	if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path)
		throw new Error(`PostgreSQL migration directory must be a real, non-symlink path: ${path}`);
}
function rootPaths(rootOption?: string) {
	const root = resolve(rootOption ?? fileURLToPath(new URL("../../", import.meta.url)));
	directory(root);
	const folder = join(root, "drizzle-postgres");
	directory(folder);
	const meta = join(folder, "meta");
	directory(meta);
	return { root, folder, meta };
}
function fileLimit(path: string): number {
	return path.endsWith(".sql")
		? MAX_SQL_BYTES
		: path.endsWith("_snapshot.json") || path === currentPath
			? MAX_SNAPSHOT_BYTES
			: MAX_METADATA_BYTES;
}
function fileDigest(path: string, relativePath: string): string {
	return digest(readBounded(path, fileLimit(relativePath)));
}
function assertRelativeFile(path: string): void {
	if (
		!/^(?:\d{4,}_[A-Za-z0-9_-]+\.sql|meta\/(?:\d{4,}_snapshot\.json|_journal\.json|current_snapshot\.json|_snapshot_history\.json))$/.test(
			path,
		)
	)
		throw new Error(`Unsafe PostgreSQL migration receipt path: ${path}`);
}
function boundedNames(path: string): string[] {
	const handle = opendirSync(path);
	const names: string[] = [];
	try {
		for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
			if (names.length >= 4100) throw new Error("PostgreSQL migration asset count exceeds limit");
			names.push(entry.name);
		}
	} finally {
		handle.closeSync();
	}
	return names;
}
function inventory(folder: string, stage = false): string[] {
	directory(folder);
	const files: string[] = [];
	for (const name of boundedNames(folder)) {
		if (stage && (name === ".owner.json" || name === "publish")) continue;
		if (name === "meta") continue;
		if (!/^\d{4,}_[A-Za-z0-9_-]+\.sql$/.test(name))
			throw new Error(`Unexpected PostgreSQL migration asset: ${name}`);
		assertRelativeFile(name);
		files.push(name);
	}
	directory(join(folder, "meta"));
	for (const name of boundedNames(join(folder, "meta"))) {
		if (!stage && (name === PENDING_FILE || name === "_generation.lock")) continue;
		const path = `meta/${name}`;
		assertRelativeFile(path);
		files.push(path);
	}
	return files.sort();
}
function stagedHashes(stage: string): Record<string, string> {
	let sqlBytes = 0;
	const hashes: Record<string, string> = {};
	for (const path of inventory(stage, true)) {
		const text = readBounded(join(stage, path), fileLimit(path));
		if (path.endsWith(".sql")) {
			sqlBytes += Buffer.byteLength(text);
			if (sqlBytes > MAX_SQL_TOTAL) throw new Error("PostgreSQL staged SQL exceeds 32 MiB");
		}
		hashes[path] = digest(text);
	}
	return hashes;
}
function assertUnchanged(folder: string, expected: Record<string, string>): void {
	const files = inventory(folder);
	if (JSON.stringify(files) !== JSON.stringify(Object.keys(expected).sort()))
		throw new Error("PostgreSQL migration assets changed concurrently");
	for (const [path, sha] of Object.entries(expected))
		if (fileDigest(join(folder, path), path) !== sha)
			throw new Error(`PostgreSQL migration asset changed: ${path}`);
}
function makeStage(root: string) {
	const parent = join(root, ".narrafork");
	if (!exists(parent)) mkdirSync(parent);
	directory(parent);
	const token = randomUUID();
	const stageRelative = `.narrafork/pg-${token}`;
	const stage = join(root, stageRelative);
	mkdirSync(stage);
	writeFileSync(join(stage, ".owner.json"), JSON.stringify({ version: 1, token }), { flag: "wx" });
	mkdirSync(join(stage, "meta"));
	return { token, stage, stageRelative };
}
function ownedStage(root: string, stageRelative: string, token: string): string {
	if (!UUID.test(token) || stageRelative !== `.narrafork/pg-${token}`)
		throw new Error("Invalid PostgreSQL migration stage ownership/path");
	directory(join(root, ".narrafork"));
	const stage = join(root, stageRelative);
	directory(stage);
	const owner = JSON.parse(readBounded(join(stage, ".owner.json"), 1024).toString());
	if (owner.version !== 1 || owner.token !== token)
		throw new Error("PostgreSQL migration stage owner changed");
	return stage;
}
function cleanupStage(root: string, stageRelative: string, token: string): void {
	const stage = ownedStage(root, stageRelative, token);
	// Symlinks are never traversed by rm; owner and real parent were checked above.
	rmSync(stage, { recursive: true });
}
function copyInput(stage: string, folder: string, before: Metadata): string {
	let total = 0;
	for (const path of Object.keys(before.files)) {
		if (!path.endsWith(".sql")) continue;
		const bytes = readBounded(join(folder, path), MAX_SQL_BYTES);
		total += Buffer.byteLength(bytes);
		if (total > MAX_SQL_TOTAL) throw new Error("PostgreSQL historical SQL exceeds 32 MiB");
		writeFileSync(join(stage, path), bytes, { flag: "wx" });
	}
	writeFileSync(join(stage, journalPath), before.journalText, { flag: "wx" });
	const idx = before.journal.entries.at(-1)?.idx;
	if (idx === undefined) throw new Error("PostgreSQL migrations require an existing baseline");
	const nativeSnapshot = `meta/${String(idx).padStart(4, "0")}_snapshot.json`;
	writeFileSync(join(stage, nativeSnapshot), before.snapshotText, { flag: "wx" });
	return nativeSnapshot;
}
function stripAnsi(text: string): string {
	// CSI / OSC sequences are removed before accepting any CLI success message.
	return stripVTControlCharacters(text);
}
function acceptKit(
	result: Awaited<ReturnType<typeof runPostgresKit>>,
	operation: "generate" | "check",
): string {
	const text = stripAnsi(`${result.stdout}\n${result.stderr}`);
	if (
		result.exitCode !== 0 ||
		result.stdoutTruncated ||
		result.stderrTruncated ||
		/^\s*(?:\[?[✗×!]\]?\s*)?(?:[A-Za-z]*Error:|(?:failed|conflict|error)(?:\s*$|:)|Please update drizzle-kit\b|Not supported\b)/im.test(
			text,
		)
	)
		throw new Error(
			`PostgreSQL Drizzle ${operation} failed (exit ${result.exitCode}): ${text.slice(-4096)}`,
		);
	if (operation === "check" && !/Everything['’]s fine/i.test(text))
		throw new Error("PostgreSQL Drizzle check did not provide its success marker");
	if (
		operation === "generate" &&
		!/(No schema changes, nothing to migrate|Your SQL migration file)/i.test(text)
	)
		throw new Error("PostgreSQL Drizzle generate did not provide its success marker");
	return text;
}
function schemaInput(root: string, path?: string): { path: string; digest: string } {
	const absolute = resolve(root, path ?? "server/db/postgres-schema.ts");
	const rel = relative(root, absolute).split(sep).join("/");
	if (
		!rel ||
		isAbsolute(rel) ||
		rel === ".." ||
		rel.startsWith("../") ||
		realpathSync(absolute) !== absolute
	)
		throw new Error("PostgreSQL schema must be a real file within the project root");
	if (!absolute.endsWith(".ts")) throw new Error("PostgreSQL source schema must be a TS file");
	return { path: rel, digest: digest(readBounded(absolute, MAX_SNAPSHOT_BYTES)) };
}
function assertSchema(root: string, schema?: Receipt["schema"]): void {
	if (!schema) return;
	const current = schemaInput(root, schema.path);
	if (current.digest !== schema.digest)
		throw new Error("PostgreSQL source schema changed concurrently");
}
/** Keep the original document and old entry bytes; only insert before entries' closing ]. */
function appendJournal(text: string, entry: Metadata["journal"]["entries"][number]): string {
	const match = /"entries"\s*:\s*\[/.exec(text);
	if (!match) throw new Error("PostgreSQL journal entries array is missing");
	let depth = 1;
	let quoted = false;
	let escaped = false;
	for (let i = match.index + match[0].length; i < text.length; i++) {
		const char = text[i];
		if (quoted) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') quoted = false;
			continue;
		}
		if (char === '"') quoted = true;
		else if (char === "[") depth++;
		else if (char === "]" && --depth === 0) {
			const prefix = text.slice(0, i);
			const whitespace = /\s*$/.exec(prefix)?.[0] ?? "";
			const cut = prefix.length - whitespace.length;
			return `${prefix.slice(0, cut)},\n${JSON.stringify(entry, null, "\t")
				.split("\n")
				.map((line) => `\t\t${line}`)
				.join("\n")}${whitespace}${text.slice(i)}`;
		}
	}
	throw new Error("PostgreSQL journal entries array is malformed");
}
function payload(
	stage: string,
	files: Record<string, string | Uint8Array>,
): Record<string, string> {
	mkdirSync(join(stage, "publish"));
	mkdirSync(join(stage, "publish", "meta"));
	const hashes: Record<string, string> = {};
	for (const [path, bytes] of Object.entries(files)) {
		assertRelativeFile(path);
		writeFileSync(join(stage, "publish", path), bytes, { flag: "wx" });
		hashes[path] = digest(bytes);
	}
	return hashes;
}
function receiptProposal(receipt: Receipt): string {
	const { phase: _phase, ...proposal } = receipt;
	return JSON.stringify(proposal);
}
function writeReceipt(meta: string, receipt: Receipt, initial = false): void {
	const path = join(meta, PENDING_FILE);
	const text = `${JSON.stringify(receipt, null, "\t")}\n`;
	if (Buffer.byteLength(text) > MAX_RECEIPT_BYTES)
		throw new Error("PostgreSQL pending receipt exceeds size limit");
	const root = resolve(meta, "../..");
	const stage = ownedStage(root, receipt.stage, receipt.token);
	if (!initial) {
		if (!exists(path)) throw new Error("PostgreSQL pending receipt disappeared");
		const existing = parseReceipt(meta);
		if (receiptProposal(existing) !== receiptProposal(receipt))
			throw new Error("PostgreSQL pending receipt changed");
	}
	// Keep temporary replacement files inside the owned stage, including on interruption.
	const temp = join(stage, `.receipt-${randomUUID()}.tmp`);
	writeFileSync(temp, text, { flag: "wx" });
	try {
		if (initial)
			linkSync(temp, path); // Exclusive and complete: never expose a partial JSON receipt.
		else renameSync(temp, path);
	} finally {
		if (exists(temp)) unlinkSync(temp);
	}
}
function parseReceipt(meta: string): Receipt {
	const value = JSON.parse(
		readBounded(join(meta, PENDING_FILE), MAX_RECEIPT_BYTES).toString(),
	) as Receipt;
	if (
		!value ||
		value.version !== 1 ||
		!["baseline", "generate"].includes(value.operation) ||
		!phases.includes(value.phase) ||
		typeof value.stage !== "string" ||
		typeof value.token !== "string" ||
		!Array.isArray(value.deletions)
	)
		throw new Error("Invalid PostgreSQL pending receipt");
	for (const map of [value.oldFiles, value.newFiles]) {
		if (!map || typeof map !== "object" || Array.isArray(map))
			throw new Error("Invalid PostgreSQL receipt hashes");
		for (const [path, sha] of Object.entries(map)) {
			assertRelativeFile(path);
			if (typeof sha !== "string" || !SHA.test(sha))
				throw new Error("Invalid PostgreSQL receipt digest");
		}
	}
	if (!value.oldFiles[journalPath] || !value.newFiles[currentPath] || !value.newFiles[historyPath])
		throw new Error("Incomplete PostgreSQL receipt");
	if (
		value.operation === "baseline" &&
		(value.newFiles[journalPath] || Object.keys(value.newFiles).length !== 2 || value.schema)
	)
		throw new Error("Invalid PostgreSQL baseline receipt");
	if (
		value.operation === "generate" &&
		(!value.newFiles[journalPath] ||
			!value.schema ||
			value.deletions.length ||
			Object.keys(value.newFiles).length !== 4)
	)
		throw new Error("Invalid PostgreSQL generate receipt");
	const seen = new Set<string>();
	for (const path of value.deletions) {
		if (
			typeof path !== "string" ||
			!/^meta\/\d{4,}_snapshot\.json$/.test(path) ||
			!value.oldFiles[path] ||
			seen.has(path)
		)
			throw new Error("Invalid PostgreSQL receipt deletion");
		seen.add(path);
	}
	if (
		value.schema &&
		(typeof value.schema.path !== "string" ||
			typeof value.schema.digest !== "string" ||
			!SHA.test(value.schema.digest))
	)
		throw new Error("Invalid PostgreSQL receipt schema");
	return value;
}
function validateReceiptPayload(root: string, receipt: Receipt): string {
	const stage = ownedStage(root, receipt.stage, receipt.token);
	if (readBounded(join(stage, ".transaction.json"), MAX_RECEIPT_BYTES) !== receiptProposal(receipt))
		throw new Error("PostgreSQL pending receipt does not match the owned stage manifest");
	directory(join(stage, "publish"));
	directory(join(stage, "publish", "meta"));
	const files = inventory(join(stage, "publish"));
	if (JSON.stringify(files) !== JSON.stringify(Object.keys(receipt.newFiles).sort()))
		throw new Error("PostgreSQL staged publication assets changed");
	for (const [path, sha] of Object.entries(receipt.newFiles))
		if (fileDigest(join(stage, "publish", path), path) !== sha)
			throw new Error(`PostgreSQL staged publication changed: ${path}`);
	const snapshotText = readBounded(
		join(stage, "publish", currentPath),
		MAX_SNAPSHOT_BYTES,
	).toString();
	const history = parseHistory(
		readBounded(join(stage, "publish", historyPath), MAX_METADATA_BYTES).toString(),
	);
	const journalFile =
		receipt.operation === "generate"
			? join(stage, "publish", journalPath)
			: join(root, "drizzle-postgres", journalPath);
	const journal = parseJournal(readBounded(journalFile, MAX_METADATA_BYTES).toString());
	validateHistory(journal, history, snapshotText);
	if (receipt.operation === "generate") {
		const latest = journal.entries.at(-1);
		if (!latest || !receipt.newFiles[`${latest.tag}.sql`] || receipt.oldFiles[`${latest.tag}.sql`])
			throw new Error("Invalid PostgreSQL new SQL receipt");
	}
	return stage;
}
function verifyRecoverable(root: string, folder: string, receipt: Receipt): void {
	assertSchema(root, receipt.schema);
	const union = new Set([...Object.keys(receipt.oldFiles), ...Object.keys(receipt.newFiles)]);
	for (const path of inventory(folder))
		if (!union.has(path)) throw new Error(`Unexpected concurrent PostgreSQL asset: ${path}`);
	const allowDeleted = phases.indexOf(receipt.phase) >= phases.indexOf("legacy-cleanup");
	for (const path of union) {
		const absolute = join(folder, path);
		if (!exists(absolute)) {
			if (!receipt.oldFiles[path] || (allowDeleted && receipt.deletions.includes(path))) continue;
			throw new Error(`PostgreSQL recovery asset missing: ${path}`);
		}
		const sha = fileDigest(absolute, path);
		if (sha !== receipt.oldFiles[path] && sha !== receipt.newFiles[path])
			throw new Error(`PostgreSQL recovery refuses modified asset: ${path}`);
	}
	// Missing legacy files only become recoverable after the complete new baseline exists.
	if (allowDeleted)
		for (const path of Object.keys(receipt.newFiles))
			if (
				!exists(join(folder, path)) ||
				fileDigest(join(folder, path), path) !== receipt.newFiles[path]
			)
				throw new Error("PostgreSQL recovery cleanup has incomplete publication");
}
function publishOne(folder: string, stage: string, receipt: Receipt, path: string): void {
	const absolute = join(folder, path);
	if (exists(absolute) && fileDigest(absolute, path) === receipt.newFiles[path]) return;
	if (exists(absolute)) {
		if (!receipt.oldFiles[path] || fileDigest(absolute, path) !== receipt.oldFiles[path])
			throw new Error(`PostgreSQL publish refuses modified file: ${path}`);
	} else if (receipt.oldFiles[path])
		throw new Error(`PostgreSQL publish file disappeared: ${path}`);
	const bytes = readBounded(join(stage, "publish", path), fileLimit(path));
	if (digest(bytes) !== receipt.newFiles[path])
		throw new Error(`PostgreSQL publication payload changed: ${path}`);
	const temp = join(stage, `.replace-${randomUUID()}.tmp`);
	writeFileSync(temp, bytes, { flag: "wx" });
	try {
		// No other cooperating producer may publish under our generation lock.
		if (exists(absolute) && fileDigest(absolute, path) !== receipt.oldFiles[path])
			throw new Error(`PostgreSQL concurrent publish: ${path}`);
		if (!receipt.oldFiles[path] && exists(absolute))
			throw new Error(`PostgreSQL new SQL already exists: ${path}`);
		if (receipt.oldFiles[path]) renameSync(temp, absolute);
		else linkSync(temp, absolute); // Exclusive creation must never clobber a new foreign file.
	} finally {
		if (exists(temp)) unlinkSync(temp);
	}
}
async function publish(
	root: string,
	folder: string,
	meta: string,
	receipt: Receipt,
	options: PostgresMigrationOptions,
): Promise<void> {
	const stage = validateReceiptPayload(root, receipt);
	verifyRecoverable(root, folder, receipt);
	const checkpoint = async (phase: Phase) => {
		if (phases.indexOf(phase) > phases.indexOf(receipt.phase)) receipt.phase = phase;
		writeReceipt(meta, receipt);
		await options.faultInject?.(phase);
		if (JSON.stringify(parseReceipt(meta)) !== JSON.stringify(receipt))
			throw new Error("PostgreSQL pending receipt changed during publication");
		validateReceiptPayload(root, receipt);
		verifyRecoverable(root, folder, receipt);
	};
	for (const path of Object.keys(receipt.newFiles).filter((path) => path.endsWith(".sql")))
		publishOne(folder, stage, receipt, path);
	await checkpoint("sql");
	publishOne(folder, stage, receipt, currentPath);
	await checkpoint("snapshot");
	publishOne(folder, stage, receipt, historyPath);
	await checkpoint("history");
	if (receipt.newFiles[journalPath]) publishOne(folder, stage, receipt, journalPath);
	await checkpoint("journal");
	await checkpoint("legacy-cleanup");
	for (const path of receipt.deletions) {
		if (exists(join(folder, path))) {
			if (fileDigest(join(folder, path), path) !== receipt.oldFiles[path])
				throw new Error(`PostgreSQL legacy snapshot changed: ${path}`);
			unlinkSync(join(folder, path));
			await options.faultInject?.(`deleted:${path}`);
		}
	}
	readPgMetadata(folder, { allowPending: true });
	await checkpoint("complete");
	// Final metadata validation and all expected hashes precede evidence cleanup.
	verifyRecoverable(root, folder, receipt);
	unlinkSync(join(meta, PENDING_FILE));
	cleanupStage(root, receipt.stage, receipt.token);
}
function parseArgs(
	operation: PostgresMigrationOperation,
	args: string[],
): { dryRun: boolean; custom: boolean } {
	if (operation === "baseline") {
		if (args.some((arg) => arg !== "--dry-run") || args.length > 1)
			throw new Error("baseline accepts only --dry-run (structural convergence, not SQL squash)");
		return { dryRun: args.includes("--dry-run"), custom: false };
	}
	if (operation !== "generate") {
		if (args.length) throw new Error(`${operation} does not accept additional flags`);
		return { dryRun: false, custom: false };
	}
	let custom = false;
	let named = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] ?? "";
		if (arg === "--custom" && !custom) custom = true;
		else if ((arg === "--name" || arg.startsWith("--name=")) && !named) {
			named = true;
			const name = arg === "--name" ? args[++i] : arg.slice(7);
			if (!name || !/^[A-Za-z0-9_-]{1,128}$/.test(name))
				throw new Error("Invalid PostgreSQL migration --name");
		} else throw new Error(`Unsupported PostgreSQL generate flag: ${arg}`);
	}
	return { dryRun: false, custom };
}
function result(
	operation: PostgresMigrationOperation,
	before: Metadata,
	changed: boolean,
	dryRun = false,
): PostgresMigrationResult {
	return {
		operation,
		changed,
		dryRun,
		migrations: before.journal.entries.length,
		snapshotId: before.snapshot.id,
	};
}

/** Offline, same-machine controlled publication. Individual renames are atomic, not the multi-file transaction. */
export async function executePostgresMigrations(
	operation: PostgresMigrationOperation,
	args: string[] = [],
	options: PostgresMigrationOptions = {},
): Promise<PostgresMigrationResult> {
	if (!["baseline", "generate", "check", "resume"].includes(operation))
		throw new Error(`Unsupported PostgreSQL migration operation: ${operation}`);
	const { dryRun, custom } = parseArgs(operation, args);
	const { root, folder, meta } = rootPaths(options.root);
	if (operation !== "resume" && exists(join(meta, PENDING_FILE)))
		throw new Error("Unfinished PostgreSQL generation pending receipt exists; use resume");
	if (operation === "baseline" && dryRun) {
		const before = readPgMetadata(folder, { allowLegacy: true });
		return result(operation, before, before.mode === "legacy", true);
	}
	if (operation === "check") {
		const before = readPgMetadata(folder);
		const owned = makeStage(root);
		try {
			copyInput(owned.stage, folder, before);
			const initial = Object.fromEntries(
				inventory(owned.stage, true).map((path) => [
					path,
					fileDigest(join(owned.stage, path), path),
				]),
			);
			acceptKit(
				await (options.runKit ?? runPostgresKit)({
					root,
					stageOut: owned.stageRelative,
					operation: "check",
					schemaPath: options.schemaPath,
				}),
				"check",
			);
			const after = Object.fromEntries(
				inventory(owned.stage, true).map((path) => [
					path,
					fileDigest(join(owned.stage, path), path),
				]),
			);
			if (JSON.stringify(initial) !== JSON.stringify(after))
				throw new Error("PostgreSQL check modified staged assets");
			readPgMetadata(folder);
			assertUnchanged(folder, before.files);
			return result(operation, before, false);
		} finally {
			cleanupStage(root, owned.stageRelative, owned.token);
		}
	}
	let release: () => void;
	try {
		release = acquireSqliteGenerationLock(meta);
	} catch (error) {
		throw new Error(`PostgreSQL generation lock unavailable: ${(error as Error).message}`, {
			cause: error,
		});
	}
	let owned: ReturnType<typeof makeStage> | undefined;
	let receipted = false;
	try {
		if (operation === "resume") {
			const receipt = parseReceipt(meta);
			await publish(root, folder, meta, receipt, options);
			return result(operation, readPgMetadata(folder), true);
		}
		const before = readPgMetadata(folder, { allowLegacy: operation === "baseline" });
		if (operation === "baseline" && before.mode === "baseline")
			return result(operation, before, false);
		owned = makeStage(root);
		let files: Record<string, string | Uint8Array>;
		let schema: Receipt["schema"];
		if (operation === "baseline") {
			files = { [currentPath]: before.snapshotText, [historyPath]: before.historyText };
		} else {
			schema = schemaInput(root, options.schemaPath);
			const oldSnapshot = copyInput(owned.stage, folder, before);
			const text = acceptKit(
				await (options.runKit ?? runPostgresKit)({
					root,
					stageOut: owned.stageRelative,
					operation: "generate",
					args,
					schemaPath: schema.path,
					interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
				}),
				"generate",
			);
			const staged = inventory(owned.stage, true);
			for (const [path, sha] of Object.entries(before.files))
				if (path.endsWith(".sql") && fileDigest(join(owned.stage, path), path) !== sha)
					throw new Error(`PostgreSQL Drizzle rewrote historical SQL: ${path}`);
			if (fileDigest(join(owned.stage, oldSnapshot), oldSnapshot) !== digest(before.snapshotText))
				throw new Error("PostgreSQL Drizzle rewrote baseline snapshot");
			const journalText = readBounded(
				join(owned.stage, journalPath),
				MAX_METADATA_BYTES,
			).toString();
			const journal = parseJournal(journalText);
			if (
				journal.version !== before.journal.version ||
				journal.dialect !== before.journal.dialect ||
				JSON.stringify(journal.entries.slice(0, before.journal.entries.length)) !==
					JSON.stringify(before.journal.entries)
			)
				throw new Error("PostgreSQL Drizzle rewrote the journal prefix");
			const added = journal.entries.length - before.journal.entries.length;
			const oldAssets = [
				...Object.keys(before.files).filter((path) => path.endsWith(".sql")),
				oldSnapshot,
				journalPath,
			].sort();
			if (added === 0) {
				if (
					!/No schema changes, nothing to migrate/i.test(text) ||
					JSON.stringify(staged) !== JSON.stringify(oldAssets) ||
					digest(journalText) !== digest(before.journalText)
				)
					throw new Error("Invalid PostgreSQL no-op generation output");
				assertSchema(root, schema);
				assertUnchanged(folder, before.files);
				return result(operation, before, false);
			}
			if (added !== 1 || /No schema changes, nothing to migrate/i.test(text))
				throw new Error("PostgreSQL generation must append exactly one migration");
			const entry = journal.entries.at(-1);
			const previous = before.journal.entries.at(-1);
			if (
				!entry ||
				!previous ||
				entry.idx !== previous.idx + 1 ||
				entry.version !== previous.version
			)
				throw new Error("Invalid PostgreSQL appended migration index/version");
			const newSnapshotPath = `meta/${String(entry.idx).padStart(4, "0")}_snapshot.json`;
			const sqlPath = `${entry.tag}.sql`;
			if (
				before.files[sqlPath] ||
				JSON.stringify(staged) !== JSON.stringify([...oldAssets, newSnapshotPath, sqlPath].sort())
			)
				throw new Error("Unexpected PostgreSQL generation assets");
			const snapshotText = readBounded(
				join(owned.stage, newSnapshotPath),
				MAX_SNAPSHOT_BYTES,
			).toString();
			const snapshot = parseSnapshot(snapshotText);
			if (
				snapshot.id === before.snapshot.id ||
				before.history.entries.some((item) => item.id === snapshot.id) ||
				snapshot.prevId !== before.snapshot.id ||
				snapshot.version !== before.snapshot.version
			)
				throw new Error("PostgreSQL generated snapshot has an invalid parent/id/version");
			const outputHashes = stagedHashes(owned.stage);
			if (!custom) {
				// Native Kit is the source-schema interpreter, not a second DDL implementation.
				// A newly generated baseline must immediately converge to a byte-preserving no-op.
				const verification = acceptKit(
					await (options.runKit ?? runPostgresKit)({
						root,
						stageOut: owned.stageRelative,
						operation: "generate",
						args: [],
						schemaPath: schema.path,
						interactive: false,
					}),
					"generate",
				);
				if (
					!/No schema changes, nothing to migrate/i.test(verification) ||
					JSON.stringify(stagedHashes(owned.stage)) !== JSON.stringify(outputHashes)
				)
					throw new Error("PostgreSQL generated snapshot does not converge with the source schema");
			}
			if (custom) {
				// Native custom resets rename annotations. They are not database schema.
				const {
					id: _oldId,
					prevId: _oldParent,
					_meta: _oldRenames,
					...oldSchema
				} = before.snapshot;
				const { id: _newId, prevId: _newParent, _meta: _newRenames, ...newSchema } = snapshot;
				// Schema serializer field order is immaterial; array/index order remains significant.
				if (!isDeepStrictEqual(oldSchema, newSchema))
					throw new Error("PostgreSQL custom generation unexpectedly changed the schema baseline");
			}
			const history = {
				version: 1 as const,
				entries: [
					...before.history.entries,
					{
						idx: entry.idx,
						tag: entry.tag,
						id: snapshot.id,
						prevId: snapshot.prevId,
						version: snapshot.version,
						snapshotDigest: digest(snapshotText),
					},
				],
			};
			const preservedJournal = appendJournal(before.journalText, entry);
			validateHistory(parseJournal(preservedJournal), history, snapshotText);
			files = {
				[sqlPath]: readBounded(join(owned.stage, sqlPath), MAX_SQL_BYTES),
				[currentPath]: snapshotText,
				[historyPath]: `${JSON.stringify(history, null, "\t")}\n`,
				[journalPath]: preservedJournal,
			};
		}
		const receipt: Receipt = {
			version: 1,
			operation,
			stage: owned.stageRelative,
			token: owned.token,
			phase: "receipt",
			oldFiles: before.files,
			newFiles: payload(owned.stage, files),
			deletions: before.legacySnapshots,
			...(schema ? { schema } : {}),
		};
		writeFileSync(join(owned.stage, ".transaction.json"), receiptProposal(receipt), { flag: "wx" });
		await options.beforePublish?.();
		assertSchema(root, schema);
		readPgMetadata(folder, { allowLegacy: operation === "baseline" });
		assertUnchanged(folder, before.files);
		validateReceiptPayload(root, receipt);
		writeReceipt(meta, receipt, true);
		receipted = true;
		await options.faultInject?.("receipt");
		await publish(root, folder, meta, receipt, options);
		return result(operation, readPgMetadata(folder), true);
	} finally {
		try {
			if (owned && !receipted && !exists(join(meta, PENDING_FILE)))
				cleanupStage(root, owned.stageRelative, owned.token);
		} finally {
			release();
		}
	}
}
