import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { types } from "node:util";
import { hotSafe } from "../lib/hot-safe";

export type FileHistoryCatalogStage = "initialize" | "budget_read" | "publication_accounting";
export type FileHistoryStage =
	| "initialize"
	| "resolve_scope"
	| "prepare_scope"
	| "begin_operation"
	| "link_tool"
	| "publish_before"
	| "publish_intended_after"
	| "read_after"
	| "verify_after"
	| "publish_observed_after"
	| "record_effect"
	| "finish_operation"
	| "project_effect"
	| "record_no_dispatch";
type CatalogReason = "key_mismatch" | "cardinality" | "budget_id";
type FileHistoryErrorLabels = Readonly<{ errorCode: string; errorName: string }>;
type CatalogDiagnostic = Readonly<{
	errorCode: "namespace_mismatch";
	errorName: "FileChangeBlobCatalogError";
	catalogStage: FileHistoryCatalogStage;
	reason: CatalogReason;
	observedRows?: 1 | 2;
	rowReadLimit?: 2;
	rowIdMatches?: boolean;
	keysEqual?: boolean;
	storedKeyFingerprint?: string;
	currentKeyFingerprint?: string;
	status?: "unverified" | "reconciling" | "ready";
	generation?: number;
	updatedAt?: string;
}>;

// Sidecars never become enumerable error properties or persistent tool diagnostics.
const catalogFailures = new WeakMap<object, CatalogDiagnostic>();
const budgetFailures = new WeakMap<object, FileHistoryErrorLabels>();
const CATALOG_ERROR_LABELS = Object.freeze({
	errorCode: "namespace_mismatch",
	errorName: "FileChangeBlobCatalogError",
} as const);
const BUDGET_ERROR_LABELS = Object.freeze({
	errorCode: "history_budget_exceeded",
	errorName: "Error",
});
// Fixed categories only: custom names/codes can themselves contain private paths.
const ERROR_NAMES = new Set([
	"Error",
	"TypeError",
	"RangeError",
	"ReferenceError",
	"SyntaxError",
	"URIError",
	"EvalError",
	"AggregateError",
	"AbortError",
	"TimeoutError",
	"SQLiteError",
	"DOMException",
	"LocalFileValidationError",
	"FileChangeBlobStoreError",
	"FileChangeBlobCatalogError",
]);
const ERROR_CODES = new Set([
	"EACCES",
	"EPERM",
	"ENOENT",
	"EEXIST",
	"EIO",
	"ENOSPC",
	"EDQUOT",
	"EROFS",
	"ENOTDIR",
	"ELOOP",
	"EBUSY",
	"ETIMEDOUT",
	"ABORT_ERR",
	"SQLITE_BUSY",
	"SQLITE_LOCKED",
	"SQLITE_CONSTRAINT",
	"SQLITE_IOERR",
	"SQLITE_FULL",
	"SQLITE_READONLY",
	"SQLITE_CORRUPT",
	"SQLITE_CANTOPEN",
	"namespace_mismatch",
	"namespace_unverified",
	"quota_exceeded",
	"invalid_input",
	"invalid_ref",
	"catalog_mismatch",
	"size_mismatch",
	"hash_mismatch",
	"invalid_path",
	"unsafe_object",
	"not_found",
	"too_large",
	"insufficient_space",
	"disk_full",
	"aborted",
	"timeout",
]);
const HASH = /^[a-f0-9]{64}$/;
const UPDATED_AT = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?$/;

function keyFingerprint(key: unknown): string | undefined {
	// Only the high-entropy combined hash is comparable across processes.
	return typeof key === "string" && key.length === 64 && HASH.test(key)
		? createHash("sha256").update(key).digest("hex")
		: undefined;
}

export function attachFileHistoryCatalogDiagnostic<T extends object>(
	error: T,
	input: {
		stage: FileHistoryCatalogStage;
		reason: CatalogReason;
		currentKey: string;
		row?: unknown;
		observedRows?: 1 | 2;
		rowIdMatches?: boolean;
	},
): T {
	try {
		const row = input.row as Record<string, unknown> | undefined;
		const diagnostic: { -readonly [K in keyof CatalogDiagnostic]: CatalogDiagnostic[K] } = {
			...CATALOG_ERROR_LABELS,
			catalogStage: input.stage,
			reason: input.reason,
		};
		if (input.observedRows !== undefined) {
			diagnostic.observedRows = input.observedRows;
			diagnostic.rowReadLimit = 2;
		}
		if (input.rowIdMatches !== undefined) diagnostic.rowIdMatches = input.rowIdMatches;
		const current = keyFingerprint(input.currentKey);
		if (current) diagnostic.currentKeyFingerprint = current;
		if (row) {
			const stored = keyFingerprint(row.namespaceKey);
			if (stored) diagnostic.storedKeyFingerprint = stored;
			if (typeof row.namespaceKey === "string")
				diagnostic.keysEqual = row.namespaceKey === input.currentKey;
			if (row.status === "unverified" || row.status === "reconciling" || row.status === "ready")
				diagnostic.status = row.status;
			if (
				typeof row.generation === "number" &&
				Number.isSafeInteger(row.generation) &&
				row.generation >= 0
			)
				diagnostic.generation = row.generation;
			if (
				typeof row.updatedAt === "string" &&
				row.updatedAt.length <= 32 &&
				UPDATED_AT.test(row.updatedAt) &&
				Number.isFinite(Date.parse(row.updatedAt))
			)
				diagnostic.updatedAt = row.updatedAt;
		}
		catalogFailures.set(error, Object.freeze(diagnostic));
	} catch {
		// Diagnosis must preserve the exact original catalog exception.
	}
	return error;
}

function inspectable(error: unknown): error is object {
	return (
		error !== null &&
		(typeof error === "object" || typeof error === "function") &&
		!types.isProxy(error)
	);
}

export function attachFileHistoryBudgetDiagnostic<T extends object>(error: T): T {
	try {
		budgetFailures.set(error, BUDGET_ERROR_LABELS);
	} catch {
		// The budget exception retains its original type, message and properties.
	}
	return error;
}

function fileHistoryErrorLabels(error: unknown): FileHistoryErrorLabels {
	let errorCode = "unknown";
	let errorName = "unknown";
	try {
		let cause: unknown = error;
		for (let depth = 0; depth < 4 && inspectable(cause); depth++) {
			if (catalogFailures.has(cause)) return CATALOG_ERROR_LABELS;
			const budget = budgetFailures.get(cause);
			if (budget) return budget;
			const descriptor = Object.getOwnPropertyDescriptor(cause, "cause");
			if (!descriptor || !("value" in descriptor)) break;
			cause = descriptor.value;
		}
		if (!inspectable(error)) return { errorCode, errorName };
		const code = Object.getOwnPropertyDescriptor(error, "code");
		if (code && "value" in code && typeof code.value === "string" && ERROR_CODES.has(code.value))
			errorCode = code.value;
		let object: object | null = error;
		for (let depth = 0; depth < 4 && inspectable(object); depth++) {
			const name = Object.getOwnPropertyDescriptor(object, "name");
			if (name) {
				if ("value" in name && typeof name.value === "string" && ERROR_NAMES.has(name.value))
					errorName = name.value;
				break;
			}
			object = Object.getPrototypeOf(object);
		}
	} catch {
		// Labels never invoke getters or inspect Proxy targets.
	}
	return { errorCode, errorName };
}

export function fileHistoryCatalogDiagnostic(error: unknown): CatalogDiagnostic | undefined {
	try {
		// BlobStore preserves accounting failures as AggregateError.cause. Follow only
		// bounded own data properties, never arbitrary getters or error inventories.
		for (let depth = 0; depth < 4; depth++) {
			if (!inspectable(error)) return;
			const diagnostic = catalogFailures.get(error);
			if (diagnostic) return diagnostic;
			const cause = Object.getOwnPropertyDescriptor(error, "cause");
			if (!cause || !("value" in cause)) return;
			error = cause.value;
		}
	} catch {
		// Error introspection is diagnostic-only, including on hostile proxies.
	}
	return undefined;
}

type IdentityDiagnostic = Readonly<{
	currentKeyFingerprint?: string;
	identityScope: "process";
	identityScopeId: string;
	sourceFingerprint: string;
	rootFingerprint: string;
	directoryFingerprint: string;
	deviceFingerprint: string;
	inodeFingerprint: string;
	birthtimeFingerprint: string;
	birthtimeAvailable: boolean;
}>;
const INTERVAL_MS = 60_000;

/** One context and two scalar counters per runtime; no per-source event inventory. */
export class FileHistoryNamespaceDiagnostics {
	private identity?: IdentityDiagnostic;
	private lastEmission?: number;
	private failures = 0;

	constructor(
		private readonly options: {
			now?: () => number;
			log?: (message: string, fields: Record<string, unknown>) => void;
		} = {},
	) {}

	clearIdentity(): void {
		this.identity = undefined;
	}

	rememberIdentity(input: {
		sourceInstanceId: string;
		root: string;
		directoryIdentity: string;
		namespaceKey: string;
	}): void {
		try {
			if (
				[input.sourceInstanceId, input.root].some(
					(value) => typeof value !== "string" || value.length > 65_536,
				)
			)
				return;
			const parts = /^(\d{1,40}):(\d{1,40}):(\d{1,40})$/.exec(input.directoryIdentity);
			if (!parts) return;
			const process = hotSafe("file-history-namespace-diagnostic-process:v1", () => ({
				key: randomBytes(32),
				id: randomUUID(),
			}));
			const fingerprint = (field: string, value: string) =>
				createHmac("sha256", process.key)
					.update(`file-history-namespace-v1:${field}:`)
					.update(value)
					.digest("hex");
			this.identity = Object.freeze({
				currentKeyFingerprint: keyFingerprint(input.namespaceKey),
				identityScope: "process",
				identityScopeId: process.id,
				sourceFingerprint: fingerprint("source", input.sourceInstanceId),
				rootFingerprint: fingerprint("root", input.root),
				directoryFingerprint: fingerprint("directory", input.directoryIdentity),
				deviceFingerprint: fingerprint("device", parts[1]),
				inodeFingerprint: fingerprint("inode", parts[2]),
				birthtimeFingerprint: fingerprint("birthtime", parts[3]),
				birthtimeAvailable: /[1-9]/.test(parts[3]),
			});
		} catch {
			// No crypto, formatting or diagnostic failure may block actual IO.
		}
	}

	failure(historyStage: FileHistoryStage, error: unknown): void {
		try {
			this.failures = Math.min(Number.MAX_SAFE_INTEGER, this.failures + 1);
			const now = (this.options.now ?? (() => performance.now()))();
			if (!Number.isFinite(now)) return;
			if (this.lastEmission !== undefined && now - this.lastEmission < INTERVAL_MS) return;
			const failureCount = this.failures;
			// Consume the interval even if the diagnostic logger itself throws.
			this.lastEmission = now;
			this.failures = 0;
			const bunVersion = typeof Bun === "undefined" ? undefined : Bun.version;
			(this.options.log ?? ((message, fields) => console.warn(message, fields)))(
				"File history namespace diagnostic",
				{
					diagnosticVersion: 1,
					historyStage,
					failureCount,
					...fileHistoryErrorLabels(error),
					namespaceKeyAlgorithm: "sha256-length-prefixed-v1",
					keyFingerprintAlgorithm: "sha256",
					keyFingerprintScope: "cross_process",
					identityFingerprintAlgorithm: "hmac-sha256-field-v1",
					...(bunVersion && /^[\w.+-]{1,64}$/.test(bunVersion) ? { bunVersion } : {}),
					...this.identity,
					catalog: fileHistoryCatalogDiagnostic(error),
				},
			);
		} catch {
			// This log is independent of the existing unavailable-history warning.
		}
	}
}
