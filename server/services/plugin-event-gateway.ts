import { z } from "zod";
import { eventBus, type NarraForkEvent } from "../lib/event-bus";
import { hotOnce } from "../lib/hot-safe";
import { generateId, generateShortId } from "../lib/id";
import { type InvocationScope, invocationScopeSchema } from "../lib/plugins/permissions";
import {
	type JsonValue,
	jsonValueSchema,
	type PublicEvent,
	type PublicEventFilter,
	type PublicEventTopic,
	publicEventFilterSchema,
	publicEventSchema,
	publicEventTopicSchema,
} from "../lib/plugins/protocol";
import { type PluginHealthRegistry, pluginHealthRegistry } from "./plugin-health";

const MAX_DIAGNOSTICS = 128;
const MAX_TOPICS = 20;
const DEFAULT_QUEUE_EVENTS = 100;
const DEFAULT_QUEUE_BYTES = 256 * 1024;
const HARD_QUEUE_EVENTS = 1_000;
const HARD_QUEUE_BYTES = 2 * 1024 * 1024;
const DEFAULT_RATE_PER_SECOND = 100;
const HARD_RATE_PER_SECOND = 1_000;
const DEFAULT_MAX_SUBSCRIPTIONS = 256;
const HARD_MAX_SUBSCRIPTIONS = 2_048;
const DEFAULT_MAX_DISPATCHES_PER_SECOND = 2_000;
const HARD_MAX_DISPATCHES_PER_SECOND = 20_000;
const DEFAULT_MAX_CONCURRENT_DISPATCHES = 64;
const HARD_MAX_CONCURRENT_DISPATCHES = 512;
const MAX_EVENT_BYTES = 256 * 1024;
const CONTROL_QUEUE_EVENTS = 4;

const encoder = new TextEncoder();
const SENSITIVE_KEYS = new Set([
	"contentjson",
	"rawdump",
	"rawdumpjson",
	"toolinput",
	"tooloutput",
	"input",
	"output",
	"jwt",
	"bearer",
	"token",
	"secret",
	"password",
	"cookie",
	"authorization",
	"credential",
	"cwd",
	"worktreepath",
	"fullpath",
	"absolutepath",
	"log",
	"stderr",
	"stdout",
	"reasoning",
]);
const SENSITIVE_VALUE =
	/(?:jwt|bearer|access[_-]?token|refresh[_-]?token|secret|password|authorization)\s*[:=]/i;

function isSensitiveKey(key: string): boolean {
	return SENSITIVE_KEYS.has(key.replace(/[._-]/g, "").toLowerCase());
}

export type PluginEventBus = Pick<typeof eventBus, "onAny" | "offAny">;

export interface PluginPrincipal {
	pluginId: string;
	runtimeId?: string;
	generation?: number;
	sessionId?: string;
	contributionId?: string;
	packageVersion?: string;
}

export interface CapabilityAuthorizationRequest {
	phase: "subscribe" | "deliver";
	plugin: PluginPrincipal;
	capability: string;
	topic: PublicEventTopic;
	scope: InvocationScope;
	event?: PublicEvent;
}

export interface CapabilityAuthorizationDecision {
	allowed: boolean;
	/** A denied delivery revokes the subscription when the grant/session is no longer valid. */
	revoke?: boolean;
	reason?: string;
}

/** Injected boundary for the phase-2 capability broker. */
export interface PluginCapabilityBroker {
	authorize?(
		request: CapabilityAuthorizationRequest,
	): CapabilityAuthorizationDecision | boolean | Promise<CapabilityAuthorizationDecision | boolean>;
	/** Alias for hosts that expose the broker as a check rather than authorize method. */
	check?(
		request: CapabilityAuthorizationRequest,
	): CapabilityAuthorizationDecision | boolean | Promise<CapabilityAuthorizationDecision | boolean>;
	isRuntimeActive?(plugin: PluginPrincipal): boolean | Promise<boolean>;
	audit?(summary: PluginEventAuditSummary): void | Promise<void>;
	/** Alias for an audit sink-backed broker. */
	recordAudit?(summary: PluginEventAuditSummary): void | Promise<void>;
}

export interface PluginEventAuditSummary {
	pluginId: string;
	runtimeId?: string;
	generation?: number;
	subscriptionId?: string;
	methodId: "events.subscribe" | "events.unsubscribe" | "events.deliver";
	topic?: PublicEventTopic;
	capability?: string;
	outcome: "allowed" | "denied" | "succeeded" | "failed" | "overflow";
	durationMs?: number;
	requestBytes: number;
	responseBytes: number;
	redactedSummary?: Record<string, JsonValue>;
}

export interface PluginEventMappingContext {
	eventId: string;
	occurredAt: string;
}

export type PublicEventMapping = Partial<PublicEvent> &
	Pick<PublicEvent, "topic" | "eventClass" | "data" | "redaction">;

export type PluginEventMapper = (
	event: NarraForkEvent,
	context: PluginEventMappingContext,
) =>
	| PublicEventMapping
	| PublicEvent
	| null
	| undefined
	| Promise<PublicEventMapping | PublicEvent | null | undefined>;

export interface EventDeliveryOptions {
	maxRatePerSecond?: number;
	queueEvents?: number;
	queueBytes?: number;
	includeInitialState?: boolean;
}

export interface SubscribeEventsInput {
	pluginId?: string;
	plugin?: PluginPrincipal;
	principal?: PluginPrincipal;
	runtimeId?: string;
	generation?: number;
	sessionId?: string;
	contributionId?: string;
	packageVersion?: string;
	/** The invocation's already-authorized scope. Omitted means global scope. */
	invocationScope?: InvocationScope;
	topics: string[];
	filter?: PublicEventFilter;
	/** A requested scope can only remove/narrow constraints from invocationScope. */
	scope?: InvocationScope;
	mode?: "live" | "snapshot_live";
	snapshot?: { queryId: string; input: JsonValue };
	delivery?: EventDeliveryOptions;
	onEvent?: PluginEventDelivery;
	deliver?: PluginEventDelivery;
}

export type PluginEventDelivery = (event: PublicEvent) => void | Promise<void>;

export interface SubscribeEventsResult {
	subscriptionId: string;
	mode: "live" | "snapshot_live";
	delivery: {
		maxFrameBytes: number;
		queueEvents: number;
		queueBytes: number;
		maxRatePerSecond: number;
	};
	snapshotFence?: {
		resources: Array<{ type: string; id: string; version?: number }>;
	};
}

export interface PluginEventGatewayDiagnostic {
	code:
		| "UNKNOWN_INTERNAL_EVENT"
		| "MAPPER_FAILED"
		| "INVALID_PUBLIC_EVENT"
		| "SUBSCRIPTION_REVOKED"
		| "PERMISSION_DENIED"
		| "QUEUE_OVERFLOW"
		| "DELIVERY_FAILED"
		| "QUOTA_EXCEEDED"
		| "INVALID_SUBSCRIPTION";
	message: string;
	at: string;
	pluginId?: string;
	subscriptionId?: string;
	topic?: string;
	count?: number;
}

export interface PluginEventSubscriptionDiagnostics {
	subscriptionId: string;
	pluginId: string;
	runtimeId?: string;
	generation?: number;
	mode: "live" | "snapshot_live";
	status: "active" | "overflowed" | "revoked" | "cancelled";
	queueEvents: number;
	queueBytes: number;
	delivered: number;
	dropped: number;
	coalesced: number;
	lastDeliveryAt?: string;
}

interface QueueItem {
	event: PublicEvent;
	bytes: number;
	coalesceKey?: string;
	control: boolean;
}

interface Subscription {
	id: string;
	principal: PluginPrincipal;
	baseScope: InvocationScope;
	scope: InvocationScope;
	topics: Set<PublicEventTopic>;
	filter?: PublicEventFilter;
	mode: "live" | "snapshot_live";
	delivery: Required<Pick<EventDeliveryOptions, "maxRatePerSecond" | "queueEvents" | "queueBytes">>;
	onEvent?: PluginEventDelivery;
	queue: QueueItem[];
	controlQueue: QueueItem[];
	queueBytes: number;
	deliverySeq: number;
	nextDeliveryAt: number;
	pumpScheduled: boolean;
	pumpTimer?: ReturnType<typeof setTimeout>;
	status: PluginEventSubscriptionDiagnostics["status"];
	overflowNotified: boolean;
	delivered: number;
	dropped: number;
	coalesced: number;
	lastDeliveryAt?: string;
}

const subscribeSchema = z
	.object({
		pluginId: z.string().trim().min(1).max(128).optional(),
		runtimeId: z.string().trim().min(1).max(128).optional(),
		generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
		sessionId: z.string().trim().min(1).max(128).optional(),
		contributionId: z.string().trim().min(1).max(256).optional(),
		packageVersion: z.string().trim().min(1).max(128).optional(),
		invocationScope: invocationScopeSchema.optional(),
		currentScope: invocationScopeSchema.optional(),
		plugin: z
			.object({
				pluginId: z.string().trim().min(1).max(128),
				runtimeId: z.string().trim().min(1).max(128).optional(),
				generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
				sessionId: z.string().trim().min(1).max(128).optional(),
				contributionId: z.string().trim().min(1).max(256).optional(),
				packageVersion: z.string().trim().min(1).max(128).optional(),
			})
			.strict()
			.optional(),
		principal: z
			.object({
				pluginId: z.string().trim().min(1).max(128),
				runtimeId: z.string().trim().min(1).max(128).optional(),
				generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
				sessionId: z.string().trim().min(1).max(128).optional(),
				contributionId: z.string().trim().min(1).max(256).optional(),
				packageVersion: z.string().trim().min(1).max(128).optional(),
			})
			.strict()
			.optional(),
		topics: z

			.array(publicEventTopicSchema)
			.min(1)
			.max(MAX_TOPICS)
			.refine((topics) => new Set(topics).size === topics.length, "Topics must be unique"),
		filter: publicEventFilterSchema.optional(),
		scope: invocationScopeSchema.optional(),
		mode: z.enum(["live", "snapshot_live"]).default("live"),
		snapshot: z
			.object({ queryId: z.string().trim().min(1).max(128), input: jsonValueSchema })
			.strict()
			.optional(),
		delivery: z
			.object({
				maxRatePerSecond: z.number().finite().positive().max(HARD_RATE_PER_SECOND).optional(),
				queueEvents: z.number().int().positive().max(HARD_QUEUE_EVENTS).optional(),
				queueBytes: z.number().int().positive().max(HARD_QUEUE_BYTES).optional(),
				includeInitialState: z.boolean().optional(),
			})
			.strict()
			.optional(),
		onEvent: z.custom<PluginEventDelivery>().optional(),
		deliver: z.custom<PluginEventDelivery>().optional(),
	})
	.strict();

export interface PluginEventGatewayOptions {
	eventBus?: PluginEventBus;
	mapper?: PluginEventMapper;
	capabilityBroker?: PluginCapabilityBroker;
	healthRegistry?: PluginHealthRegistry;
	defaultQueueEvents?: number;
	defaultQueueBytes?: number;
	defaultRatePerSecond?: number;
	maxSubscriptions?: number;
	maxDispatchesPerSecond?: number;
	maxConcurrentDispatches?: number;
	registerListener?: boolean;
	hotReloadGuard?: boolean;
}

function asDecision(
	value: CapabilityAuthorizationDecision | boolean,
): CapabilityAuthorizationDecision {
	return typeof value === "boolean" ? { allowed: value } : value;
}

function capabilityForTopic(topic: PublicEventTopic): string {
	if (topic === "narrafork.narrator.permission.changed") return "event.subscribe.permission";
	if (topic.startsWith("narrafork.narrator.")) return "event.subscribe.narrator";
	if (topic.startsWith("narrafork.chapter.") || topic === "narrafork.review.lifecycle")
		return "event.subscribe.chapter";
	if (topic.startsWith("narrafork.provider.")) return "event.subscribe.provider";
	if (topic.startsWith("narrafork.plugin.")) return "event.subscribe.plugin";
	if (topic.startsWith("narrafork.device.")) return "event.subscribe.device";
	if (topic.startsWith("narrafork.project.")) return "event.subscribe.project";
	return "event.subscribe.public";
}

function valueAt(event: PublicEvent, key: string): unknown {
	if (key === "status") return event.data.status;
	if (key === "projectId") return event.resource?.projectId ?? event.data.projectId;
	if (key === "chapterId") return event.resource?.chapterId ?? event.data.chapterId;
	if (key === "narratorId") return event.resource?.narratorId ?? event.data.narratorId;
	return undefined;
}

function matchesFilter(event: PublicEvent, filter: PublicEventFilter | undefined): boolean {
	if (!filter) return true;
	if (filter.topic && !filter.topic.includes(event.topic)) return false;
	if (filter.eventClass && !filter.eventClass.includes(event.eventClass)) return false;
	if (
		filter.resourceTypes &&
		(!event.resource || !filter.resourceTypes.includes(event.resource.type))
	)
		return false;
	if (filter.projectIds && !filter.projectIds.includes(String(valueAt(event, "projectId"))))
		return false;
	if (filter.chapterIds && !filter.chapterIds.includes(String(valueAt(event, "chapterId"))))
		return false;
	if (filter.narratorIds && !filter.narratorIds.includes(String(valueAt(event, "narratorId"))))
		return false;
	if (filter.statuses && !filter.statuses.includes(String(valueAt(event, "status")))) return false;
	if (filter.actorKinds && (!event.actor || !filter.actorKinds.includes(event.actor.kind)))
		return false;
	if (filter.all && !filter.all.every((child) => matchesFilter(event, child))) return false;
	if (filter.any && !filter.any.some((child) => matchesFilter(event, child))) return false;
	return true;
}

function scopeValue(scope: InvocationScope, key: keyof InvocationScope): string | undefined {
	return scope[key];
}

const SCOPE_RANK: Record<keyof InvocationScope, number> = {
	userId: 1,
	projectId: 2,
	workspaceId: 2,
	chapterId: 3,
	providerInstanceId: 3,
	deviceId: 3,
	narratorId: 4,
};

function isScopeNarrower(base: InvocationScope, requested: InvocationScope): boolean {
	for (const key of Object.keys(base) as Array<keyof InvocationScope>) {
		const baseValue = scopeValue(base, key);
		if (baseValue === undefined) continue;
		const requestedValue = scopeValue(requested, key);
		if (requestedValue !== undefined) {
			if (requestedValue !== baseValue) return false;
			continue;
		}
		const requestedRanks = (Object.keys(requested) as Array<keyof InvocationScope>)
			.filter((requestedKey) => scopeValue(requested, requestedKey) !== undefined)
			.map((requestedKey) => SCOPE_RANK[requestedKey]);
		if (requestedRanks.length === 0 || !requestedRanks.some((rank) => rank > SCOPE_RANK[key]))
			return false;
	}
	return true;
}

function filterWithinScope(filter: PublicEventFilter | undefined, scope: InvocationScope): boolean {
	if (!filter) return true;
	const checks: Array<[keyof InvocationScope, string[] | undefined]> = [
		["projectId", filter.projectIds],
		["chapterId", filter.chapterIds],
		["narratorId", filter.narratorIds],
	];
	for (const [scopeKey, ids] of checks) {
		const scopedId = scopeValue(scope, scopeKey);
		if (scopedId && ids?.some((id) => id !== scopedId)) return false;
	}
	return (
		(!filter.all || filter.all.every((child) => filterWithinScope(child, scope))) &&
		(!filter.any || filter.any.every((child) => filterWithinScope(child, scope)))
	);
}

function eventScopeValue(event: PublicEvent, key: keyof InvocationScope): string | undefined {
	if (key === "userId") return event.actor?.id;
	if (key === "projectId") return event.resource?.projectId ?? asString(event.data.projectId);
	if (key === "chapterId") return event.resource?.chapterId ?? asString(event.data.chapterId);
	if (key === "narratorId") return event.resource?.narratorId ?? asString(event.data.narratorId);
	if (key === "providerInstanceId") return asString(event.data.providerInstanceId);
	if (key === "deviceId") return asString(event.data.deviceId);
	if (key === "workspaceId") return asString(event.data.workspaceId);
	return undefined;
}

function matchesScope(event: PublicEvent, scope: InvocationScope): boolean {
	for (const key of Object.keys(scope) as Array<keyof InvocationScope>) {
		const expected = scopeValue(scope, key);
		if (expected === undefined) continue;
		if (eventScopeValue(event, key) !== expected) return false;
	}
	return true;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function boundedText(value: unknown, max = 500): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed || SENSITIVE_VALUE.test(trimmed)) return undefined;
	return trimmed.slice(0, max);
}

function resource(
	type: NonNullable<PublicEvent["resource"]>["type"],
	id: unknown,
	fields: Partial<NonNullable<PublicEvent["resource"]>> = {},
): PublicEvent["resource"] | undefined {
	if (typeof id !== "string" || !id) return undefined;
	return { type, id, ...fields };
}

function baseMapping(
	topic: PublicEventTopic,
	eventClass: PublicEvent["eventClass"],
	data: Record<string, JsonValue>,
	redaction: PublicEvent["redaction"],
	context: PluginEventMappingContext,
	extra: Partial<PublicEvent> = {},
): PublicEvent {
	return {
		schema: "narrafork.public-event",
		schemaVersion: 1,
		eventId: context.eventId,
		occurredAt: context.occurredAt,
		topic,
		eventClass,
		data,
		redaction,
		...extra,
	};
}

/** The built-in mapper intentionally uses explicit allowlists for every internal event. */
export const defaultPluginEventMapper: PluginEventMapper = (event, context) => {
	const type = String((event as { type?: unknown }).type ?? "");
	const value = event as unknown as Record<string, unknown>;
	if (type === "chapter:created") {
		return baseMapping(
			"narrafork.chapter.created",
			"lifecycle",
			{ chapterId: String(value.chapterId), projectId: String(value.projectId) },
			"user_scoped",
			context,
			{
				resource: resource("chapter", value.chapterId, { projectId: asString(value.projectId) }),
			},
		);
	}
	if (
		[
			"chapter:forked",
			"chapter:dormant",
			"chapter:woken",
			"chapter:abandoned",
			"chapter:frozen",
			"chapter:role_changed",
		].includes(type)
	) {
		const chapterId = value.chapterId;
		return baseMapping(
			"narrafork.chapter.lifecycle",
			"lifecycle",
			{
				chapterId: String(chapterId),
				changeKind: type.slice("chapter:".length),
				...(typeof value.parentId === "string" ? { parentChapterId: value.parentId } : {}),
				...(typeof value.role === "string" ? { role: value.role } : {}),
			},
			"user_scoped",
			context,
			{ resource: resource("chapter", chapterId) },
		);
	}
	if (type === "chapter:merged") {
		return baseMapping(
			"narrafork.chapter.lifecycle",
			"lifecycle",
			{
				changeKind: "merged",
				sourceChapterId: String(value.sourceId),
				targetChapterId: String(value.targetId),
			},
			"user_scoped",
			context,
			{ resource: resource("chapter", value.targetId) },
		);
	}
	if (type === "chapter:commits_updated") {
		return baseMapping(
			"narrafork.chapter.commits.changed",
			"state",
			{ chapterId: String(value.chapterId), newCount: Number(value.newCount) },
			"user_scoped",
			context,
			{ resource: resource("chapter", value.chapterId) },
		);
	}
	if (["dependency:created", "dependency:removed"].includes(type)) {
		return baseMapping(
			"narrafork.chapter.edge.changed",
			"lifecycle",
			{
				edgeId: String(value.edgeId),
				sourceId: String(value.sourceId),
				targetId: String(value.targetId),
				changeKind: type.slice("dependency:".length),
				type: "dependency",
			},
			"user_scoped",
			context,
			{ resource: resource("chapter", value.targetId) },
		);
	}
	if (type.startsWith("review:")) {
		const reviewChapterId = value.reviewChapterId;
		return baseMapping(
			"narrafork.review.lifecycle",
			"lifecycle",
			{
				reviewChapterId: String(reviewChapterId),
				changeKind: type.slice("review:".length),
				...(typeof value.sourceChapterId === "string"
					? { sourceChapterId: value.sourceChapterId }
					: {}),
				...(typeof value.action === "string" ? { action: value.action } : {}),
			},
			"user_scoped",
			context,
			{ resource: resource("review", reviewChapterId) },
		);
	}
	if (type === "narrator:status_changed") {
		return baseMapping(
			"narrafork.narrator.lifecycle",
			"lifecycle",
			{
				narratorId: String(value.narratorId),
				status: String(value.status),
				...(Array.isArray(value.substatus)
					? {
							substatus: value.substatus
								.filter((item): item is string => typeof item === "string")
								.slice(0, 20),
						}
					: {}),
			},
			"user_scoped",
			context,
			{
				resource: resource("narrator", value.narratorId, {
					narratorId: asString(value.narratorId),
				}),
			},
		);
	}
	if (type === "narrator:attention" || type === "narrator:attention_resolved") {
		return baseMapping(
			"narrafork.narrator.attention",
			"attention",
			{
				narratorId: String(value.narratorId),
				reason: String(value.reason),
				state: type.endsWith("resolved") ? "resolved" : "raised",
				...(boundedText(value.detail) ? { detail: boundedText(value.detail) as string } : {}),
			},
			"user_scoped",
			context,
			{
				resource: resource("narrator", value.narratorId, {
					narratorId: asString(value.narratorId),
				}),
			},
		);
	}
	if (type === "narrator:permission_request") {
		return baseMapping(
			"narrafork.narrator.permission.changed",
			"attention",
			{
				narratorId: String(value.narratorId),
				requestId: String(value.requestId),
				state: "pending",
			},
			"user_scoped",
			context,
			{
				resource: resource("narrator", value.narratorId, {
					narratorId: asString(value.narratorId),
				}),
			},
		);
	}
	if (type === "narrator:message") {
		return baseMapping(
			"narrafork.narrator.message.changed",
			"state",
			{ narratorId: String(value.narratorId), role: String(value.role) },
			"user_scoped",
			context,
			{
				resource: resource("narrator", value.narratorId, {
					narratorId: asString(value.narratorId),
				}),
			},
		);
	}
	if (
		["narrator:error", "narrator:warning", "narrator:title_updated", "narrator:forked"].includes(
			type,
		)
	) {
		return baseMapping(
			"narrafork.narrator.lifecycle",
			"lifecycle",
			{
				narratorId: String(value.narratorId),
				changeKind: type.slice("narrator:".length),
				...(type === "narrator:error" ? { status: "error" } : {}),
				...(type === "narrator:warning" ? { status: "warning" } : {}),
				...(typeof value.parentNarratorId === "string"
					? { parentNarratorId: value.parentNarratorId }
					: {}),
			},
			"user_scoped",
			context,
			{
				resource: resource("narrator", value.narratorId, {
					narratorId: asString(value.narratorId),
				}),
			},
		);
	}
	if (type.startsWith("plugin:")) {
		const pluginId = asString(value.pluginId);
		if (!pluginId) return undefined;
		const desiredState = boundedText(value.desiredState, 32);
		const runtimeState = boundedText(value.runtimeState, 32);
		return baseMapping(
			"narrafork.plugin.lifecycle",
			"lifecycle",
			{
				pluginId,
				...(typeof value.version === "string" ? { version: value.version.slice(0, 128) } : {}),
				...(desiredState ? { desiredState } : {}),
				...(runtimeState ? { runtimeState } : {}),
				changeKind: type.slice("plugin:".length),
			},
			"admin_scoped",
			context,
			{ resource: resource("plugin", pluginId) },
		);
	}
	return undefined;
};

function sanitizeJsonValue(value: unknown, key = ""): JsonValue | undefined {
	if (isSensitiveKey(key)) return undefined;
	if (value === null || typeof value === "string" || typeof value === "boolean")
		return typeof value === "string" ? value.slice(0, 4_000) : value;
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (Array.isArray(value)) {
		const result: JsonValue[] = [];
		for (const item of value.slice(0, 100)) {
			const sanitized = sanitizeJsonValue(item);
			if (sanitized !== undefined) result.push(sanitized);
		}
		return result;
	}
	if (typeof value !== "object" || value === null) return undefined;
	const result: Record<string, JsonValue> = {};
	for (const [childKey, childValue] of Object.entries(value).slice(0, 100)) {
		const sanitized = sanitizeJsonValue(childValue, childKey);
		if (sanitized !== undefined) result[childKey] = sanitized;
	}
	return result;
}

function sanitizeMappedEvent(
	mapped: PublicEventMapping,
	context: PluginEventMappingContext,
): PublicEvent {
	const sanitizedData = sanitizeJsonValue(mapped.data);
	const event = {
		schema: "narrafork.public-event" as const,
		schemaVersion: 1 as const,
		eventId: mapped.eventId ?? context.eventId,
		topic: mapped.topic,
		eventClass: mapped.eventClass,
		occurredAt: mapped.occurredAt ?? context.occurredAt,
		...(mapped.resource ? { resource: mapped.resource } : {}),
		...(mapped.actor ? { actor: mapped.actor } : {}),
		data: (sanitizedData && typeof sanitizedData === "object" && !Array.isArray(sanitizedData)
			? sanitizedData
			: {}) as Record<string, JsonValue>,
		redaction: mapped.redaction,
		...(mapped.resyncHint ? { resyncHint: mapped.resyncHint } : {}),
	};
	return publicEventSchema.parse(event);
}

function eventBytes(event: PublicEvent): number {
	return encoder.encode(JSON.stringify(event)).byteLength;
}

function controlEvent(
	topic: "narrafork.events.overflow" | "narrafork.events.resync_required",
	subscriptionId: string,
	data: Record<string, JsonValue>,
): PublicEvent {
	return publicEventSchema.parse({
		schema: "narrafork.public-event",
		schemaVersion: 1,
		eventId: `evt_${generateShortId(16)}`,
		topic,
		eventClass: "audit",
		occurredAt: new Date().toISOString(),
		data: { subscriptionId, ...data },
		redaction: "public",
		resyncHint: { queryId: "narrafork.events.resync_required" },
	});
}

export class PluginEventGateway {
	private readonly bus: PluginEventBus;
	private readonly mapper: PluginEventMapper;
	private readonly capabilityBroker: PluginCapabilityBroker;
	private readonly healthRegistry: PluginHealthRegistry;
	private readonly defaultQueueEvents: number;
	private readonly defaultQueueBytes: number;
	private readonly defaultRatePerSecond: number;
	private readonly maxSubscriptions: number;
	private readonly maxDispatchesPerSecond: number;
	private readonly maxConcurrentDispatches: number;
	private readonly subscriptions = new Map<string, Subscription>();
	private readonly diagnostics: PluginEventGatewayDiagnostic[] = [];
	private readonly listener: (event: NarraForkEvent) => void;
	private listening = false;
	private dispatchesInFlight = 0;
	private dispatchWindowStartedAt = Date.now();
	private dispatchesInWindow = 0;

	constructor(options: PluginEventGatewayOptions = {}) {
		this.bus = options.eventBus ?? eventBus;
		this.mapper = options.mapper ?? defaultPluginEventMapper;
		this.capabilityBroker = options.capabilityBroker ?? {
			authorize: () => false,
		};
		this.healthRegistry = options.healthRegistry ?? pluginHealthRegistry;
		this.defaultQueueEvents = boundedLimit(
			options.defaultQueueEvents ?? DEFAULT_QUEUE_EVENTS,
			1,
			HARD_QUEUE_EVENTS,
		);
		this.defaultQueueBytes = boundedLimit(
			options.defaultQueueBytes ?? DEFAULT_QUEUE_BYTES,
			1,
			HARD_QUEUE_BYTES,
		);
		this.defaultRatePerSecond = boundedRate(
			options.defaultRatePerSecond ?? DEFAULT_RATE_PER_SECOND,
		);
		this.maxSubscriptions = boundedLimit(
			options.maxSubscriptions ?? DEFAULT_MAX_SUBSCRIPTIONS,
			1,
			HARD_MAX_SUBSCRIPTIONS,
		);
		this.maxDispatchesPerSecond = boundedLimit(
			options.maxDispatchesPerSecond ?? DEFAULT_MAX_DISPATCHES_PER_SECOND,
			1,
			HARD_MAX_DISPATCHES_PER_SECOND,
		);
		this.maxConcurrentDispatches = boundedLimit(
			options.maxConcurrentDispatches ?? DEFAULT_MAX_CONCURRENT_DISPATCHES,
			1,
			HARD_MAX_CONCURRENT_DISPATCHES,
		);
		this.listener = (event) => {
			// Never map or authorize on eventBus.emit's synchronous call stack.
			queueMicrotask(() => {
				void this.processInternalEvent(event);
			});
		};
		if (options.registerListener !== false) {
			const shouldRegister = options.hotReloadGuard
				? hotOnce("narrafork.pluginEventGateway.listenersRegistered")
				: true;
			if (shouldRegister) {
				this.bus.onAny(this.listener);
				this.listening = true;
			}
		}
	}

	async subscribe(input: SubscribeEventsInput): Promise<SubscribeEventsResult> {
		const startedAt = Date.now();
		const parsed = subscribeSchema.safeParse(input);
		if (!parsed.success) {
			this.recordDiagnostic({
				code: "INVALID_SUBSCRIPTION",
				message: "Invalid event subscription",
				at: now(),
			});
			throw new Error("INVALID_SUBSCRIPTION");
		}
		const value = parsed.data;
		const principalInput = value.principal ?? value.plugin;
		const pluginId = value.pluginId ?? principalInput?.pluginId;
		if (!pluginId) {
			this.recordDiagnostic({
				code: "INVALID_SUBSCRIPTION",
				message: "Plugin identity is required",
				at: now(),
			});
			throw new Error("INVALID_SUBSCRIPTION");
		}
		if (this.subscriptions.size >= this.maxSubscriptions) {
			this.recordDiagnostic({
				code: "QUOTA_EXCEEDED",
				message: "Global event subscription quota is exhausted",
				at: now(),
				pluginId,
				count: this.subscriptions.size,
			});
			this.recordHealth(pluginId, false, Date.now() - startedAt, "SUBSCRIPTION_QUOTA");
			throw new Error("SUBSCRIPTION_QUOTA_EXCEEDED");
		}
		const filter = value.filter;
		if (filter?.topic?.some((topic) => !value.topics.includes(topic))) {
			this.recordDiagnostic({
				code: "INVALID_SUBSCRIPTION",
				message: "Filter topic is not subscribed",
				at: now(),
				pluginId,
			});
			throw new Error("INVALID_FILTER");
		}
		const baseScope = value.invocationScope ?? value.currentScope ?? {};
		const scope = value.scope ?? baseScope;
		if (!isScopeNarrower(baseScope, scope) || !filterWithinScope(filter, scope)) {
			this.recordDiagnostic({
				code: "PERMISSION_DENIED",
				message: "Subscription scope cannot be widened",
				at: now(),
				pluginId,
			});
			throw new Error("PERMISSION_DENIED");
		}
		const principal: PluginPrincipal = {
			...principalInput,
			pluginId,
			...(value.runtimeId ? { runtimeId: value.runtimeId } : {}),
			...(value.generation !== undefined ? { generation: value.generation } : {}),
			...(value.sessionId ? { sessionId: value.sessionId } : {}),
			...(value.contributionId ? { contributionId: value.contributionId } : {}),
			...(value.packageVersion ? { packageVersion: value.packageVersion } : {}),
		};
		for (const topic of value.topics as PublicEventTopic[]) {
			const decision = await this.authorize("subscribe", principal, topic, scope);
			if (!decision.allowed) {
				this.recordDiagnostic({
					code: "PERMISSION_DENIED",
					message: "Event subscription denied",
					at: now(),
					pluginId: principal.pluginId,
					topic,
				});
				void this.audit({
					pluginId: principal.pluginId,
					runtimeId: principal.runtimeId,
					generation: principal.generation,
					methodId: "events.subscribe",
					capability: capabilityForTopic(topic),
					topic,
					outcome: "denied",
					requestBytes: 0,
					responseBytes: 0,
				});
				throw new Error("PERMISSION_DENIED");
			}
		}
		const id = `sub_${generateShortId(16)}`;
		const requestedDelivery = value.delivery ?? {};
		const sub: Subscription = {
			id,
			principal,
			baseScope,
			scope,
			topics: new Set(value.topics as PublicEventTopic[]),
			filter,
			mode: value.mode,
			delivery: {
				maxRatePerSecond: Math.min(
					requestedDelivery.maxRatePerSecond ?? this.defaultRatePerSecond,
					this.defaultRatePerSecond,
				),
				queueEvents: Math.min(
					requestedDelivery.queueEvents ?? this.defaultQueueEvents,
					this.defaultQueueEvents,
				),
				queueBytes: Math.min(
					requestedDelivery.queueBytes ?? this.defaultQueueBytes,
					this.defaultQueueBytes,
				),
			},
			onEvent: value.onEvent ?? value.deliver,
			queue: [],
			controlQueue: [],
			queueBytes: 0,
			deliverySeq: 0,
			nextDeliveryAt: 0,
			pumpScheduled: false,
			status: "active",
			overflowNotified: false,
			delivered: 0,
			dropped: 0,
			coalesced: 0,
		};
		this.subscriptions.set(id, sub);
		this.recordHealth(pluginId, true, Date.now() - startedAt, "SUBSCRIBED");
		void this.audit({
			pluginId: principal.pluginId,
			runtimeId: principal.runtimeId,
			generation: principal.generation,
			subscriptionId: id,
			methodId: "events.subscribe",
			outcome: "succeeded",
			requestBytes: 0,
			responseBytes: 0,
			durationMs: Date.now() - startedAt,
			redactedSummary: { topicCount: value.topics.length, mode: value.mode },
		});
		return {
			subscriptionId: id,
			mode: sub.mode,
			delivery: {
				maxFrameBytes: MAX_EVENT_BYTES,
				queueEvents: sub.delivery.queueEvents,
				queueBytes: sub.delivery.queueBytes,
				maxRatePerSecond: sub.delivery.maxRatePerSecond,
			},
		};
	}

	unsubscribe(subscriptionId: string, reason = "cancelled"): boolean {
		const sub = this.subscriptions.get(subscriptionId);
		if (!sub) return false;
		this.subscriptions.delete(subscriptionId);
		if (sub.pumpTimer) clearTimeout(sub.pumpTimer);
		sub.status = reason === "cancelled" ? "cancelled" : "revoked";
		sub.queue.length = 0;
		sub.controlQueue.length = 0;
		sub.queueBytes = 0;
		void this.audit({
			pluginId: sub.principal.pluginId,
			runtimeId: sub.principal.runtimeId,
			generation: sub.principal.generation,
			subscriptionId,
			methodId: "events.unsubscribe",
			outcome: "succeeded",
			requestBytes: 0,
			responseBytes: 0,
			redactedSummary: { reason: reason.slice(0, 64) },
		});
		return true;
	}

	cancel(subscriptionId: string): boolean {
		return this.unsubscribe(subscriptionId, "cancelled");
	}

	poll(subscriptionId: string, limit = 100): PublicEvent[] {
		const sub = this.subscriptions.get(subscriptionId);
		if (!sub) return [];
		const bounded = Math.max(
			1,
			Math.min(Math.floor(limit), sub.delivery.queueEvents + CONTROL_QUEUE_EVENTS),
		);
		const result: PublicEvent[] = [];
		while (result.length < bounded && sub.controlQueue.length > 0) {
			const item = sub.controlQueue.shift();
			if (item) result.push(item.event);
		}
		while (result.length < bounded && sub.queue.length > 0) {
			const item = sub.queue.shift();
			if (!item) break;
			sub.queueBytes -= item.bytes;
			result.push(item.event);
		}
		return result;
	}

	ack(subscriptionId: string, limit = 100): PublicEvent[] {
		return this.poll(subscriptionId, limit);
	}

	listDiagnostics(): PluginEventGatewayDiagnostic[] {
		return this.diagnostics.map((diagnostic) => ({ ...diagnostic }));
	}

	getDiagnostics(): PluginEventGatewayDiagnostic[] {
		return this.listDiagnostics();
	}

	getSubscriptionDiagnostics(): PluginEventSubscriptionDiagnostics[] {
		return this.listSubscriptionDiagnostics();
	}

	listSubscriptionDiagnostics(): PluginEventSubscriptionDiagnostics[] {
		return [...this.subscriptions.values()].map((sub) => ({
			subscriptionId: sub.id,
			pluginId: sub.principal.pluginId,
			runtimeId: sub.principal.runtimeId,
			generation: sub.principal.generation,
			mode: sub.mode,
			status: sub.status,
			queueEvents: sub.queue.length + sub.controlQueue.length,
			queueBytes: sub.queueBytes,
			delivered: sub.delivered,
			dropped: sub.dropped,
			coalesced: sub.coalesced,
			lastDeliveryAt: sub.lastDeliveryAt,
		}));
	}

	revokePlugin(pluginId: string, reason = "plugin-disabled"): number {
		let revoked = 0;
		for (const sub of [...this.subscriptions.values()]) {
			if (sub.principal.pluginId !== pluginId) continue;
			if (this.unsubscribe(sub.id, reason)) {
				revoked += 1;
				this.recordDiagnostic({
					code: "SUBSCRIPTION_REVOKED",
					message: "Subscription revoked",
					at: now(),
					pluginId,
					subscriptionId: sub.id,
				});
			}
		}
		return revoked;
	}

	disablePlugin(pluginId: string): number {
		return this.revokePlugin(pluginId, "plugin-disabled");
	}

	revokeSession(sessionId: string): number {
		let revoked = 0;
		for (const sub of [...this.subscriptions.values()]) {
			if (sub.principal.sessionId !== sessionId) continue;
			if (this.unsubscribe(sub.id, "session-disabled")) revoked += 1;
		}
		return revoked;
	}

	disableSession(sessionId: string): number {
		return this.revokeSession(sessionId);
	}

	subscribeEvents(input: SubscribeEventsInput): Promise<SubscribeEventsResult> {
		return this.subscribe(input);
	}

	unsubscribeEvents(subscriptionId: string, reason = "cancelled"): boolean {
		return this.unsubscribe(subscriptionId, reason);
	}

	revokeRuntime(pluginId: string, runtimeId?: string, generation?: number): number {
		let revoked = 0;
		for (const sub of [...this.subscriptions.values()]) {
			if (sub.principal.pluginId !== pluginId) continue;
			if (runtimeId !== undefined && sub.principal.runtimeId !== runtimeId) continue;
			if (generation !== undefined && sub.principal.generation !== generation) continue;
			if (this.unsubscribe(sub.id, "runtime-generation-invalidated")) revoked += 1;
		}
		return revoked;
	}

	invalidateGeneration(pluginId: string, runtimeId?: string, generation?: number): number {
		return this.revokeRuntime(pluginId, runtimeId, generation);
	}

	close(): void {
		if (this.listening) {
			this.bus.offAny(this.listener);
			this.listening = false;
		}
		for (const sub of [...this.subscriptions.values()]) this.unsubscribe(sub.id, "gateway-closed");
	}

	private async processInternalEvent(event: NarraForkEvent): Promise<void> {
		const context = { eventId: `evt_${generateId(16)}`, occurredAt: new Date().toISOString() };
		let mapped: PublicEvent;
		try {
			const result = await this.mapper(event, context);
			if (!result) {
				this.recordDiagnostic({
					code: "UNKNOWN_INTERNAL_EVENT",
					message: "Internal event has no public mapping",
					at: context.occurredAt,
				});
				return;
			}
			mapped = sanitizeMappedEvent(result, context);
		} catch (error) {
			const message =
				error instanceof z.ZodError
					? "Mapper produced an invalid public event"
					: "Public event mapper failed";
			this.recordDiagnostic({
				code: error instanceof z.ZodError ? "INVALID_PUBLIC_EVENT" : "MAPPER_FAILED",
				message,
				at: context.occurredAt,
			});
			return;
		}
		if (mapped.topic === "narrafork.plugin.lifecycle") {
			const state = String(mapped.data.desiredState ?? mapped.data.runtimeState ?? "");
			const changeKind = String(mapped.data.changeKind ?? "");
			if (
				["disabled", "inactive", "stopped", "quarantine", "deactivated"].includes(state) ||
				["disabled", "deactivated", "stopped"].includes(changeKind)
			) {
				const pluginId = mapped.resource?.id ?? asString(mapped.data.pluginId);
				if (pluginId) this.revokePlugin(pluginId, "plugin-lifecycle-disabled");
			}
		}
		for (const sub of [...this.subscriptions.values()]) void this.dispatch(sub, mapped);
	}

	private async dispatch(sub: Subscription, event: PublicEvent): Promise<void> {
		if (!this.subscriptions.has(sub.id) || sub.status === "revoked" || sub.status === "cancelled")
			return;
		if (
			!sub.topics.has(event.topic) ||
			!matchesScope(event, sub.scope) ||
			!matchesFilter(event, sub.filter)
		)
			return;
		if (!this.acquireDispatchSlot()) {
			sub.dropped += 1;
			this.recordDiagnostic({
				code: "QUOTA_EXCEEDED",
				message: "Global event dispatch quota is exhausted",
				at: now(),
				pluginId: sub.principal.pluginId,
				subscriptionId: sub.id,
				topic: event.topic,
			});
			this.recordHealth(sub.principal.pluginId, false, 0, "DISPATCH_QUOTA");
			return;
		}
		try {
			const active = await this.isActive(sub.principal);
			if (!active) {
				this.recordHealth(sub.principal.pluginId, false, 0, "RUNTIME_INACTIVE");
				this.revokePlugin(sub.principal.pluginId, "runtime-disabled");
				return;
			}
			const decision = await this.authorize(
				"deliver",
				sub.principal,
				event.topic,
				sub.scope,
				event,
			);
			if (!decision.allowed) {
				sub.dropped += 1;
				this.recordDiagnostic({
					code: "PERMISSION_DENIED",
					message: "Event delivery denied",
					at: now(),
					pluginId: sub.principal.pluginId,
					subscriptionId: sub.id,
					topic: event.topic,
				});
				this.recordHealth(sub.principal.pluginId, false, 0, "PERMISSION_DENIED");
				if (decision.revoke) this.unsubscribe(sub.id, decision.reason ?? "permission-revoked");
				return;
			}
			const deliveryEvent = publicEventSchema.parse({ ...event, deliverySeq: ++sub.deliverySeq });
			this.enqueue(sub, deliveryEvent, false);
			this.schedulePump(sub);
			this.recordHealth(sub.principal.pluginId, true, 0, "DISPATCHED", eventBytes(deliveryEvent));
			void this.audit({
				pluginId: sub.principal.pluginId,
				runtimeId: sub.principal.runtimeId,
				generation: sub.principal.generation,
				subscriptionId: sub.id,
				methodId: "events.deliver",
				capability: capabilityForTopic(event.topic),
				topic: event.topic,
				outcome: "succeeded",
				requestBytes: 0,
				responseBytes: eventBytes(deliveryEvent),
			});
		} catch {
			sub.dropped += 1;
			this.recordHealth(sub.principal.pluginId, false, 0, "DISPATCH_FAILED");
			this.recordDiagnostic({
				code: "DELIVERY_FAILED",
				message: "Event dispatch failed",
				at: now(),
				pluginId: sub.principal.pluginId,
				subscriptionId: sub.id,
				topic: event.topic,
			});
		} finally {
			this.releaseDispatchSlot();
		}
	}

	private enqueue(sub: Subscription, event: PublicEvent, control: boolean): void {
		const bytes = eventBytes(event);
		if (control) {
			if (sub.controlQueue.length >= CONTROL_QUEUE_EVENTS) sub.controlQueue.shift();
			sub.controlQueue.push({ event, bytes, control: true });
			return;
		}
		if (sub.status === "overflowed") {
			sub.dropped += 1;
			return;
		}
		const coalesceKey =
			event.eventClass === "state" || event.eventClass === "progress"
				? `${event.topic}:${event.resource?.type ?? "none"}:${event.resource?.id ?? "none"}`
				: undefined;
		if (coalesceKey) {
			const index = sub.queue.findIndex((item) => item.coalesceKey === coalesceKey);
			if (index >= 0) {
				const previous = sub.queue[index];
				if (
					bytes > MAX_EVENT_BYTES ||
					sub.queueBytes - previous.bytes + bytes > sub.delivery.queueBytes
				) {
					this.triggerOverflow(sub, bytes);
					return;
				}
				sub.queue[index] = { event, bytes, coalesceKey, control: false };
				sub.queueBytes += bytes - previous.bytes;
				sub.coalesced += 1;
				return;
			}
		}
		if (
			bytes > MAX_EVENT_BYTES ||
			sub.queue.length >= sub.delivery.queueEvents ||
			sub.queueBytes + bytes > sub.delivery.queueBytes
		) {
			this.triggerOverflow(sub, bytes);
			return;
		}
		sub.queue.push({ event, bytes, coalesceKey, control: false });
		sub.queueBytes += bytes;
	}

	private triggerOverflow(sub: Subscription, attemptedBytes: number): void {
		sub.dropped += 1;
		sub.status = "overflowed";
		sub.queue.length = 0;
		sub.queueBytes = 0;
		this.recordDiagnostic({
			code: "QUEUE_OVERFLOW",
			message: "Subscription queue overflowed",
			at: now(),
			pluginId: sub.principal.pluginId,
			subscriptionId: sub.id,
			count: attemptedBytes,
		});
		void this.audit({
			pluginId: sub.principal.pluginId,
			runtimeId: sub.principal.runtimeId,
			generation: sub.principal.generation,
			subscriptionId: sub.id,
			methodId: "events.deliver",
			outcome: "overflow",
			requestBytes: attemptedBytes,
			responseBytes: 0,
			redactedSummary: { dropped: sub.dropped },
		});
		if (sub.overflowNotified) return;
		sub.overflowNotified = true;
		this.enqueue(
			sub,
			controlEvent("narrafork.events.overflow", sub.id, { dropped: sub.dropped }),
			true,
		);
		this.enqueue(
			sub,
			controlEvent("narrafork.events.resync_required", sub.id, { reason: "queue_overflow" }),
			true,
		);
		this.schedulePump(sub);
	}

	private schedulePump(sub: Subscription): void {
		if (!sub.onEvent || sub.pumpScheduled || !this.subscriptions.has(sub.id)) return;
		sub.pumpScheduled = true;
		queueMicrotask(() => {
			sub.pumpScheduled = false;
			void this.pump(sub);
		});
	}

	private async pump(sub: Subscription): Promise<void> {
		if (!sub.onEvent || !this.subscriptions.has(sub.id)) return;
		const item = sub.controlQueue.shift() ?? this.takeRateLimitedItem(sub);
		if (!item) return;
		if (!item.control) sub.queueBytes -= item.bytes;
		try {
			await sub.onEvent(item.event);
			sub.delivered += 1;
			sub.lastDeliveryAt = now();
		} catch {
			sub.dropped += 1;
			this.recordDiagnostic({
				code: "DELIVERY_FAILED",
				message: "Plugin event delivery failed",
				at: now(),
				pluginId: sub.principal.pluginId,
				subscriptionId: sub.id,
			});
		}
		if (this.subscriptions.has(sub.id)) {
			if (sub.controlQueue.length > 0 || sub.queue.length > 0) this.schedulePump(sub);
		}
	}

	private takeRateLimitedItem(sub: Subscription): QueueItem | undefined {
		const item = sub.queue[0];
		if (!item) return undefined;
		const current = Date.now();
		if (current < sub.nextDeliveryAt) {
			if (!sub.pumpTimer) {
				sub.pumpTimer = setTimeout(
					() => {
						sub.pumpTimer = undefined;
						this.schedulePump(sub);
					},
					Math.max(1, sub.nextDeliveryAt - current),
				);
			}
			return undefined;
		}
		sub.queue.shift();
		sub.nextDeliveryAt = current + 1_000 / sub.delivery.maxRatePerSecond;
		return item;
	}

	private acquireDispatchSlot(): boolean {
		const current = Date.now();
		if (current - this.dispatchWindowStartedAt >= 1_000) {
			this.dispatchWindowStartedAt = current;
			this.dispatchesInWindow = 0;
		}
		if (
			this.dispatchesInWindow >= this.maxDispatchesPerSecond ||
			this.dispatchesInFlight >= this.maxConcurrentDispatches
		)
			return false;
		this.dispatchesInWindow += 1;
		this.dispatchesInFlight += 1;
		return true;
	}

	private releaseDispatchSlot(): void {
		this.dispatchesInFlight = Math.max(0, this.dispatchesInFlight - 1);
	}

	private recordHealth(
		pluginId: string,
		ok: boolean,
		durationMs: number,
		code: string,
		bytesOut = 0,
	): void {
		this.healthRegistry.recordCall(pluginId, "event", {
			ok,
			durationMs,
			code,
			bytesOut,
		});
	}

	private async authorize(
		phase: "subscribe" | "deliver",
		plugin: PluginPrincipal,
		topic: PublicEventTopic,
		scope: InvocationScope,
		event?: PublicEvent,
	): Promise<CapabilityAuthorizationDecision> {
		try {
			const authorize = this.capabilityBroker.authorize ?? this.capabilityBroker.check;
			if (!authorize) return { allowed: false, revoke: true, reason: "capability-broker-missing" };
			return asDecision(
				await authorize({
					phase,
					plugin,
					capability: capabilityForTopic(topic),
					topic,
					scope,
					event,
				}),
			);
		} catch {
			return { allowed: false, revoke: true, reason: "capability-broker-failed" };
		}
	}

	private async isActive(plugin: PluginPrincipal): Promise<boolean> {
		if (!this.capabilityBroker.isRuntimeActive) return true;
		try {
			return await this.capabilityBroker.isRuntimeActive(plugin);
		} catch {
			return false;
		}
	}

	private async audit(summary: PluginEventAuditSummary): Promise<void> {
		try {
			await (this.capabilityBroker.audit ?? this.capabilityBroker.recordAudit)?.(summary);
		} catch {
			this.recordDiagnostic({
				code: "DELIVERY_FAILED",
				message: "Capability audit failed",
				at: now(),
				pluginId: summary.pluginId,
				subscriptionId: summary.subscriptionId,
			});
		}
	}

	private recordDiagnostic(diagnostic: PluginEventGatewayDiagnostic): void {
		this.diagnostics.push({ ...diagnostic, message: diagnostic.message.slice(0, 240) });
		if (this.diagnostics.length > MAX_DIAGNOSTICS)
			this.diagnostics.splice(0, this.diagnostics.length - MAX_DIAGNOSTICS);
	}
}

function boundedLimit(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, Math.floor(value)));
}

function boundedRate(value: number): number {
	return Math.max(0.1, Math.min(HARD_RATE_PER_SECOND, value));
}

function now(): string {
	return new Date().toISOString();
}

/** Default host-owned gateway; production composition may replace its broker/mapper via injection. */
export const pluginEventGateway = new PluginEventGateway({ hotReloadGuard: true });
