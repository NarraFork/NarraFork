import { generateShortId } from "@server/lib/id";
import {
	contributionIdSchema,
	getContributionFullId,
	pluginIdSchema,
} from "@server/lib/plugins/manifest";
import { type InvocationScope, invocationScopeSchema } from "@server/lib/plugins/permissions";
import {
	type JsonValue,
	jsonValueSchema,
	type PublicEvent,
	publicEventSchema,
} from "@server/lib/plugins/protocol";
import { z } from "zod";
import {
	type AuthorizationResult,
	type CapabilityAuthorizationRequest,
	type HostCallContext,
	type InvocationPrincipal,
	type PluginPrincipal,
	pluginPrincipalSchema,
} from "./plugin-capability-broker";
import type { PluginPublicApi } from "./plugin-public-api";

const SCHEDULE_SCHEMA = "narrafork.plugin-schedule" as const;
const SCHEDULE_SCHEMA_VERSION = 1 as const;
const DEFAULT_MAX_SCHEDULES = 1_000;
const DEFAULT_MAX_SCHEDULES_PER_PLUGIN = 20;
const DEFAULT_MIN_INTERVAL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024;
const DEFAULT_MAX_RUN_RECORDS = 1_000;
const MAX_TIMER_DELAY_MS = 2_147_000_000;
const CRON_SEARCH_MINUTES = 366 * 24 * 60 * 2;

export type PluginScheduleKind = "cron" | "interval" | "once";
export type PluginScheduleStatus =
	| "active"
	| "running"
	| "completed"
	| "cancelled"
	| "disabled"
	| "revoked";

export type PluginScheduleSpec =
	| { kind: "interval"; intervalMs: number }
	| { kind: "once"; runAt: string }
	| { kind: "cron"; expression: string };

export interface PersistedPluginScheduleDefinition {
	schema: typeof SCHEDULE_SCHEMA;
	schemaVersion: typeof SCHEDULE_SCHEMA_VERSION;
	pluginId: string;
	contributionId: string;
	schedule: PluginScheduleSpec;
	payload?: JsonValue;
	scope?: InvocationScope;
	timeoutMs?: number;
	enabled: boolean;
}

export interface PluginScheduleRegistration {
	pluginId?: string;
	contributionId: string;
	plugin?: PluginPrincipal;
	principal?: PluginPrincipal;
	schedule?: PluginScheduleSpec;
	kind?: PluginScheduleKind;
	type?: PluginScheduleKind;
	intervalMs?: number;
	everyMs?: number;
	runAt?: string | Date;
	at?: string | Date;
	cron?: string;
	expression?: string;
	payload?: JsonValue;
	scope?: InvocationScope;
	timeoutMs?: number;
	enabled?: boolean;
	handler?: PluginScheduleHandler;
}

export interface PluginScheduleDescriptor extends PersistedPluginScheduleDefinition {
	fullId: string;
	status: PluginScheduleStatus;
	running: boolean;
	nextRunAt?: string;
	lastRunAt?: string;
	lastOutcome?: PluginScheduleRunOutcome;
	stopReason?: string;
}

export type PluginScheduleRunOutcome =
	| "succeeded"
	| "failed"
	| "timeout"
	| "cancelled"
	| "denied"
	| "skipped_overlap";

export interface PluginScheduleRunRecord {
	runId: string;
	pluginId: string;
	contributionId: string;
	fullId: string;
	triggeredAt: string;
	startedAt?: string;
	completedAt: string;
	outcome: PluginScheduleRunOutcome;
	durationMs: number;
	requestId?: string;
	correlationId?: string;
	errorCode?: string;
}

export interface PluginScheduleHandlerContext {
	runId: string;
	fullId: string;
	pluginId: string;
	contributionId: string;
	context: HostCallContext;
	principal: InvocationPrincipal;
	scope: InvocationScope;
	signal: AbortSignal;
	triggeredAt: string;
	publicApi?: PluginPublicApi;
}

export type PluginScheduleHandler = (
	payload: JsonValue | undefined,
	context: PluginScheduleHandlerContext,
) => unknown | Promise<unknown>;

export interface PluginScheduleRuntime {
	request(
		method: string,
		params?: unknown,
		options?: { signal?: AbortSignal; timeoutMs?: number },
	): Promise<unknown>;
}

export interface PluginSchedulerCapabilityBroker {
	authorize(
		request: CapabilityAuthorizationRequest,
	): Promise<
		AuthorizationResult | { allowed: boolean; error?: { code?: string; reason?: string } }
	>;
	withCallContext?(input: {
		plugin: PluginPrincipal;
		invocation: InvocationPrincipal;
		scope?: InvocationScope;
		requestId?: string;
		correlationId?: string;
		deadlineAt?: string;
	}): HostCallContext;
}

export interface PluginSchedulerAuditEntry {
	pluginId: string;
	contributionId: string;
	fullId: string;
	runId: string;
	requestId?: string;
	correlationId?: string;
	principalKind: "plugin_background";
	outcome: PluginScheduleRunOutcome;
	durationMs: number;
	requestBytes: number;
	errorCode?: string;
}

export interface PluginSchedulerOptions {
	capabilityBroker: PluginSchedulerCapabilityBroker;
	resolvePrincipal?: (
		pluginId: string,
		contributionId: string,
	) => PluginPrincipal | undefined | Promise<PluginPrincipal | undefined>;
	resolveRuntime?: (
		pluginId: string,
		contributionId: string,
	) => PluginScheduleRuntime | undefined | Promise<PluginScheduleRuntime | undefined>;
	handler?: PluginScheduleHandler;
	publicApi?: PluginPublicApi;
	publishEvent?: (event: PublicEvent) => void | Promise<void>;
	auditSink?:
		| ((entry: PluginSchedulerAuditEntry) => void | Promise<void>)
		| { write(entry: PluginSchedulerAuditEntry): void | Promise<void> };
	maxSchedules?: number;
	maxSchedulesPerPlugin?: number;
	minIntervalMs?: number;
	defaultTimeoutMs?: number;
	maxTimeoutMs?: number;
	maxPayloadBytes?: number;
	maxRunRecords?: number;
	runtimeMethod?: string;
	now?: () => Date;
}

export class PluginSchedulerError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "PluginSchedulerError";
		this.code = code;
	}
}

interface ScheduleTask {
	definition: PersistedPluginScheduleDefinition;
	fullId: string;
	principal?: PluginPrincipal;
	handler?: PluginScheduleHandler;
	status: PluginScheduleStatus;
	running: boolean;
	timer?: ReturnType<typeof setTimeout>;
	controller?: AbortController;
	nextRunAt?: number;
	lastRunAt?: string;
	lastOutcome?: PluginScheduleRunOutcome;
	stopReason?: string;
}

interface CronField {
	wildcard: boolean;
	values: Set<number>;
}

interface ParsedCron {
	minute: CronField;
	hour: CronField;
	dayOfMonth: CronField;
	month: CronField;
	dayOfWeek: CronField;
}

const persistedScheduleSchema = z
	.object({
		schema: z.literal(SCHEDULE_SCHEMA),
		schemaVersion: z.literal(SCHEDULE_SCHEMA_VERSION),
		pluginId: pluginIdSchema,
		contributionId: contributionIdSchema,
		schedule: z.discriminatedUnion("kind", [
			z.object({ kind: z.literal("interval"), intervalMs: z.number().int().positive() }).strict(),
			z.object({ kind: z.literal("once"), runAt: z.string().datetime({ offset: true }) }).strict(),
			z.object({ kind: z.literal("cron"), expression: z.string().trim().min(1).max(128) }).strict(),
		]),
		payload: jsonValueSchema.optional(),
		scope: invocationScopeSchema.optional(),
		timeoutMs: z.number().int().positive().optional(),
		enabled: z.boolean(),
	})
	.strict();

function jsonBytes(value: unknown): number {
	try {
		return Buffer.byteLength(JSON.stringify(value), "utf8");
	} catch {
		throw new PluginSchedulerError("INVALID_PARAMS", "Schedule payload must be restricted JSON");
	}
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

function safeErrorCode(error: unknown): string {
	if (error instanceof PluginSchedulerError) return error.code;
	if (error && typeof error === "object" && "code" in error) return String(error.code);
	if (error instanceof DOMException && error.name === "AbortError") return "CANCELLED";
	return "INTERNAL_ERROR";
}

function abortError(reason?: unknown): DOMException {
	return new DOMException(
		typeof reason === "string" ? reason : "Operation cancelled",
		"AbortError",
	);
}

function normalizeSchedule(input: PluginScheduleRegistration): PluginScheduleSpec {
	if (input.schedule) return clone(input.schedule);
	const kind = input.kind ?? input.type;
	if (kind === "interval") {
		return { kind, intervalMs: input.intervalMs ?? input.everyMs ?? 0 };
	}
	if (kind === "once") {
		const raw = input.runAt ?? input.at;
		return {
			kind,
			runAt: raw instanceof Date ? raw.toISOString() : String(raw ?? ""),
		};
	}
	if (kind === "cron") return { kind, expression: input.expression ?? input.cron ?? "" };
	throw new PluginSchedulerError("INVALID_PARAMS", "Schedule kind is required");
}

function normalizeRegistration(input: PluginScheduleRegistration): {
	definition: PersistedPluginScheduleDefinition;
	principal?: PluginPrincipal;
	handler?: PluginScheduleHandler;
} {
	const principal = input.principal ?? input.plugin;
	const pluginId = input.pluginId ?? principal?.pluginId;
	const candidate = {
		schema: SCHEDULE_SCHEMA,
		schemaVersion: SCHEDULE_SCHEMA_VERSION,
		pluginId,
		contributionId: input.contributionId,
		schedule: normalizeSchedule(input),
		payload: input.payload,
		scope: input.scope,
		timeoutMs: input.timeoutMs,
		enabled: input.enabled ?? true,
	};
	const parsed = persistedScheduleSchema.safeParse(candidate);
	if (!parsed.success) {
		throw new PluginSchedulerError(
			"INVALID_PARAMS",
			"Schedule definition failed strict validation",
		);
	}
	if (principal && principal.pluginId !== parsed.data.pluginId) {
		throw new PluginSchedulerError(
			"CONTEXT_UNAVAILABLE",
			"Schedule plugin identity is inconsistent",
		);
	}
	return { definition: parsed.data, principal, handler: input.handler };
}

function parseCronPart(part: string, min: number, max: number, sunday = false): CronField {
	const values = new Set<number>();
	const add = (value: number): void => {
		const normalized = sunday && value === 7 ? 0 : value;
		if (!Number.isInteger(value) || normalized < min || normalized > max) {
			throw new PluginSchedulerError("INVALID_PARAMS", "Cron field is outside its allowed range");
		}
		values.add(normalized);
	};
	const wildcard = part === "*";
	for (const segment of part.split(",")) {
		const [base, rawStep] = segment.split("/");
		if (segment.split("/").length > 2) {
			throw new PluginSchedulerError("INVALID_PARAMS", "Cron field contains an invalid step");
		}
		const step = rawStep === undefined ? 1 : Number(rawStep);
		if (!Number.isInteger(step) || step < 1 || step > max - min + 1) {
			throw new PluginSchedulerError("INVALID_PARAMS", "Cron step is invalid");
		}
		let start: number;
		let end: number;
		if (base === "*") {
			start = min;
			end = max;
		} else if (base.includes("-")) {
			const range = base.split("-");
			if (range.length !== 2) {
				throw new PluginSchedulerError("INVALID_PARAMS", "Cron range is invalid");
			}
			start = Number(range[0]);
			end = Number(range[1]);
			if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) {
				throw new PluginSchedulerError("INVALID_PARAMS", "Cron range is invalid");
			}
		} else {
			start = Number(base);
			end = rawStep === undefined ? start : max;
		}
		for (let value = start; value <= end; value += step) add(value);
	}
	if (values.size === 0) throw new PluginSchedulerError("INVALID_PARAMS", "Cron field is empty");
	return { wildcard, values };
}

function parseCron(expression: string): ParsedCron {
	const parts = expression.trim().split(/\s+/);
	if (parts.length !== 5) {
		throw new PluginSchedulerError("INVALID_PARAMS", "Cron expressions must contain five fields");
	}
	return {
		minute: parseCronPart(parts[0], 0, 59),
		hour: parseCronPart(parts[1], 0, 23),
		dayOfMonth: parseCronPart(parts[2], 1, 31),
		month: parseCronPart(parts[3], 1, 12),
		dayOfWeek: parseCronPart(parts[4], 0, 7, true),
	};
}

function cronMatches(cron: ParsedCron, date: Date): boolean {
	if (!cron.minute.values.has(date.getUTCMinutes())) return false;
	if (!cron.hour.values.has(date.getUTCHours())) return false;
	if (!cron.month.values.has(date.getUTCMonth() + 1)) return false;
	const dayOfMonth = cron.dayOfMonth.values.has(date.getUTCDate());
	const dayOfWeek = cron.dayOfWeek.values.has(date.getUTCDay());
	const dayMatches =
		cron.dayOfMonth.wildcard && cron.dayOfWeek.wildcard
			? true
			: cron.dayOfMonth.wildcard
				? dayOfWeek
				: cron.dayOfWeek.wildcard
					? dayOfMonth
					: dayOfMonth || dayOfWeek;
	return dayMatches;
}

function nextCronTime(cron: ParsedCron, afterMs: number): number {
	const candidate = new Date(afterMs);
	candidate.setUTCSeconds(0, 0);
	candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
	for (let index = 0; index < CRON_SEARCH_MINUTES; index += 1) {
		if (cronMatches(cron, candidate)) return candidate.getTime();
		candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
	}
	throw new PluginSchedulerError("INVALID_PARAMS", "Cron expression has no bounded next run");
}

function scheduleNextRun(schedule: PluginScheduleSpec, afterMs: number): number | undefined {
	if (schedule.kind === "interval") return afterMs + schedule.intervalMs;
	if (schedule.kind === "once") return Date.parse(schedule.runAt);
	return nextCronTime(parseCron(schedule.expression), afterMs);
}

function outcomeFromError(error: unknown, signal: AbortSignal): PluginScheduleRunOutcome {
	if (safeErrorCode(error) === "TIMEOUT" || safeErrorCode(error) === "RPC_TIMEOUT")
		return "timeout";
	if (signal.aborted || (error instanceof DOMException && error.name === "AbortError"))
		return "cancelled";
	return "failed";
}

export class PluginScheduler {
	private readonly capabilityBroker: PluginSchedulerCapabilityBroker;
	private readonly resolvePrincipal?: PluginSchedulerOptions["resolvePrincipal"];
	private readonly resolveRuntime?: PluginSchedulerOptions["resolveRuntime"];
	private readonly defaultHandler?: PluginScheduleHandler;
	private readonly publicApi?: PluginPublicApi;
	private readonly publishEvent?: PluginSchedulerOptions["publishEvent"];
	private readonly auditSink?: PluginSchedulerOptions["auditSink"];
	private readonly maxSchedules: number;
	private readonly maxSchedulesPerPlugin: number;
	private readonly minIntervalMs: number;
	private readonly defaultTimeoutMs: number;
	private readonly maxTimeoutMs: number;
	private readonly maxPayloadBytes: number;
	private readonly maxRunRecords: number;
	private readonly runtimeMethod: string;
	private readonly now: () => Date;
	private readonly tasks = new Map<string, ScheduleTask>();
	private readonly runRecords: PluginScheduleRunRecord[] = [];
	private closed = false;

	constructor(options: PluginSchedulerOptions) {
		this.capabilityBroker = options.capabilityBroker;
		this.resolvePrincipal = options.resolvePrincipal;
		this.resolveRuntime = options.resolveRuntime;
		this.defaultHandler = options.handler;
		this.publicApi = options.publicApi;
		this.publishEvent = options.publishEvent;
		this.auditSink = options.auditSink;
		this.maxSchedules = Math.max(1, Math.floor(options.maxSchedules ?? DEFAULT_MAX_SCHEDULES));
		this.maxSchedulesPerPlugin = Math.max(
			1,
			Math.floor(options.maxSchedulesPerPlugin ?? DEFAULT_MAX_SCHEDULES_PER_PLUGIN),
		);
		this.minIntervalMs = Math.max(1, Math.floor(options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS));
		this.maxTimeoutMs = Math.max(1, Math.floor(options.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS));
		this.defaultTimeoutMs = Math.min(
			this.maxTimeoutMs,
			Math.max(1, Math.floor(options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS)),
		);
		this.maxPayloadBytes = Math.max(
			1,
			Math.floor(options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES),
		);
		this.maxRunRecords = Math.max(1, Math.floor(options.maxRunRecords ?? DEFAULT_MAX_RUN_RECORDS));
		this.runtimeMethod = options.runtimeMethod ?? "schedule.run";
		this.now = options.now ?? (() => new Date());
	}

	register(
		input: PluginScheduleRegistration,
		handler?: PluginScheduleHandler,
	): PluginScheduleDescriptor {
		if (this.closed) throw new PluginSchedulerError("HOST_UNAVAILABLE", "Scheduler is closed");
		const normalized = normalizeRegistration(input);
		const definition = normalized.definition;
		const fullId = getContributionFullId(definition.pluginId, definition.contributionId);
		if (this.tasks.has(fullId)) {
			throw new PluginSchedulerError("CONFLICT", `Schedule is already registered: ${fullId}`);
		}
		if (this.tasks.size >= this.maxSchedules) {
			throw new PluginSchedulerError("RATE_LIMITED", "Host schedule quota is exhausted");
		}
		const pluginCount = [...this.tasks.values()].filter(
			(task) => task.definition.pluginId === definition.pluginId,
		).length;
		if (pluginCount >= this.maxSchedulesPerPlugin) {
			throw new PluginSchedulerError("RATE_LIMITED", "Plugin schedule quota is exhausted");
		}
		this.validateDefinition(definition);
		const task: ScheduleTask = {
			definition: clone(definition),
			fullId,
			principal: normalized.principal,
			handler: handler ?? normalized.handler,
			status: definition.enabled ? "active" : "disabled",
			running: false,
		};
		this.tasks.set(fullId, task);
		if (definition.enabled) this.arm(task, this.initialRunAt(task));
		return this.describe(task);
	}

	schedule(
		input: PluginScheduleRegistration,
		handler?: PluginScheduleHandler,
	): PluginScheduleDescriptor {
		return this.register(input, handler);
	}

	async restore(
		definitions: readonly PersistedPluginScheduleDefinition[],
		handler?: PluginScheduleHandler,
	): Promise<PluginScheduleDescriptor[]> {
		const restored: PluginScheduleDescriptor[] = [];
		for (const raw of definitions) {
			const parsed = persistedScheduleSchema.safeParse(raw);
			if (!parsed.success) {
				throw new PluginSchedulerError("INVALID_PARAMS", "Persisted schedule is invalid");
			}
			restored.push(
				this.register(
					{
						pluginId: parsed.data.pluginId,
						contributionId: parsed.data.contributionId,
						schedule: parsed.data.schedule,
						payload: parsed.data.payload,
						scope: parsed.data.scope,
						timeoutMs: parsed.data.timeoutMs,
						enabled: parsed.data.enabled,
					},
					handler,
				),
			);
		}
		return restored;
	}

	recover(
		definitions: readonly PersistedPluginScheduleDefinition[],
		handler?: PluginScheduleHandler,
	): Promise<PluginScheduleDescriptor[]> {
		return this.restore(definitions, handler);
	}

	exportDefinitions(): PersistedPluginScheduleDefinition[] {
		return [...this.tasks.values()]
			.map((task) => clone(task.definition))
			.sort((left, right) =>
				getContributionFullId(left.pluginId, left.contributionId).localeCompare(
					getContributionFullId(right.pluginId, right.contributionId),
				),
			);
	}

	serialize(): PersistedPluginScheduleDefinition[] {
		return this.exportDefinitions();
	}

	get(fullId: string): PluginScheduleDescriptor | undefined {
		const task = this.tasks.get(fullId);
		return task ? this.describe(task) : undefined;
	}

	list(pluginId?: string): PluginScheduleDescriptor[] {
		return [...this.tasks.values()]
			.filter((task) => !pluginId || task.definition.pluginId === pluginId)
			.map((task) => this.describe(task))
			.sort((left, right) => left.fullId.localeCompare(right.fullId));
	}

	listRunRecords(fullId?: string): PluginScheduleRunRecord[] {
		return this.runRecords
			.filter((record) => !fullId || record.fullId === fullId)
			.map((record) => ({ ...record }));
	}

	async triggerNow(fullId: string): Promise<PluginScheduleRunRecord> {
		const task = this.requireTask(fullId);
		return this.execute(task, this.now().getTime());
	}

	cancel(fullId: string, reason = "cancelled"): boolean {
		const task = this.tasks.get(fullId);
		if (!task) return false;
		this.stopTask(task, "cancelled", reason);
		return true;
	}

	remove(fullId: string, reason = "removed"): boolean {
		const task = this.tasks.get(fullId);
		if (!task) return false;
		this.stopTask(task, "cancelled", reason);
		this.tasks.delete(fullId);
		return true;
	}

	disablePlugin(pluginId: string, reason = "plugin-disabled"): number {
		return this.stopPlugin(pluginId, "disabled", reason);
	}

	revokePlugin(pluginId: string, reason = "grant-revoked"): number {
		return this.stopPlugin(pluginId, "revoked", reason);
	}

	revoke(pluginId: string, reason = "grant-revoked"): number {
		return this.revokePlugin(pluginId, reason);
	}

	enable(fullId: string): PluginScheduleDescriptor {
		const task = this.requireTask(fullId);
		if (task.status === "active" || task.status === "running") return this.describe(task);
		task.definition.enabled = true;
		task.status = "active";
		task.stopReason = undefined;
		this.arm(task, this.initialRunAt(task));
		return this.describe(task);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const task of this.tasks.values()) this.stopTask(task, "cancelled", "scheduler-closed");
	}

	private validateDefinition(definition: PersistedPluginScheduleDefinition): void {
		if (definition.payload !== undefined) {
			if (!jsonValueSchema.safeParse(definition.payload).success) {
				throw new PluginSchedulerError(
					"INVALID_PARAMS",
					"Schedule payload must be restricted JSON",
				);
			}
			if (jsonBytes(definition.payload) > this.maxPayloadBytes) {
				throw new PluginSchedulerError("PAYLOAD_TOO_LARGE", "Schedule payload exceeds byte limit");
			}
		}
		if (definition.timeoutMs !== undefined && definition.timeoutMs > this.maxTimeoutMs) {
			throw new PluginSchedulerError("INVALID_PARAMS", "Schedule timeout exceeds host limit");
		}
		if (definition.schedule.kind === "interval") {
			if (definition.schedule.intervalMs < this.minIntervalMs) {
				throw new PluginSchedulerError(
					"RATE_LIMITED",
					"Schedule interval is below the host minimum",
				);
			}
			return;
		}
		if (definition.schedule.kind === "once") {
			if (!Number.isFinite(Date.parse(definition.schedule.runAt))) {
				throw new PluginSchedulerError("INVALID_PARAMS", "One-time schedule date is invalid");
			}
			return;
		}
		const cron = parseCron(definition.schedule.expression);
		const first = nextCronTime(cron, this.now().getTime());
		const second = nextCronTime(cron, first);
		if (second - first < this.minIntervalMs) {
			throw new PluginSchedulerError("RATE_LIMITED", "Cron frequency is below the host minimum");
		}
	}

	private initialRunAt(task: ScheduleTask): number {
		const current = this.now().getTime();
		if (task.definition.schedule.kind === "once") {
			return Math.max(current, Date.parse(task.definition.schedule.runAt));
		}
		return scheduleNextRun(task.definition.schedule, current) ?? current;
	}

	private arm(task: ScheduleTask, runAt: number | undefined): void {
		if (
			this.closed ||
			runAt === undefined ||
			!task.definition.enabled ||
			(task.status !== "active" && task.status !== "running")
		)
			return;
		if (task.timer) clearTimeout(task.timer);
		task.nextRunAt = runAt;
		const delay = Math.max(0, runAt - this.now().getTime());
		task.timer = setTimeout(
			() => {
				task.timer = undefined;
				if (delay > MAX_TIMER_DELAY_MS) {
					this.arm(task, runAt);
					return;
				}
				this.onDue(task, runAt);
			},
			Math.min(delay, MAX_TIMER_DELAY_MS),
		);
	}

	private onDue(task: ScheduleTask, scheduledAt: number): void {
		if (!task.definition.enabled || task.status === "cancelled" || task.status === "disabled")
			return;
		if (task.definition.schedule.kind === "interval") {
			this.arm(task, scheduledAt + task.definition.schedule.intervalMs);
		} else if (task.definition.schedule.kind === "cron") {
			this.arm(task, nextCronTime(parseCron(task.definition.schedule.expression), scheduledAt));
		} else {
			task.nextRunAt = undefined;
		}
		void this.execute(task, scheduledAt);
	}

	private async execute(
		task: ScheduleTask,
		triggeredAtMs: number,
	): Promise<PluginScheduleRunRecord> {
		const triggeredAt = new Date(triggeredAtMs).toISOString();
		if (task.running) {
			return this.recordRun(task, {
				runId: `schedule_run_${generateShortId(16)}`,
				triggeredAt,
				completedAt: this.now().toISOString(),
				outcome: "skipped_overlap",
				durationMs: 0,
			});
		}
		if (!task.definition.enabled || !["active", "running"].includes(task.status)) {
			throw new PluginSchedulerError("PLUGIN_DISABLED", "Schedule is not active");
		}

		const runId = `schedule_run_${generateShortId(16)}`;
		const startedAtMs = this.now().getTime();
		const startedAt = new Date(startedAtMs).toISOString();
		const timeoutMs = Math.min(
			task.definition.timeoutMs ?? this.defaultTimeoutMs,
			this.maxTimeoutMs,
		);
		const controller = new AbortController();
		task.running = true;
		task.status = "running";
		task.controller = controller;
		task.lastRunAt = startedAt;
		let context: HostCallContext | undefined;
		let outcome: PluginScheduleRunOutcome = "failed";
		let errorCode: string | undefined;
		try {
			const principal = await this.principalFor(task);
			const invocation: InvocationPrincipal = { kind: "plugin_background", source: "schedule" };
			const deadlineAt = new Date(startedAtMs + timeoutMs).toISOString();
			context = this.createContext(principal, invocation, task.definition.scope ?? {}, deadlineAt);
			const requestBytes = jsonBytes(task.definition.payload ?? null);
			const authorization = await this.capabilityBroker.authorize({
				context,
				capability: "schedule.register",
				methodId: `schedule:${task.fullId}`,
				scope: task.definition.scope ?? {},
				constraints: { maxBytes: requestBytes },
				requestBytes,
				responseBytes: 0,
			});
			if (!authorization.allowed) {
				outcome = "denied";
				errorCode = authorization.error?.code ?? "PERMISSION_DENIED";
				this.stopTask(task, "revoked", authorization.error?.reason ?? "authorization-denied");
				throw new PluginSchedulerError(errorCode, "Schedule authorization was denied");
			}
			await this.emitLifecycle(task, runId, "started", triggeredAt, context);
			await this.runHandler(
				task,
				{
					runId,
					fullId: task.fullId,
					pluginId: task.definition.pluginId,
					contributionId: task.definition.contributionId,
					context,
					principal: invocation,
					scope: clone(task.definition.scope ?? {}),
					signal: controller.signal,
					triggeredAt,
					publicApi: this.publicApi,
				},
				timeoutMs,
				controller,
			);
			outcome = "succeeded";
		} catch (error) {
			if (outcome !== "denied") outcome = outcomeFromError(error, controller.signal);
			errorCode = errorCode ?? safeErrorCode(error);
		} finally {
			task.running = false;
			task.controller = undefined;
			task.lastOutcome = outcome;
			if (task.definition.schedule.kind === "once" && task.definition.enabled) {
				task.definition.enabled = false;
				task.status = outcome === "cancelled" ? "cancelled" : "completed";
			} else if (task.definition.enabled && task.status === "running") {
				task.status = "active";
			}
		}
		const completedAt = this.now().toISOString();
		const record = this.recordRun(task, {
			runId,
			triggeredAt,
			startedAt,
			completedAt,
			outcome,
			durationMs: Math.max(0, this.now().getTime() - startedAtMs),
			requestId: context?.requestId,
			correlationId: context?.correlationId,
			errorCode,
		});
		await this.emitLifecycle(task, runId, outcome, triggeredAt, context);
		await this.audit(record, task.definition.payload);
		return record;
	}

	private async runHandler(
		task: ScheduleTask,
		context: PluginScheduleHandlerContext,
		timeoutMs: number,
		controller: AbortController,
	): Promise<void> {
		const handler = task.handler ?? this.defaultHandler;
		const execution = handler
			? Promise.resolve(handler(clone(task.definition.payload), context))
			: this.runRuntime(task, context, timeoutMs);
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const timeoutPromise = new Promise<never>((_, reject) => {
			timeout = setTimeout(() => {
				reject(new PluginSchedulerError("TIMEOUT", "Schedule execution timed out"));
				controller.abort("schedule-timeout");
			}, timeoutMs);
		});
		const abortPromise = new Promise<never>((_, reject) => {
			if (controller.signal.aborted) {
				reject(abortError(controller.signal.reason));
				return;
			}
			controller.signal.addEventListener(
				"abort",
				() => reject(abortError(controller.signal.reason)),
				{ once: true },
			);
		});
		try {
			await Promise.race([execution, timeoutPromise, abortPromise]);
		} finally {
			if (timeout) clearTimeout(timeout);
		}
	}

	private async runRuntime(
		task: ScheduleTask,
		context: PluginScheduleHandlerContext,
		timeoutMs: number,
	): Promise<void> {
		const runtime = await this.resolveRuntime?.(
			task.definition.pluginId,
			task.definition.contributionId,
		);
		if (!runtime) {
			throw new PluginSchedulerError(
				"HOST_UNAVAILABLE",
				"No schedule handler or runtime is available",
			);
		}
		await runtime.request(
			this.runtimeMethod,
			{
				contributionId: task.definition.contributionId,
				payload: clone(task.definition.payload ?? null),
				trigger: {
					runId: context.runId,
					triggeredAt: context.triggeredAt,
					requestId: context.context.requestId,
					correlationId: context.context.correlationId,
					principal: { kind: "plugin_background", source: "schedule" },
					scope: clone(context.scope),
				},
			},
			{ signal: context.signal, timeoutMs },
		);
	}

	private async principalFor(task: ScheduleTask): Promise<PluginPrincipal> {
		const resolved = await this.resolvePrincipal?.(
			task.definition.pluginId,
			task.definition.contributionId,
		);
		const principal = resolved ?? task.principal;
		const parsed = pluginPrincipalSchema.safeParse(principal);
		if (!parsed.success || parsed.data.pluginId !== task.definition.pluginId) {
			throw new PluginSchedulerError(
				"CONTEXT_UNAVAILABLE",
				"Plugin runtime principal is unavailable",
			);
		}
		return { ...parsed.data };
	}

	private createContext(
		plugin: PluginPrincipal,
		invocation: InvocationPrincipal,
		scope: InvocationScope,
		deadlineAt: string,
	): HostCallContext {
		const requestId = `schedule_req_${generateShortId(16)}`;
		const correlationId = `schedule_corr_${generateShortId(16)}`;
		if (this.capabilityBroker.withCallContext) {
			return this.capabilityBroker.withCallContext({
				plugin,
				invocation,
				scope,
				requestId,
				correlationId,
				deadlineAt,
			});
		}
		return { requestId, correlationId, deadlineAt, plugin, invocation, scope: clone(scope) };
	}

	private recordRun(
		task: ScheduleTask,
		record: Omit<PluginScheduleRunRecord, "pluginId" | "contributionId" | "fullId">,
	): PluginScheduleRunRecord {
		const completed: PluginScheduleRunRecord = {
			pluginId: task.definition.pluginId,
			contributionId: task.definition.contributionId,
			fullId: task.fullId,
			...record,
		};
		task.lastOutcome = completed.outcome;
		this.runRecords.push(completed);
		if (this.runRecords.length > this.maxRunRecords) {
			this.runRecords.splice(0, this.runRecords.length - this.maxRunRecords);
		}
		return { ...completed };
	}

	private async emitLifecycle(
		task: ScheduleTask,
		runId: string,
		outcome: string,
		triggeredAt: string,
		context?: HostCallContext,
	): Promise<void> {
		if (!this.publishEvent) return;
		const event = publicEventSchema.parse({
			schema: "narrafork.public-event",
			schemaVersion: 1,
			eventId: `evt_${generateShortId(16)}`,
			topic: "narrafork.plugin.audit.summary",
			eventClass: "audit",
			occurredAt: this.now().toISOString(),
			resource: { type: "plugin", id: task.definition.pluginId },
			actor: { kind: "plugin", id: task.definition.pluginId },
			data: {
				pluginId: task.definition.pluginId,
				contributionId: task.definition.contributionId,
				operation: "schedule.run",
				outcome,
				runId,
				triggeredAt,
				...(context ? { correlationId: context.correlationId } : {}),
			},
			redaction: "admin_scoped",
		});
		try {
			await this.publishEvent(event);
		} catch {
			// Event delivery is observational and must not change schedule execution.
		}
	}

	private async audit(
		record: PluginScheduleRunRecord,
		payload: JsonValue | undefined,
	): Promise<void> {
		if (!this.auditSink) return;
		const entry: PluginSchedulerAuditEntry = {
			pluginId: record.pluginId,
			contributionId: record.contributionId,
			fullId: record.fullId,
			runId: record.runId,
			requestId: record.requestId,
			correlationId: record.correlationId,
			principalKind: "plugin_background",
			outcome: record.outcome,
			durationMs: record.durationMs,
			requestBytes: jsonBytes(payload ?? null),
			errorCode: record.errorCode,
		};
		try {
			if (typeof this.auditSink === "function") await this.auditSink(entry);
			else await this.auditSink.write(entry);
		} catch {
			// Audit storage failure must not alter the already determined run result.
		}
	}

	private stopPlugin(
		pluginId: string,
		status: Extract<PluginScheduleStatus, "disabled" | "revoked">,
		reason: string,
	): number {
		let stopped = 0;
		for (const task of this.tasks.values()) {
			if (task.definition.pluginId !== pluginId) continue;
			this.stopTask(task, status, reason);
			stopped += 1;
		}
		return stopped;
	}

	private stopTask(task: ScheduleTask, status: PluginScheduleStatus, reason: string): void {
		if (task.timer) clearTimeout(task.timer);
		task.timer = undefined;
		task.nextRunAt = undefined;
		task.definition.enabled = false;
		task.status = status;
		task.stopReason = reason.slice(0, 240);
		task.controller?.abort(reason);
	}

	private describe(task: ScheduleTask): PluginScheduleDescriptor {
		return {
			...clone(task.definition),
			fullId: task.fullId,
			status: task.status,
			running: task.running,
			nextRunAt: task.nextRunAt === undefined ? undefined : new Date(task.nextRunAt).toISOString(),
			lastRunAt: task.lastRunAt,
			lastOutcome: task.lastOutcome,
			stopReason: task.stopReason,
		};
	}

	private requireTask(fullId: string): ScheduleTask {
		const task = this.tasks.get(fullId);
		if (!task) throw new PluginSchedulerError("NOT_FOUND", `Unknown schedule: ${fullId}`);
		return task;
	}
}

export const pluginScheduleDefinitionSchema = persistedScheduleSchema;
