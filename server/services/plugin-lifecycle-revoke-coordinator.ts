export const PLUGIN_LIFECYCLE_REVOKE_LAYERS = [
	"ui_session",
	"capability_broker",
	"event_gateway",
	"scheduler",
	"secret_broker",
	"tool_registry",
	"mcp_adapter",
	"provider_registry",
] as const;

export type PluginLifecycleRevokeLayer = (typeof PLUGIN_LIFECYCLE_REVOKE_LAYERS)[number];

export const PLUGIN_LIFECYCLE_REVOKE_EVENT_KINDS = [
	"disable",
	"deactivate",
	"crash",
	"quarantine",
	"upgrade",
	"uninstall",
	"runtime_generation",
	"grant_revision",
] as const;

export type PluginLifecycleRevokeEventKind = (typeof PLUGIN_LIFECYCLE_REVOKE_EVENT_KINDS)[number];
export type PluginLifecycleRevokeEventKindInput =
	| PluginLifecycleRevokeEventKind
	| "runtime-generation"
	| "grant-revision";

export type PluginLifecycleRevokeAction = "revoke" | "invalidate" | "disable" | "clear";

export interface PluginLifecycleRevokeEvent {
	eventId: string;
	pluginId: string;
	kind: PluginLifecycleRevokeEventKindInput;
	runtimeId?: string;
	runtimeGeneration?: number;
	grantRevision?: number;
	reason?: string;
	metadata?: Readonly<Record<string, JsonValue>>;
}

export interface PluginLifecycleRevokeContext {
	event: Readonly<PluginLifecycleRevokeEvent & { kind: PluginLifecycleRevokeEventKind }>;
	layer: PluginLifecycleRevokeLayer;
	action: PluginLifecycleRevokeAction;
	stepIndex: number;
}

export type PluginLifecycleRevokeAdapter = (
	context: PluginLifecycleRevokeContext,
) => void | Promise<void>;

/**
 * Adapters deliberately receive functions instead of concrete services. The coordinator never
 * assumes that a concrete service exposes a particular revoke/invalidate/disable/clear method.
 */
export type PluginLifecycleRevokeAdapters = Partial<
	Readonly<Record<PluginLifecycleRevokeLayer, PluginLifecycleRevokeAdapter>>
>;

export interface PluginLifecycleRevokeLogger {
	error?: (
		message: string,
		context: {
			event: Readonly<PluginLifecycleRevokeEvent & { kind: PluginLifecycleRevokeEventKind }>;
			errors: readonly PluginLifecycleRevokeFailure[];
		},
	) => void | Promise<void>;
}

export interface PluginLifecycleRevokeCoordinatorOptions {
	adapters: PluginLifecycleRevokeAdapters;
	/** Continue through the fixed order after an adapter fails. Defaults to true. */
	continueOnError?: boolean;
	logger?: PluginLifecycleRevokeLogger;
	now?: () => Date;
	maxHistory?: number;
}

export type PluginLifecycleRevokeStepStatus = "succeeded" | "failed" | "not_attempted";

export interface PluginLifecycleRevokeFailure {
	layer: PluginLifecycleRevokeLayer;
	action: PluginLifecycleRevokeAction;
	code?: string;
	name: string;
	message: string;
}

export interface PluginLifecycleRevokeStepReport {
	layer: PluginLifecycleRevokeLayer;
	action: PluginLifecycleRevokeAction;
	status: PluginLifecycleRevokeStepStatus;
	error?: PluginLifecycleRevokeFailure;
}

export interface PluginLifecycleRevokeReport {
	eventId: string;
	pluginId: string;
	kind: PluginLifecycleRevokeEventKind;
	status: "succeeded" | "failed";
	deduplicated: boolean;
	startedAt: string;
	completedAt: string;
	steps: readonly PluginLifecycleRevokeStepReport[];
	errors: readonly PluginLifecycleRevokeFailure[];
}

export class PluginLifecycleRevokeError extends Error {
	readonly report: PluginLifecycleRevokeReport;
	readonly aggregate: AggregateError;

	constructor(report: PluginLifecycleRevokeReport) {
		const causes = report.errors.map(
			(error) => new Error(`${error.layer}/${error.action}: ${error.message}`),
		);
		const aggregate = new AggregateError(causes, "Plugin lifecycle revocation failed");
		super(
			`Plugin lifecycle revocation failed for ${report.pluginId} (${report.eventId}): ${
				report.errors.length
			} adapter error(s)`,
		);
		this.name = "PluginLifecycleRevokeError";
		this.report = report;
		this.aggregate = aggregate;
	}
}

export class PluginLifecycleRevokeConflictError extends Error {
	readonly eventId: string;

	constructor(eventId: string) {
		super(`Lifecycle event ID has already been used with a different payload: ${eventId}`);
		this.name = "PluginLifecycleRevokeConflictError";
		this.eventId = eventId;
	}
}

export type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };

const ACTIONS_BY_KIND: Readonly<
	Record<
		PluginLifecycleRevokeEventKind,
		Readonly<Record<PluginLifecycleRevokeLayer, PluginLifecycleRevokeAction>>
	>
> = {
	disable: {
		ui_session: "revoke",
		capability_broker: "revoke",
		event_gateway: "revoke",
		scheduler: "disable",
		secret_broker: "revoke",
		tool_registry: "disable",
		mcp_adapter: "disable",
		provider_registry: "disable",
	},
	deactivate: {
		ui_session: "revoke",
		capability_broker: "revoke",
		event_gateway: "revoke",
		scheduler: "disable",
		secret_broker: "revoke",
		tool_registry: "disable",
		mcp_adapter: "disable",
		provider_registry: "disable",
	},
	crash: {
		ui_session: "revoke",
		capability_broker: "revoke",
		event_gateway: "revoke",
		scheduler: "disable",
		secret_broker: "revoke",
		tool_registry: "disable",
		mcp_adapter: "disable",
		provider_registry: "disable",
	},
	quarantine: {
		ui_session: "revoke",
		capability_broker: "revoke",
		event_gateway: "revoke",
		scheduler: "disable",
		secret_broker: "revoke",
		tool_registry: "disable",
		mcp_adapter: "disable",
		provider_registry: "disable",
	},
	upgrade: {
		ui_session: "revoke",
		capability_broker: "invalidate",
		event_gateway: "invalidate",
		scheduler: "disable",
		secret_broker: "revoke",
		tool_registry: "disable",
		mcp_adapter: "disable",
		provider_registry: "invalidate",
	},
	uninstall: {
		ui_session: "clear",
		capability_broker: "clear",
		event_gateway: "clear",
		scheduler: "clear",
		secret_broker: "clear",
		tool_registry: "clear",
		mcp_adapter: "clear",
		provider_registry: "clear",
	},
	runtime_generation: {
		// UI sessions are bound to the stable installation UUID, NOT the runtime
		// generation: an idle/backend runtime restart must not tear down open
		// panels. "invalidate" is a no-op for the ui_session layer below.
		ui_session: "invalidate",
		capability_broker: "invalidate",
		event_gateway: "invalidate",
		scheduler: "revoke",
		secret_broker: "revoke",
		tool_registry: "invalidate",
		mcp_adapter: "invalidate",
		provider_registry: "invalidate",
	},
	grant_revision: {
		ui_session: "revoke",
		capability_broker: "invalidate",
		event_gateway: "invalidate",
		scheduler: "revoke",
		secret_broker: "revoke",
		tool_registry: "invalidate",
		mcp_adapter: "invalidate",
		provider_registry: "invalidate",
	},
};

export const PLUGIN_LIFECYCLE_REVOKE_ACTIONS = ACTIONS_BY_KIND;

interface PendingLifecycleEvent {
	fingerprint: string;
	promise: Promise<PluginLifecycleRevokeReport>;
}

interface NormalizedLifecycleEvent extends PluginLifecycleRevokeEvent {
	kind: PluginLifecycleRevokeEventKind;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertText(value: unknown, label: string, maxLength: number): asserts value is string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > maxLength ||
		/[\0\r\n]/u.test(value)
	) {
		throw new TypeError(`Invalid lifecycle revoke ${label}`);
	}
}

function normalizeKind(kind: unknown): PluginLifecycleRevokeEventKind {
	assertText(kind, "kind", 64);
	const normalized = kind.replaceAll("-", "_");
	if (!(PLUGIN_LIFECYCLE_REVOKE_EVENT_KINDS as readonly string[]).includes(normalized)) {
		throw new TypeError(`Unsupported plugin lifecycle revoke event: ${kind}`);
	}
	return normalized as PluginLifecycleRevokeEventKind;
}

function normalizeEvent(input: PluginLifecycleRevokeEvent): NormalizedLifecycleEvent {
	if (!isRecord(input)) throw new TypeError("Plugin lifecycle revoke event is required");
	assertText(input.eventId, "eventId", 256);
	assertText(input.pluginId, "pluginId", 256);
	const kind = normalizeKind(input.kind);
	if (input.runtimeId !== undefined) assertText(input.runtimeId, "runtimeId", 256);
	if (
		input.runtimeGeneration !== undefined &&
		(!Number.isSafeInteger(input.runtimeGeneration) || input.runtimeGeneration < 0)
	) {
		throw new TypeError("Invalid lifecycle revoke runtimeGeneration");
	}
	if (
		input.grantRevision !== undefined &&
		(!Number.isSafeInteger(input.grantRevision) || input.grantRevision < 0)
	) {
		throw new TypeError("Invalid lifecycle revoke grantRevision");
	}
	if (input.reason !== undefined) assertText(input.reason, "reason", 512);
	if (input.metadata !== undefined) {
		if (!isRecord(input.metadata)) throw new TypeError("Invalid lifecycle revoke metadata");
		for (const value of Object.values(input.metadata)) {
			if (!isJsonValue(value)) throw new TypeError("Invalid lifecycle revoke metadata value");
		}
	}
	const metadata =
		input.metadata === undefined
			? undefined
			: structuredClone(input.metadata as Record<string, JsonValue>);
	return Object.freeze({
		eventId: input.eventId,
		pluginId: input.pluginId,
		kind,
		...(input.runtimeId === undefined ? {} : { runtimeId: input.runtimeId }),
		...(input.runtimeGeneration === undefined
			? {}
			: { runtimeGeneration: input.runtimeGeneration }),
		...(input.grantRevision === undefined ? {} : { grantRevision: input.grantRevision }),
		...(input.reason === undefined ? {} : { reason: input.reason }),
		...(metadata === undefined ? {} : { metadata }),
	});
}

function isJsonValue(value: unknown, seen = new Set<unknown>()): value is JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (typeof value !== "object" || seen.has(value)) return false;
	seen.add(value);
	if (Array.isArray(value)) return value.every((child) => isJsonValue(child, seen));
	return Object.entries(value).every(([key, child]) => {
		if (key === "__proto__" || key === "prototype" || key === "constructor") return false;
		return isJsonValue(child, seen);
	});
}

function fingerprint(event: NormalizedLifecycleEvent): string {
	return JSON.stringify([
		event.pluginId,
		event.kind,
		event.runtimeId ?? null,
		event.runtimeGeneration ?? null,
		event.grantRevision ?? null,
		event.reason ?? null,
		event.metadata ?? null,
	]);
}

function safeErrorCode(error: unknown): string | undefined {
	if (!isRecord(error) || error.code === undefined) return undefined;
	const code = String(error.code);
	return code.length > 128 ? code.slice(0, 128) : code;
}

function failureFromError(
	layer: PluginLifecycleRevokeLayer,
	action: PluginLifecycleRevokeAction,
	error: unknown,
): PluginLifecycleRevokeFailure {
	const name = error instanceof Error && error.name ? error.name : "Error";
	const message = error instanceof Error ? error.message : String(error);
	return {
		layer,
		action,
		name: name.slice(0, 128),
		message: message.slice(0, 1_000),
		...(safeErrorCode(error) ? { code: safeErrorCode(error) } : {}),
	};
}

function cloneReport(
	report: PluginLifecycleRevokeReport,
	deduplicated: boolean,
): PluginLifecycleRevokeReport {
	return {
		...report,
		deduplicated,
		steps: report.steps.map((step) => ({
			...step,
			error: step.error ? { ...step.error } : undefined,
		})),
		errors: report.errors.map((error) => ({ ...error })),
	};
}

function notAttemptedStep(
	layer: PluginLifecycleRevokeLayer,
	action: PluginLifecycleRevokeAction,
): PluginLifecycleRevokeStepReport {
	return {
		layer,
		action,
		status: "not_attempted",
		error: {
			layer,
			action,
			name: "PluginLifecycleRevokeNotAttemptedError",
			message: "Step was not attempted because continueOnError is disabled",
			code: "NOT_ATTEMPTED",
		},
	};
}

/**
 * Host-owned lifecycle revocation fence. Every event is processed once, in a fixed order, and
 * every failed step is retained in the report. Missing adapters are failures, not silent no-ops.
 */
export class PluginLifecycleRevokeCoordinator {
	private readonly adapters: PluginLifecycleRevokeAdapters;
	private readonly continueOnError: boolean;
	private readonly logger?: PluginLifecycleRevokeLogger;
	private readonly now: () => Date;
	private readonly maxHistory: number;
	private readonly completed = new Map<
		string,
		{ fingerprint: string; report: PluginLifecycleRevokeReport }
	>();
	private readonly pending = new Map<string, PendingLifecycleEvent>();

	constructor(options: PluginLifecycleRevokeCoordinatorOptions) {
		this.adapters = options.adapters;
		this.continueOnError = options.continueOnError ?? true;
		this.logger = options.logger;
		this.now = options.now ?? (() => new Date());
		this.maxHistory = Math.max(1, Math.floor(options.maxHistory ?? Number.POSITIVE_INFINITY));
	}

	async revoke(event: PluginLifecycleRevokeEvent): Promise<PluginLifecycleRevokeReport> {
		const report = await this.revokeWithReport(event);
		if (report.errors.length > 0) throw new PluginLifecycleRevokeError(report);
		return report;
	}

	/** Process and return the complete report without throwing on adapter failures. */
	async revokeWithReport(event: PluginLifecycleRevokeEvent): Promise<PluginLifecycleRevokeReport> {
		const normalized = normalizeEvent(event);
		const eventFingerprint = fingerprint(normalized);
		const existing = this.completed.get(normalized.eventId);
		if (existing) {
			if (existing.fingerprint !== eventFingerprint) {
				throw new PluginLifecycleRevokeConflictError(normalized.eventId);
			}
			return cloneReport(existing.report, true);
		}
		const pending = this.pending.get(normalized.eventId);
		if (pending) {
			if (pending.fingerprint !== eventFingerprint) {
				throw new PluginLifecycleRevokeConflictError(normalized.eventId);
			}
			return cloneReport(await pending.promise, true);
		}

		const promise = Promise.resolve().then(() => this.run(normalized));
		this.pending.set(normalized.eventId, { fingerprint: eventFingerprint, promise });
		try {
			const report = await promise;
			this.completed.set(normalized.eventId, { fingerprint: eventFingerprint, report });
			this.trimHistory();
			return cloneReport(report, false);
		} finally {
			const current = this.pending.get(normalized.eventId);
			if (current?.promise === promise) this.pending.delete(normalized.eventId);
		}
	}

	getReport(eventId: string): PluginLifecycleRevokeReport | undefined {
		const entry = this.completed.get(eventId);
		return entry ? cloneReport(entry.report, false) : undefined;
	}

	listReports(pluginId?: string): PluginLifecycleRevokeReport[] {
		return [...this.completed.values()]
			.map(({ report }) => report)
			.filter((report) => pluginId === undefined || report.pluginId === pluginId)
			.map((report) => cloneReport(report, false));
	}

	clearReports(): void {
		this.completed.clear();
	}

	private async run(event: NormalizedLifecycleEvent): Promise<PluginLifecycleRevokeReport> {
		const startedAt = this.now().toISOString();
		const actions = ACTIONS_BY_KIND[event.kind];
		const steps: PluginLifecycleRevokeStepReport[] = [];
		const errors: PluginLifecycleRevokeFailure[] = [];

		for (const [stepIndex, layer] of PLUGIN_LIFECYCLE_REVOKE_LAYERS.entries()) {
			const action = actions[layer];
			const adapter = this.adapters[layer];
			if (!adapter) {
				const error = failureFromError(
					layer,
					action,
					Object.assign(new Error(`No ${layer} lifecycle revoke adapter is configured`), {
						code: "ADAPTER_MISSING",
					}),
				);
				steps.push({ layer, action, status: "failed", error });
				errors.push(error);
			} else {
				try {
					await adapter({ event, layer, action, stepIndex });
					steps.push({ layer, action, status: "succeeded" });
				} catch (error) {
					const failure = failureFromError(layer, action, error);
					steps.push({ layer, action, status: "failed", error: failure });
					errors.push(failure);
				}
			}
			if (errors.length > 0 && !this.continueOnError) {
				for (const remainingLayer of PLUGIN_LIFECYCLE_REVOKE_LAYERS.slice(stepIndex + 1)) {
					const remainingAction = actions[remainingLayer];
					const notAttempted = notAttemptedStep(remainingLayer, remainingAction);
					steps.push(notAttempted);
					if (notAttempted.error) errors.push(notAttempted.error);
				}
				break;
			}
		}

		const completedAt = this.now().toISOString();
		const report: PluginLifecycleRevokeReport = {
			eventId: event.eventId,
			pluginId: event.pluginId,
			kind: event.kind,
			status: errors.length === 0 ? "succeeded" : "failed",
			deduplicated: false,
			startedAt,
			completedAt,
			steps,
			errors,
		};
		if (errors.length > 0) await this.logFailure(event, errors);
		return report;
	}

	private async logFailure(
		event: NormalizedLifecycleEvent,
		errors: readonly PluginLifecycleRevokeFailure[],
	): Promise<void> {
		try {
			await this.logger?.error?.("Plugin lifecycle revocation completed with errors", {
				event,
				errors,
			});
		} catch {
			// The in-memory report is authoritative; a broken logger must not hide adapter failures.
		}
	}

	private trimHistory(): void {
		while (this.completed.size > this.maxHistory) {
			const oldest = this.completed.keys().next().value as string | undefined;
			if (!oldest) return;
			this.completed.delete(oldest);
		}
	}
}
