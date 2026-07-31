import type { ResourceScope } from "@shared/integrations/resources";
import { z } from "zod";
import { eventBus, type NarraForkEvent } from "../lib/event-bus";
import { hotOnce } from "../lib/hot-safe";
import { generateId } from "../lib/id";
import {
	type IntegrationEventAuditRecord,
	type IntegrationEventAuthorizationRequest,
	IntegrationEventDispatcher,
} from "../lib/integrations/kernel";
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
import { integrationAuthorityService } from "./integration-authority-service";
import { integrationAuthorizationService } from "./integration-authorization-service";
import { integrationEventDispatcher } from "./integration-event-dispatcher";
import { type PluginHealthRegistry, pluginHealthRegistry } from "./plugin-health";
import { pluginInstallationAuthorityId } from "./plugin-integration-authority-service";

const MAX_DIAGNOSTICS = 128;
const MAX_TOPICS = 20;
const DEFAULT_QUEUE_EVENTS = 100;
const DEFAULT_QUEUE_BYTES = 256 * 1024;
const HARD_QUEUE_EVENTS = 1_000;
const HARD_QUEUE_BYTES = 2 * 1024 * 1024;
const DEFAULT_RATE_PER_SECOND = 100;
const HARD_RATE_PER_SECOND = 1_000;
const DEFAULT_MAX_SUBSCRIPTIONS = 256;
const DEFAULT_MAX_DISPATCHES_PER_SECOND = 2_000;
const DEFAULT_MAX_CONCURRENT_DISPATCHES = 64;
const MAX_EVENT_BYTES = 256 * 1024;
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
	installationId?: string;
	grantRevision?: number;
	authorityId?: string;
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
	installationId?: string;
	grantRevision?: number;
	authorityId?: string;
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

const subscribeSchema = z
	.object({
		pluginId: z.string().trim().min(1).max(128).optional(),
		installationId: z.string().trim().min(1).max(128).optional(),
		grantRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
		authorityId: z.string().trim().min(1).max(256).optional(),
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
				installationId: z.string().trim().min(1).max(128).optional(),
				grantRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
				authorityId: z.string().trim().min(1).max(256).optional(),
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
				installationId: z.string().trim().min(1).max(128).optional(),
				grantRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
				authorityId: z.string().trim().min(1).max(256).optional(),
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
	dispatcher?: IntegrationEventDispatcher<PublicEvent>;
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

export function pluginEventCapabilityForTopic(_topic: PublicEventTopic): string {
	return "event.subscribe";
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
	if (type === "narrator:tool_changed") {
		// Bounded metadata only. The tool input/output stay server-side: subscribers need to know
		// what ran, where, how long it took and whether it failed — not the payloads.
		return baseMapping(
			"narrafork.narrator.tool.changed",
			"state",
			{
				narratorId: String(value.narratorId),
				toolUseId: String(value.toolUseId),
				toolName: String(value.toolName),
				status: String(value.status),
				...(typeof value.durationMs === "number" ? { durationMs: value.durationMs } : {}),
				...(typeof value.executionDeviceId === "string"
					? { executionDeviceId: value.executionDeviceId }
					: {}),
				...(boundedText(value.errorMessage)
					? { errorMessage: boundedText(value.errorMessage) as string }
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

function invocationToResourceScope(scope: InvocationScope): ResourceScope {
	if (scope.narratorId) return { type: "narrator", id: scope.narratorId };
	if (scope.chapterId) return { type: "chapter", id: scope.chapterId };
	if (scope.deviceId) return { type: "device", id: scope.deviceId };
	if (scope.providerInstanceId) return { type: "provider", id: scope.providerInstanceId };
	if (scope.projectId) return { type: "project", id: scope.projectId };
	if (scope.workspaceId) return { type: "workspace", id: scope.workspaceId };
	if (scope.userId) return { type: "user", id: scope.userId };
	return { type: "global" };
}

function gatewayControlEvent(
	topic: "narrafork.events.overflow" | "narrafork.events.resync_required",
	subscriptionId: string,
	data: Readonly<Record<string, string | number | boolean>>,
): PublicEvent {
	return publicEventSchema.parse({
		schema: "narrafork.public-event",
		schemaVersion: 1,
		eventId: `evt_${generateId()}`,
		topic,
		eventClass: "audit",
		occurredAt: new Date().toISOString(),
		data: { subscriptionId, ...data },
		redaction: "public",
		resyncHint: { queryId: "narrafork.events.resync_required" },
	});
}

function principalFromAuthorizationRequest(
	request: IntegrationEventAuthorizationRequest<PublicEvent>,
): PluginPrincipal {
	return {
		pluginId: "id" in request.identity.subject ? (request.identity.subject.id ?? "") : "",
		runtimeId: request.identity.runtime.id,
		generation: request.identity.runtime.generation,
		sessionId: request.identity.sessionId,
	};
}

function invocationFromResourceScope(scope: ResourceScope): InvocationScope {
	if (scope.type === "global") return {};
	if (scope.type === "narrator") return { narratorId: scope.id };
	if (scope.type === "chapter") return { chapterId: scope.id };
	if (scope.type === "device") return { deviceId: scope.id };
	if (scope.type === "provider") return { providerInstanceId: scope.id };
	if (scope.type === "project") return { projectId: scope.id };
	if (scope.type === "workspace") return { workspaceId: scope.id };
	if (scope.type === "user") return { userId: scope.id };
	return {};
}

export class PluginEventGateway {
	private readonly bus: PluginEventBus;
	private readonly mapper: PluginEventMapper;
	private readonly capabilityBroker?: PluginCapabilityBroker;
	private readonly healthRegistry: PluginHealthRegistry;
	private readonly dispatcher: IntegrationEventDispatcher<PublicEvent>;
	private readonly ownsDispatcher: boolean;
	private readonly defaultQueueEvents: number;
	private readonly defaultQueueBytes: number;
	private readonly defaultRatePerSecond: number;
	private readonly diagnostics: PluginEventGatewayDiagnostic[] = [];
	private readonly ownedSubscriptions = new Set<string>();
	private readonly listener: (event: NarraForkEvent) => void;
	private listening = false;

	constructor(options: PluginEventGatewayOptions = {}) {
		this.bus = options.eventBus ?? eventBus;
		this.mapper = options.mapper ?? defaultPluginEventMapper;
		this.capabilityBroker = options.capabilityBroker;
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
		if (options.dispatcher) {
			this.dispatcher = options.dispatcher;
			this.ownsDispatcher = false;
		} else if (this.capabilityBroker) {
			this.dispatcher = this.createLegacyDispatcher(options);
			this.ownsDispatcher = true;
		} else {
			this.dispatcher = integrationEventDispatcher;
			this.ownsDispatcher = false;
		}
		this.listener = (event) => {
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
		if (value.mode === "snapshot_live") {
			throw new Error("INVALID_SUBSCRIPTION");
		}
		const principalInput = value.principal ?? value.plugin;
		const pluginId = value.pluginId ?? principalInput?.pluginId;
		if (!pluginId) throw new Error("INVALID_SUBSCRIPTION");
		const filter = value.filter;
		if (filter?.topic?.some((topic) => !value.topics.includes(topic))) {
			throw new Error("INVALID_FILTER");
		}
		const baseScope = value.invocationScope ?? value.currentScope ?? {};
		const scope = value.scope ?? baseScope;
		if (!isScopeNarrower(baseScope, scope) || !filterWithinScope(filter, scope)) {
			throw new Error("PERMISSION_DENIED");
		}
		const installationId = value.installationId ?? principalInput?.installationId;
		const authorityId =
			value.authorityId ??
			principalInput?.authorityId ??
			(installationId ? pluginInstallationAuthorityId(pluginId, installationId) : undefined) ??
			(this.capabilityBroker ? `legacy-plugin:${pluginId}` : undefined);
		let authorityRevision =
			value.grantRevision ??
			principalInput?.grantRevision ??
			(this.capabilityBroker ? 0 : undefined);
		if (authorityId && authorityRevision === undefined) {
			authorityRevision = (await integrationAuthorityService.getSnapshot(authorityId))?.authority
				.revision;
		}
		if (!authorityId || authorityRevision === undefined) {
			throw new Error("PERMISSION_DENIED");
		}
		const runtimeId = value.runtimeId ?? principalInput?.runtimeId ?? `plugin:${pluginId}`;
		const generation = value.generation ?? principalInput?.generation ?? 0;
		const sessionId = value.sessionId ?? principalInput?.sessionId;
		const canonicalScope = invocationToResourceScope(scope);
		const canonicalBaseScope = invocationToResourceScope(baseScope);
		const requestedDelivery = value.delivery ?? {};
		let subscriptionId: string;
		try {
			subscriptionId = await this.dispatcher.register({
				identity: {
					authorityId,
					authorityRevision,
					runtime: { type: "plugin", id: runtimeId, generation },
					subject: { type: "plugin", id: pluginId },
					connectionId: sessionId ?? `${pluginId}:${runtimeId}:${generation}`,
					sessionId,
				},
				topics: value.topics as PublicEventTopic[],
				scope: canonicalScope,
				boundScopes: [canonicalBaseScope],
				matchesEvent: (event) => matchesScope(event, scope) && matchesFilter(event, filter),
				onEvent: value.onEvent ?? value.deliver,
				onRemoved: () => this.ownedSubscriptions.delete(subscriptionId),
				queue: {
					maxEvents: requestedDelivery.queueEvents,
					maxBytes: requestedDelivery.queueBytes,
					maxRatePerSecond: requestedDelivery.maxRatePerSecond,
				},
			});
		} catch (error) {
			if (error instanceof Error && error.message === "SUBSCRIPTION_QUOTA_EXCEEDED") {
				this.recordDiagnostic({
					code: "QUOTA_EXCEEDED",
					message: "Global event subscription quota is exhausted",
					at: now(),
					pluginId,
					count: this.dispatcher.size,
				});
			}
			throw error;
		}
		this.ownedSubscriptions.add(subscriptionId);
		this.recordHealth(pluginId, true, Date.now() - startedAt, "SUBSCRIBED");
		return {
			subscriptionId,
			mode: "live",
			delivery: {
				maxFrameBytes: MAX_EVENT_BYTES,
				queueEvents: Math.min(
					requestedDelivery.queueEvents ?? this.defaultQueueEvents,
					this.defaultQueueEvents,
				),
				queueBytes: Math.min(
					requestedDelivery.queueBytes ?? this.defaultQueueBytes,
					this.defaultQueueBytes,
				),
				maxRatePerSecond: Math.min(
					requestedDelivery.maxRatePerSecond ?? this.defaultRatePerSecond,
					this.defaultRatePerSecond,
				),
			},
		};
	}

	unsubscribe(subscriptionId: string, reason = "cancelled"): boolean {
		if (!this.ownedSubscriptions.delete(subscriptionId)) return false;
		return this.dispatcher.remove(subscriptionId, reason);
	}

	cancel(subscriptionId: string): boolean {
		return this.unsubscribe(subscriptionId, "cancelled");
	}

	poll(subscriptionId: string, limit = 100): PublicEvent[] {
		return this.ownedSubscriptions.has(subscriptionId)
			? this.dispatcher.poll(subscriptionId, limit)
			: [];
	}

	ack(subscriptionId: string, limit = 100): PublicEvent[] {
		return this.poll(subscriptionId, limit);
	}

	listDiagnostics(): PluginEventGatewayDiagnostic[] {
		this.refreshOverflowDiagnostics();
		return this.diagnostics.map((diagnostic) => ({ ...diagnostic }));
	}

	getDiagnostics(): PluginEventGatewayDiagnostic[] {
		return this.listDiagnostics();
	}

	getSubscriptionDiagnostics(): PluginEventSubscriptionDiagnostics[] {
		return this.listSubscriptionDiagnostics();
	}

	listSubscriptionDiagnostics(): PluginEventSubscriptionDiagnostics[] {
		return this.dispatcher
			.getDiagnostics()
			.filter((item) => this.ownedSubscriptions.has(item.subscriptionId))
			.map((item) => ({
				subscriptionId: item.subscriptionId,
				pluginId:
					"id" in item.identity.subject ? (item.identity.subject.id ?? "unknown") : "unknown",
				runtimeId: item.identity.runtime.id,
				generation: item.identity.runtime.generation,
				mode: "live",
				status: item.status,
				queueEvents: item.queueEvents,
				queueBytes: item.queueBytes,
				delivered: item.delivered,
				dropped: item.dropped,
				coalesced: item.coalesced,
				lastDeliveryAt: item.lastDeliveryAt,
			}));
	}

	revokePlugin(pluginId: string, reason = "plugin-disabled"): number {
		for (const item of this.dispatcher.getDiagnostics()) {
			if ("id" in item.identity.subject && item.identity.subject.id === pluginId) {
				integrationAuthorizationService.invalidateAuthority(item.identity.authorityId);
			}
		}
		const revoked = this.dispatcher.invalidateSubject({ type: "plugin", id: pluginId }, reason);
		this.pruneOwnedSubscriptions();
		return revoked;
	}

	disablePlugin(pluginId: string): number {
		return this.revokePlugin(pluginId, "plugin-disabled");
	}

	revokeSession(sessionId: string): number {
		const revoked = this.dispatcher.invalidateSession(sessionId, "session-disabled");
		this.pruneOwnedSubscriptions();
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
		if (!runtimeId) return this.revokePlugin(pluginId, "runtime-generation-invalidated");
		integrationAuthorizationService.invalidateRuntime({ type: "plugin", id: runtimeId });
		const revoked = this.dispatcher.invalidateRuntime(
			{ type: "plugin", id: runtimeId, generation },
			undefined,
			"runtime-generation-invalidated",
		);
		this.pruneOwnedSubscriptions();
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
		for (const id of [...this.ownedSubscriptions]) this.unsubscribe(id, "gateway-closed");
		if (this.ownsDispatcher) this.dispatcher.clear("gateway-closed");
	}

	private createLegacyDispatcher(
		options: PluginEventGatewayOptions,
	): IntegrationEventDispatcher<PublicEvent> {
		const broker = this.capabilityBroker as PluginCapabilityBroker;
		return new IntegrationEventDispatcher<PublicEvent>({
			authorize: async (request) => {
				const plugin = principalFromAuthorizationRequest(request);
				if (request.phase === "deliver" && broker.isRuntimeActive) {
					if (!(await broker.isRuntimeActive(plugin))) {
						return { allowed: false, revoke: true, reason: "runtime-disabled" };
					}
				}
				const authorize = broker.authorize ?? broker.check;
				if (!authorize)
					return { allowed: false, revoke: true, reason: "capability-broker-missing" };
				for (const topic of request.topics as PublicEventTopic[]) {
					const result = asDecision(
						await authorize({
							phase: request.phase,
							plugin,
							capability: "event.subscribe",
							topic,
							scope: invocationFromResourceScope(request.scope),
							event: request.event,
						}),
					);
					if (!result.allowed) return { ...result, revoke: result.revoke ?? false };
				}
				return { allowed: true };
			},
			audit: (record) => this.auditLegacyRecord(record),
			controlEvent: gatewayControlEvent,
			defaultQueue: {
				maxEvents: this.defaultQueueEvents,
				maxBytes: this.defaultQueueBytes,
				maxRatePerSecond: this.defaultRatePerSecond,
			},
			maxSubscriptions: options.maxSubscriptions ?? DEFAULT_MAX_SUBSCRIPTIONS,
			maxDispatchesPerSecond: options.maxDispatchesPerSecond ?? DEFAULT_MAX_DISPATCHES_PER_SECOND,
			maxConcurrentDispatches: options.maxConcurrentDispatches ?? DEFAULT_MAX_CONCURRENT_DISPATCHES,
			authorityValidationTtlMs: 0,
		});
	}

	private async processInternalEvent(event: NarraForkEvent): Promise<void> {
		const context = { eventId: `evt_${generateId()}`, occurredAt: new Date().toISOString() };
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
			this.recordDiagnostic({
				code: error instanceof z.ZodError ? "INVALID_PUBLIC_EVENT" : "MAPPER_FAILED",
				message:
					error instanceof z.ZodError
						? "Mapper produced an invalid public event"
						: "Public event mapper failed",
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
		this.dispatcher.publish(mapped);
	}

	private async auditLegacyRecord(record: IntegrationEventAuditRecord): Promise<void> {
		const pluginId = "id" in record.identity.subject ? record.identity.subject.id : undefined;
		if (!pluginId) return;
		if (record.action === "overflow") {
			this.recordDiagnostic({
				code: "QUEUE_OVERFLOW",
				message: "Subscription queue overflowed",
				at: now(),
				pluginId,
				subscriptionId: record.subscriptionId,
				count: record.queueBytes,
			});
		}
		await (this.capabilityBroker?.audit ?? this.capabilityBroker?.recordAudit)?.({
			pluginId,
			runtimeId: record.identity.runtime.id,
			generation: record.identity.runtime.generation,
			subscriptionId: record.subscriptionId,
			methodId:
				record.action === "subscribe"
					? "events.subscribe"
					: record.action === "unsubscribe" || record.action === "revoke"
						? "events.unsubscribe"
						: "events.deliver",
			capability: "event.subscribe",
			topic: record.topic as PublicEventTopic | undefined,
			outcome:
				record.action === "overflow"
					? "overflow"
					: record.outcome === "denied"
						? "denied"
						: record.outcome === "failed"
							? "failed"
							: "succeeded",
			requestBytes: 0,
			responseBytes: record.queueBytes ?? 0,
		});
	}

	private refreshOverflowDiagnostics(): void {
		for (const item of this.listSubscriptionDiagnostics()) {
			if (item.status !== "overflowed") continue;
			if (
				this.diagnostics.some(
					(diagnostic) =>
						diagnostic.code === "QUEUE_OVERFLOW" &&
						diagnostic.subscriptionId === item.subscriptionId,
				)
			) {
				continue;
			}
			this.recordDiagnostic({
				code: "QUEUE_OVERFLOW",
				message: "Subscription queue overflowed",
				at: now(),
				pluginId: item.pluginId,
				subscriptionId: item.subscriptionId,
				count: item.queueBytes,
			});
		}
	}

	private pruneOwnedSubscriptions(): void {
		const active = new Set(this.dispatcher.getDiagnostics().map((item) => item.subscriptionId));
		for (const id of this.ownedSubscriptions) {
			if (!active.has(id)) this.ownedSubscriptions.delete(id);
		}
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

	private recordDiagnostic(diagnostic: PluginEventGatewayDiagnostic): void {
		this.diagnostics.push({ ...diagnostic, message: diagnostic.message.slice(0, 240) });
		if (this.diagnostics.length > MAX_DIAGNOSTICS) {
			this.diagnostics.splice(0, this.diagnostics.length - MAX_DIAGNOSTICS);
		}
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

/** Default host-owned adapter over the shared IntegrationEventDispatcher. */
export const pluginEventGateway = new PluginEventGateway({ hotReloadGuard: true });
