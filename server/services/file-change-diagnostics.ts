/** Operational diagnostics only. Never use these observations to settle an effect
 * or release a lease. No paths, file bytes, error messages or stacks are retained. */
const STAGES = [
	"initialize",
	"resolve_source",
	"resolve_target",
	"prepare_scope",
	"capture_footprint",
	"hash_request",
	"acquire_lease",
	"acquire_history_lock",
	"acquire_workspace_lock",
	"acquire_namespace_lock",
	"validate_target",
	"read_before",
	"construct",
	"publish_before",
	"publish_intended",
	"prepare_evidence",
	"apply_adapter",
	"io_validate",
	"io_read_before",
	"io_prepare_parents",
	"io_open",
	"io_read_descriptor",
	"io_validate_before_mutation",
	"io_truncate",
	"io_write",
	"io_sync",
	"io_verify_identity",
	"io_close",
	"io_final_validate",
	"io_final_read",
	"after_validate",
	"after_read",
	"publish_observed",
	"settle_evidence",
	"verify_result",
	"quarantine",
] as const;
export type FileChangeDiagnosticStage = (typeof STAGES)[number];
const MAX_FAILURES = 8;
const MAX_DURATION_MS = 0x7fffffff;

interface Phase {
	stage: FileChangeDiagnosticStage;
	elapsedMs: number;
	visits: number;
}
interface Failure {
	stage: FileChangeDiagnosticStage;
	name: string;
	code?: string;
}
interface Context {
	sourceId?: string;
	operationId?: string;
	leaseId?: string;
	abortSource?: "caller" | "operation_budget";
}
export interface FileChangeDiagnosticSnapshot extends Context {
	version: 1;
	elapsedMs: number;
	phases: Phase[];
	failures: Failure[];
	droppedFailures: number;
}

export interface FileChangeTiming {
	waitMs: number;
	executionMs: number;
	totalMs: number;
}
const attached = new WeakMap<object, FileChangeDiagnosticSnapshot>();
const attachedTiming = new WeakMap<object, FileChangeTiming>();

export function attachFileChangeTiming(error: unknown, timing: FileChangeTiming): unknown {
	if (error !== null && (typeof error === "object" || typeof error === "function"))
		attachedTiming.set(error, { ...timing });
	return error;
}
export function getFileChangeTiming(error: unknown): FileChangeTiming | undefined {
	if (error === null || (typeof error !== "object" && typeof error !== "function"))
		return undefined;
	const timing = attachedTiming.get(error);
	if (timing) return { ...timing };
	const details = attached.get(error);
	if (!details) return undefined;
	const waitMs = Math.min(
		details.elapsedMs,
		details.phases.reduce(
			(sum, phase) => sum + (phase.stage.startsWith("acquire_") ? phase.elapsedMs : 0),
			0,
		),
	);
	return { waitMs, executionMs: details.elapsedMs - waitMs, totalMs: details.elapsedMs };
}
function duration(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.min(MAX_DURATION_MS, Math.round(value))) : 0;
}
// Fixed categories, not merely "safe-looking" strings: a filename can consist
// entirely of ASCII letters too. Unknown custom labels must not enter the log.
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
	"LocalFileValidationError",
	"WorkspaceWriteCoordinatorError",
	"FileChangeBlobStoreError",
	"FileChangeBlobCatalogError",
	"DOMException",
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
	"EMFILE",
	"ENFILE",
	"EISDIR",
	"ENOTDIR",
	"ENOTEMPTY",
	"ELOOP",
	"EINVAL",
	"EBADF",
	"EBUSY",
	"EINTR",
	"EAGAIN",
	"ETIMEDOUT",
	"ECANCELED",
	"EFBIG",
	"ENOMEM",
	"ENAMETOOLONG",
	"ENOSYS",
	"ENOTSUP",
	"EXDEV",
	"ESTALE",
	"ABORT_ERR",
	"ERR_OUT_OF_RANGE",
	"ERR_INVALID_ARG_TYPE",
	"ERR_INVALID_ARG_VALUE",
	"SQLITE_BUSY",
	"SQLITE_LOCKED",
	"SQLITE_CONSTRAINT",
	"SQLITE_CONSTRAINT_TRIGGER",
	"SQLITE_CONSTRAINT_FOREIGNKEY",
	"SQLITE_CONSTRAINT_UNIQUE",
	"SQLITE_IOERR",
	"SQLITE_FULL",
	"SQLITE_READONLY",
	"SQLITE_CORRUPT",
	"SQLITE_CANTOPEN",
]);
const domExceptionName = Object.getOwnPropertyDescriptor(DOMException.prototype, "name")?.get;

function errorLabels(error: unknown): { name: string; code?: string } {
	let name = "UnknownError";
	let code: string | undefined;
	try {
		if (error instanceof DOMException) {
			// Invoke only the native accessor, never an overridden instance getter.
			const value = domExceptionName?.call(error);
			name = typeof value === "string" && ERROR_NAMES.has(value) ? value : "DOMException";
		} else if (error instanceof Error) {
			name = "Error";
			let object: object | null = error;
			for (let depth = 0; object && depth < 4; depth++) {
				const descriptor = Object.getOwnPropertyDescriptor(object, "name");
				if (descriptor) {
					const value = descriptor.value;
					if (typeof value === "string" && ERROR_NAMES.has(value)) name = value;
					break;
				}
				object = Object.getPrototypeOf(object);
			}
		}
		if (error !== null && typeof error === "object") {
			const value = Object.getOwnPropertyDescriptor(error, "code")?.value;
			if (typeof value === "string" && ERROR_CODES.has(value)) code = value;
		}
	} catch {
		// A diagnostic must not replace the original error.
	}
	return { name, ...(code ? { code } : {}) };
}

export class FileChangeDiagnostics {
	private readonly started: number;
	private active?: { stage: FileChangeDiagnosticStage; since: number };
	private readonly phases = new Map<FileChangeDiagnosticStage, Phase>();
	private readonly failures: Failure[] = [];
	private readonly errors: unknown[] = [];
	private droppedFailures = 0;
	private context: Context = {};
	private ended?: number;

	constructor(private readonly clock: () => number = () => performance.now()) {
		this.started = clock();
	}

	identify(context: Context): void {
		this.context = { ...this.context, ...context };
	}

	enter(stage: FileChangeDiagnosticStage): void {
		const now = this.clock();
		this.flush(now);
		const phase = this.phases.get(stage) ?? { stage, elapsedMs: 0, visits: 0 };
		phase.visits = Math.min(MAX_DURATION_MS, phase.visits + 1);
		this.phases.set(stage, phase);
		this.active = { stage, since: now };
	}

	fail(error: unknown): void {
		if (!this.active) return;
		if (this.failures.length >= MAX_FAILURES) {
			this.droppedFailures = Math.min(MAX_DURATION_MS, this.droppedFailures + 1);
			return;
		}
		this.failures.push({ stage: this.active.stage, ...errorLabels(error) });
		this.errors.push(error);
	}

	hasFailure(error: unknown): boolean {
		return this.errors.includes(error);
	}

	/** Measured admission waits, separate from the actual protected IO window. */
	timing(): { waitMs: number; executionMs: number; totalMs: number } {
		const snapshot = this.snapshot();
		const waitMs = Math.min(
			snapshot.elapsedMs,
			snapshot.phases.reduce(
				(sum, phase) => sum + (phase.stage.startsWith("acquire_") ? phase.elapsedMs : 0),
				0,
			),
		);
		return {
			waitMs,
			executionMs: Math.max(0, snapshot.elapsedMs - waitMs),
			totalMs: snapshot.elapsedMs,
		};
	}
	finish(): void {
		if (this.ended !== undefined) return;
		this.ended = this.clock();
		this.flush(this.ended);
		this.active = undefined;
	}

	snapshot(): FileChangeDiagnosticSnapshot {
		const now = this.ended ?? this.clock();
		return {
			version: 1,
			...this.context,
			elapsedMs: duration(now - this.started),
			phases: [...this.phases.values()].map((phase) => ({
				...phase,
				elapsedMs: duration(
					phase.elapsedMs + (this.active?.stage === phase.stage ? now - this.active.since : 0),
				),
			})),
			failures: this.failures.map((failure) => ({ ...failure })),
			droppedFailures: this.droppedFailures,
		};
	}

	/** Preserve Error subclasses, identity and causes used by existing recovery paths. */
	/** Preserve all thrown values, including primitive AbortSignal reasons. */
	attach(error: unknown): unknown {
		if (error !== null && (typeof error === "object" || typeof error === "function"))
			attached.set(error, this.snapshot());
		// Primitive failures still appear in the runtime log. Never wrap them just
		// to make them eligible for the sidecar: cancellation reason identity matters.
		return error;
	}

	private flush(now: number): void {
		if (!this.active) return;
		const phase = this.phases.get(this.active.stage);
		if (phase) phase.elapsedMs = duration(phase.elapsedMs + now - this.active.since);
	}
}

export function getFileChangeDiagnostics(error: unknown): FileChangeDiagnosticSnapshot | undefined {
	return error !== null && (typeof error === "object" || typeof error === "function")
		? attached.get(error)
		: undefined;
}

/** Included in the persisted tool output, not just the server's transient log. */
export function fileChangeDiagnosticSuffix(error: unknown): string {
	const details = getFileChangeDiagnostics(error);
	if (!details) return "";
	const failures = details.failures.map(({ stage, name, code }) => `${stage}(${code ?? name})`);
	return ` [file-change: ${failures.join(", ") || "no_stage_failure"}${
		details.operationId ? `; operation=${details.operationId}` : ""
	}${details.leaseId ? `; lease=${details.leaseId}` : ""}]`;
}

export function fileChangeDiagnosticMetadata(error: unknown): Record<string, unknown> | undefined {
	const details = getFileChangeDiagnostics(error);
	const timing = getFileChangeTiming(error);
	return details || timing
		? {
				...(details ? { fileChangeDiagnostics: details } : {}),
				...(timing ? { fileChangeTiming: timing } : {}),
			}
		: undefined;
}
