import type { PrincipalRef } from "@shared/integrations/principals";
import type { ResourceScope } from "@shared/integrations/resources";
import { generateId } from "../../id";
import type { RuntimeRef } from "./types";

export const INTEGRATION_EVENT_DEFAULT_QUEUE_EVENTS = 100;
export const INTEGRATION_EVENT_DEFAULT_QUEUE_BYTES = 256 * 1024;
export const INTEGRATION_EVENT_DEFAULT_RATE_PER_SECOND = 100;
export const INTEGRATION_EVENT_MAX_QUEUE_EVENTS = 1_000;
export const INTEGRATION_EVENT_MAX_QUEUE_BYTES = 2 * 1024 * 1024;
export const INTEGRATION_EVENT_MAX_EVENT_BYTES = 256 * 1024;
export const INTEGRATION_EVENT_MAX_TOPICS = 32;
export const INTEGRATION_EVENT_MAX_SUBSCRIPTIONS = 2_048;
const CONTROL_QUEUE_EVENTS = 4;

export interface IntegrationDispatchEvent {
	eventId: string;
	topic: string;
	occurredAt: string | number;
	eventClass?: string;
	resource?: unknown;
	deliverySeq?: number;
	[key: string]: unknown;
}

export interface IntegrationSubscriptionIdentity {
	authorityId: string;
	authorityRevision: number;
	runtime: RuntimeRef;
	subject: PrincipalRef;
	connectionId: string;
	credentialId?: string;
	sessionId?: string;
}

export interface IntegrationEventAuthorizationRequest<TEvent extends IntegrationDispatchEvent> {
	phase: "subscribe" | "deliver";
	identity: IntegrationSubscriptionIdentity;
	topics: readonly string[];
	scope: ResourceScope;
	boundScopes: readonly ResourceScope[];
	permittedCapabilities?: readonly string[];
	event?: TEvent;
}

export interface IntegrationEventAuthorizationDecision {
	allowed: boolean;
	revoke?: boolean;
	reason?: string;
	authorityRevision?: number;
}

export interface IntegrationEventAuditRecord {
	action: "subscribe" | "update" | "unsubscribe" | "revoke" | "overflow" | "delivery_failure";
	outcome: "allowed" | "denied" | "succeeded" | "failed";
	subscriptionId?: string;
	identity: IntegrationSubscriptionIdentity;
	topic?: string;
	scope?: ResourceScope;
	reason?: string;
	queueEvents?: number;
	queueBytes?: number;
}

export interface IntegrationEventQueueLimits {
	maxEvents?: number;
	maxBytes?: number;
	maxRatePerSecond?: number;
}

export interface IntegrationEventSubscriptionInput<TEvent extends IntegrationDispatchEvent> {
	identity: IntegrationSubscriptionIdentity;
	topics: readonly string[];
	scope: ResourceScope;
	boundScopes: readonly ResourceScope[];
	permittedCapabilities?: readonly string[];
	matchesEvent?: (event: TEvent) => boolean;
	redact?: (event: TEvent) => TEvent | null | Promise<TEvent | null>;
	onEvent?: (event: TEvent) => void | Promise<void>;
	onRemoved?: (reason: string, status: "cancelled" | "revoked") => void;
	queue?: IntegrationEventQueueLimits;
}

export interface IntegrationEventSubscriptionUpdate<TEvent extends IntegrationDispatchEvent> {
	topics?: readonly string[];
	scope?: ResourceScope;
	boundScopes?: readonly ResourceScope[];
	matchesEvent?: (event: TEvent) => boolean;
	redact?: (event: TEvent) => TEvent | null | Promise<TEvent | null>;
	onEvent?: (event: TEvent) => void | Promise<void>;
	onRemoved?: (reason: string, status: "cancelled" | "revoked") => void;
	queue?: IntegrationEventQueueLimits;
}

export interface IntegrationEventSubscriptionDiagnostics {
	subscriptionId: string;
	identity: IntegrationSubscriptionIdentity;
	topics: string[];
	status: "active" | "overflowed" | "revoked" | "cancelled";
	queueEvents: number;
	queueBytes: number;
	delivered: number;
	dropped: number;
	coalesced: number;
	lastDeliveryAt?: string;
}

export interface IntegrationEventDispatcherOptions<TEvent extends IntegrationDispatchEvent> {
	authorize: (
		request: IntegrationEventAuthorizationRequest<TEvent>,
	) =>
		| boolean
		| IntegrationEventAuthorizationDecision
		| Promise<boolean | IntegrationEventAuthorizationDecision>;
	audit?: (record: IntegrationEventAuditRecord) => void | Promise<void>;
	controlEvent?: (
		topic: "narrafork.events.overflow" | "narrafork.events.resync_required",
		subscriptionId: string,
		data: Readonly<Record<string, string | number | boolean>>,
	) => TEvent;
	defaultQueue?: Required<IntegrationEventQueueLimits>;
	maxSubscriptions?: number;
	maxConcurrentDispatches?: number;
	maxDispatchesPerSecond?: number;
	authorityValidationTtlMs?: number;
}

interface QueueItem<TEvent> {
	event: TEvent;
	bytes: number;
	coalesceKey?: string;
	control: boolean;
}

interface Subscription<TEvent extends IntegrationDispatchEvent> {
	id: string;
	identity: IntegrationSubscriptionIdentity;
	topics: Set<string>;
	scope: ResourceScope;
	boundScopes: ResourceScope[];
	permittedCapabilities?: string[];
	matchesEvent?: (event: TEvent) => boolean;
	redact?: (event: TEvent) => TEvent | null | Promise<TEvent | null>;
	onEvent?: (event: TEvent) => void | Promise<void>;
	onRemoved?: (reason: string, status: "cancelled" | "revoked") => void;
	limits: Required<IntegrationEventQueueLimits>;
	queue: QueueItem<TEvent>[];
	controlQueue: QueueItem<TEvent>[];
	queueBytes: number;
	deliverySeq: number;
	nextDeliveryAt: number;
	pumpScheduled: boolean;
	pumpTimer?: ReturnType<typeof setTimeout>;
	status: IntegrationEventSubscriptionDiagnostics["status"];
	overflowNotified: boolean;
	delivered: number;
	dropped: number;
	coalesced: number;
	lastDeliveryAt?: string;
	lastAuthorizedAt: number;
}

function normalizeDecision(
	value: boolean | IntegrationEventAuthorizationDecision,
): IntegrationEventAuthorizationDecision {
	return typeof value === "boolean" ? { allowed: value } : value;
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
	if (value === undefined) return fallback;
	return Math.max(1, Math.min(maximum, Math.floor(value)));
}

function boundedRate(value: number | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	return Math.max(0.1, Math.min(10_000, value));
}

function mapAdd(index: Map<string, Set<string>>, key: string | undefined, id: string): void {
	if (!key) return;
	let values = index.get(key);
	if (!values) {
		values = new Set();
		index.set(key, values);
	}
	values.add(id);
}

function mapDelete(index: Map<string, Set<string>>, key: string | undefined, id: string): void {
	if (!key) return;
	const values = index.get(key);
	if (!values) return;
	values.delete(id);
	if (values.size === 0) index.delete(key);
}

function runtimeKey(runtime: RuntimeRef): string {
	return `${runtime.type}:${runtime.id}:${runtime.generation}`;
}

function runtimeBaseKey(runtime: Pick<RuntimeRef, "type" | "id">): string {
	return `${runtime.type}:${runtime.id}`;
}

function subjectKey(subject: PrincipalRef): string {
	return `${subject.type}:${"id" in subject ? (subject.id ?? "") : ""}`;
}

function encodedBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function coalesceKey(event: IntegrationDispatchEvent): string | undefined {
	if (event.eventClass !== "state" && event.eventClass !== "progress") return undefined;
	const resource = event.resource as { type?: unknown; id?: unknown } | undefined;
	return `${event.topic}:${String(resource?.type ?? "none")}:${String(resource?.id ?? "none")}`;
}

function assertIdentity(identity: IntegrationSubscriptionIdentity): void {
	if (!identity.authorityId || identity.authorityId.length > 256)
		throw new Error("INVALID_AUTHORITY");
	if (!Number.isSafeInteger(identity.authorityRevision) || identity.authorityRevision < 0) {
		throw new Error("INVALID_AUTHORITY_REVISION");
	}
	if (!identity.connectionId || identity.connectionId.length > 256) {
		throw new Error("INVALID_CONNECTION");
	}
}

function normalizeTopics(topics: readonly string[]): string[] {
	const normalized = [...new Set(topics.map((topic) => topic.trim()))];
	if (
		normalized.length === 0 ||
		normalized.length > INTEGRATION_EVENT_MAX_TOPICS ||
		normalized.some((topic) => !topic || topic.length > 200)
	) {
		throw new Error("INVALID_TOPICS");
	}
	return normalized;
}

export class IntegrationEventDispatcher<TEvent extends IntegrationDispatchEvent> {
	readonly #authorize: IntegrationEventDispatcherOptions<TEvent>["authorize"];
	readonly #audit?: IntegrationEventDispatcherOptions<TEvent>["audit"];
	readonly #controlEvent?: IntegrationEventDispatcherOptions<TEvent>["controlEvent"];
	readonly #defaults: Required<IntegrationEventQueueLimits>;
	readonly #maxSubscriptions: number;
	readonly #maxConcurrentDispatches: number;
	readonly #maxDispatchesPerSecond: number;
	readonly #authorityValidationTtlMs: number;
	readonly #subscriptions = new Map<string, Subscription<TEvent>>();
	readonly #byTopic = new Map<string, Set<string>>();
	readonly #byAuthority = new Map<string, Set<string>>();
	readonly #byRuntime = new Map<string, Set<string>>();
	readonly #byRuntimeBase = new Map<string, Set<string>>();
	readonly #byConnection = new Map<string, Set<string>>();
	readonly #byCredential = new Map<string, Set<string>>();
	readonly #bySession = new Map<string, Set<string>>();
	readonly #bySubject = new Map<string, Set<string>>();
	#dispatchesInFlight = 0;
	#dispatchWindowStartedAt = Date.now();
	#dispatchesInWindow = 0;

	constructor(options: IntegrationEventDispatcherOptions<TEvent>) {
		this.#authorize = options.authorize;
		this.#audit = options.audit;
		this.#controlEvent = options.controlEvent;
		const defaults = options.defaultQueue ?? {
			maxEvents: INTEGRATION_EVENT_DEFAULT_QUEUE_EVENTS,
			maxBytes: INTEGRATION_EVENT_DEFAULT_QUEUE_BYTES,
			maxRatePerSecond: INTEGRATION_EVENT_DEFAULT_RATE_PER_SECOND,
		};
		this.#defaults = {
			maxEvents: boundedInteger(
				defaults.maxEvents,
				INTEGRATION_EVENT_DEFAULT_QUEUE_EVENTS,
				INTEGRATION_EVENT_MAX_QUEUE_EVENTS,
			),
			maxBytes: boundedInteger(
				defaults.maxBytes,
				INTEGRATION_EVENT_DEFAULT_QUEUE_BYTES,
				INTEGRATION_EVENT_MAX_QUEUE_BYTES,
			),
			maxRatePerSecond: boundedRate(
				defaults.maxRatePerSecond,
				INTEGRATION_EVENT_DEFAULT_RATE_PER_SECOND,
			),
		};
		this.#maxSubscriptions = boundedInteger(
			options.maxSubscriptions,
			INTEGRATION_EVENT_MAX_SUBSCRIPTIONS,
			INTEGRATION_EVENT_MAX_SUBSCRIPTIONS,
		);
		this.#maxConcurrentDispatches = boundedInteger(options.maxConcurrentDispatches, 64, 512);
		this.#maxDispatchesPerSecond = boundedInteger(options.maxDispatchesPerSecond, 2_000, 20_000);
		this.#authorityValidationTtlMs = Math.max(
			0,
			Math.min(30_000, Math.floor(options.authorityValidationTtlMs ?? 1_000)),
		);
	}

	async register(input: IntegrationEventSubscriptionInput<TEvent>): Promise<string> {
		if (this.#subscriptions.size >= this.#maxSubscriptions) {
			throw new Error("SUBSCRIPTION_QUOTA_EXCEEDED");
		}
		assertIdentity(input.identity);
		const topics = normalizeTopics(input.topics);
		const decision = await this.#authorizeRequest(
			"subscribe",
			input.identity,
			topics,
			input.scope,
			input.boundScopes,
			input.permittedCapabilities,
		);
		if (
			!decision.allowed ||
			(decision.authorityRevision !== undefined &&
				decision.authorityRevision !== input.identity.authorityRevision)
		) {
			void this.#recordAudit({
				action: "subscribe",
				outcome: "denied",
				identity: input.identity,
				scope: input.scope,
				reason: decision.reason ?? "authorization-denied",
			});
			throw new Error("PERMISSION_DENIED");
		}
		const id = `sub_${generateId()}`;
		const sub: Subscription<TEvent> = {
			id,
			identity: structuredClone(input.identity),
			topics: new Set(topics),
			scope: structuredClone(input.scope),
			boundScopes: structuredClone([...input.boundScopes]),
			permittedCapabilities: input.permittedCapabilities
				? [...input.permittedCapabilities]
				: undefined,
			matchesEvent: input.matchesEvent,
			redact: input.redact,
			onEvent: input.onEvent,
			onRemoved: input.onRemoved,
			limits: this.#normalizeLimits(input.queue),
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
			lastAuthorizedAt: Date.now(),
		};
		this.#subscriptions.set(id, sub);
		this.#index(sub);
		void this.#recordAudit({
			action: "subscribe",
			outcome: "succeeded",
			subscriptionId: id,
			identity: sub.identity,
			scope: sub.scope,
		});
		return id;
	}

	async update(
		subscriptionId: string,
		update: IntegrationEventSubscriptionUpdate<TEvent>,
	): Promise<boolean> {
		const sub = this.#subscriptions.get(subscriptionId);
		if (!sub) return false;
		const topics = update.topics ? normalizeTopics(update.topics) : [...sub.topics];
		const scope = update.scope ?? sub.scope;
		const boundScopes = update.boundScopes ?? sub.boundScopes;
		const decision = await this.#authorizeRequest(
			"subscribe",
			sub.identity,
			topics,
			scope,
			boundScopes,
			sub.permittedCapabilities,
		);
		if (
			!decision.allowed ||
			(decision.authorityRevision !== undefined &&
				decision.authorityRevision !== sub.identity.authorityRevision)
		) {
			this.remove(subscriptionId, decision.reason ?? "authorization-denied", "revoked");
			return false;
		}
		this.#unindex(sub);
		sub.topics = new Set(topics);
		sub.scope = structuredClone(scope);
		sub.boundScopes = structuredClone([...boundScopes]);
		sub.matchesEvent = update.matchesEvent ?? sub.matchesEvent;
		sub.redact = update.redact ?? sub.redact;
		sub.onEvent = update.onEvent ?? sub.onEvent;
		sub.onRemoved = update.onRemoved ?? sub.onRemoved;
		sub.limits = update.queue ? this.#normalizeLimits(update.queue) : sub.limits;
		sub.queue.length = 0;
		sub.controlQueue.length = 0;
		sub.queueBytes = 0;
		sub.status = "active";
		sub.overflowNotified = false;
		sub.lastAuthorizedAt = Date.now();
		this.#index(sub);
		void this.#recordAudit({
			action: "update",
			outcome: "succeeded",
			subscriptionId,
			identity: sub.identity,
			scope: sub.scope,
		});
		return true;
	}

	remove(
		subscriptionId: string,
		reason = "cancelled",
		status: "cancelled" | "revoked" = "cancelled",
	): boolean {
		const sub = this.#subscriptions.get(subscriptionId);
		if (!sub) return false;
		this.#subscriptions.delete(subscriptionId);
		this.#unindex(sub);
		if (sub.pumpTimer) clearTimeout(sub.pumpTimer);
		sub.status = status;
		sub.queue.length = 0;
		sub.controlQueue.length = 0;
		sub.queueBytes = 0;
		try {
			sub.onRemoved?.(reason, status);
		} catch {
			// Adapter cleanup failures cannot resurrect a removed subscription.
		}
		void this.#recordAudit({
			action: status === "revoked" ? "revoke" : "unsubscribe",
			outcome: "succeeded",
			subscriptionId,
			identity: sub.identity,
			scope: sub.scope,
			reason,
		});
		return true;
	}

	publish(event: TEvent): number {
		const ids = [...(this.#byTopic.get(event.topic) ?? [])];
		for (const id of ids) {
			const sub = this.#subscriptions.get(id);
			if (sub) void this.#dispatch(sub, event);
		}
		return ids.length;
	}

	poll(subscriptionId: string, limit = 100): TEvent[] {
		const sub = this.#subscriptions.get(subscriptionId);
		if (!sub) return [];
		const bounded = Math.max(
			1,
			Math.min(Math.floor(limit), sub.limits.maxEvents + CONTROL_QUEUE_EVENTS),
		);
		const result: TEvent[] = [];
		while (result.length < bounded && sub.controlQueue.length > 0) {
			const item = sub.controlQueue.shift();
			if (item) result.push(item.event);
		}
		while (result.length < bounded && sub.queue.length > 0) {
			const item = sub.queue.shift();
			if (!item) break;
			sub.queueBytes = Math.max(0, sub.queueBytes - item.bytes);
			result.push(item.event);
		}
		return result;
	}

	invalidateAuthority(
		authorityId: string,
		currentRevision?: number,
		reason = "authority-invalidated",
	): number {
		return this.#removeIndexed(this.#byAuthority, authorityId, reason, (sub) =>
			currentRevision === undefined ? true : sub.identity.authorityRevision !== currentRevision,
		);
	}

	revokeAuthority(authorityId: string, reason = "authority-revoked"): number {
		return this.#removeIndexed(this.#byAuthority, authorityId, reason);
	}

	invalidateRuntime(
		runtime: Pick<RuntimeRef, "type" | "id"> & { generation?: number },
		replacementGeneration?: number,
		reason = "runtime-invalidated",
	): number {
		if (runtime.generation !== undefined) {
			return this.#removeIndexed(
				this.#byRuntime,
				runtimeKey({ ...runtime, generation: runtime.generation }),
				reason,
			);
		}
		return this.#removeIndexed(this.#byRuntimeBase, runtimeBaseKey(runtime), reason, (sub) =>
			replacementGeneration === undefined
				? true
				: sub.identity.runtime.generation !== replacementGeneration,
		);
	}

	invalidateConnection(connectionId: string, reason = "connection-closed"): number {
		return this.#removeIndexed(this.#byConnection, connectionId, reason);
	}

	invalidateCredential(credentialId: string, reason = "credential-invalidated"): number {
		return this.#removeIndexed(this.#byCredential, credentialId, reason);
	}

	invalidateSession(sessionId: string, reason = "session-invalidated"): number {
		return this.#removeIndexed(this.#bySession, sessionId, reason);
	}

	invalidateSubject(subject: PrincipalRef, reason = "subject-invalidated"): number {
		return this.#removeIndexed(this.#bySubject, subjectKey(subject), reason);
	}

	getDiagnostics(): IntegrationEventSubscriptionDiagnostics[] {
		return [...this.#subscriptions.values()].map((sub) => ({
			subscriptionId: sub.id,
			identity: structuredClone(sub.identity),
			topics: [...sub.topics],
			status: sub.status,
			queueEvents: sub.queue.length + sub.controlQueue.length,
			queueBytes: sub.queueBytes,
			delivered: sub.delivered,
			dropped: sub.dropped,
			coalesced: sub.coalesced,
			lastDeliveryAt: sub.lastDeliveryAt,
		}));
	}

	get size(): number {
		return this.#subscriptions.size;
	}

	clear(reason = "dispatcher-closed"): void {
		for (const id of [...this.#subscriptions.keys()]) this.remove(id, reason, "revoked");
	}

	async #dispatch(sub: Subscription<TEvent>, source: TEvent): Promise<void> {
		if (!this.#subscriptions.has(sub.id) || sub.status !== "active") return;
		if (sub.matchesEvent && !sub.matchesEvent(source)) return;
		if (!this.#acquireDispatchSlot()) {
			this.#triggerOverflow(sub, 0, "dispatcher_backpressure");
			return;
		}
		try {
			const now = Date.now();
			if (now - sub.lastAuthorizedAt >= this.#authorityValidationTtlMs) {
				const decision = await this.#authorizeRequest(
					"deliver",
					sub.identity,
					[source.topic],
					sub.scope,
					sub.boundScopes,
					sub.permittedCapabilities,
					source,
				);
				if (
					!decision.allowed ||
					(decision.authorityRevision !== undefined &&
						decision.authorityRevision !== sub.identity.authorityRevision)
				) {
					if (decision.revoke !== false) {
						this.remove(sub.id, decision.reason ?? "authorization-denied", "revoked");
					} else {
						sub.dropped += 1;
					}
					return;
				}
				sub.lastAuthorizedAt = now;
			}
			const redacted = sub.redact ? await sub.redact(source) : source;
			if (!redacted || !this.#subscriptions.has(sub.id)) return;
			const event = { ...redacted, deliverySeq: ++sub.deliverySeq } as TEvent;
			this.#enqueue(sub, event, false);
			this.#schedulePump(sub);
		} catch {
			sub.dropped += 1;
			void this.#recordAudit({
				action: "delivery_failure",
				outcome: "failed",
				subscriptionId: sub.id,
				identity: sub.identity,
				scope: sub.scope,
				topic: source.topic,
			});
		} finally {
			this.#releaseDispatchSlot();
		}
	}

	#enqueue(sub: Subscription<TEvent>, event: TEvent, control: boolean): void {
		let bytes: number;
		try {
			bytes = encodedBytes(event);
		} catch {
			this.#triggerOverflow(sub, INTEGRATION_EVENT_MAX_EVENT_BYTES + 1, "serialization_failed");
			return;
		}
		if (control) {
			if (sub.controlQueue.length >= CONTROL_QUEUE_EVENTS) sub.controlQueue.shift();
			sub.controlQueue.push({ event, bytes, control: true });
			return;
		}
		if (sub.status === "overflowed") {
			sub.dropped += 1;
			return;
		}
		const key = coalesceKey(event);
		if (key) {
			const index = sub.queue.findIndex((item) => item.coalesceKey === key);
			if (index >= 0) {
				const previous = sub.queue[index];
				if (
					bytes > INTEGRATION_EVENT_MAX_EVENT_BYTES ||
					sub.queueBytes - previous.bytes + bytes > sub.limits.maxBytes
				) {
					this.#triggerOverflow(sub, bytes, "queue_overflow");
					return;
				}
				sub.queue[index] = { event, bytes, coalesceKey: key, control: false };
				sub.queueBytes += bytes - previous.bytes;
				sub.coalesced += 1;
				return;
			}
		}
		if (
			bytes > INTEGRATION_EVENT_MAX_EVENT_BYTES ||
			sub.queue.length >= sub.limits.maxEvents ||
			sub.queueBytes + bytes > sub.limits.maxBytes
		) {
			this.#triggerOverflow(sub, bytes, "queue_overflow");
			return;
		}
		sub.queue.push({ event, bytes, coalesceKey: key, control: false });
		sub.queueBytes += bytes;
	}

	#triggerOverflow(sub: Subscription<TEvent>, attemptedBytes: number, reason: string): void {
		if (!this.#subscriptions.has(sub.id)) return;
		sub.dropped += 1;
		sub.status = "overflowed";
		sub.queue.length = 0;
		sub.queueBytes = 0;
		void this.#recordAudit({
			action: "overflow",
			outcome: "failed",
			subscriptionId: sub.id,
			identity: sub.identity,
			scope: sub.scope,
			reason,
			queueEvents: sub.limits.maxEvents,
			queueBytes: attemptedBytes,
		});
		if (!this.#controlEvent || sub.overflowNotified) return;
		sub.overflowNotified = true;
		this.#enqueue(
			sub,
			this.#controlEvent("narrafork.events.overflow", sub.id, { dropped: sub.dropped }),
			true,
		);
		this.#enqueue(
			sub,
			this.#controlEvent("narrafork.events.resync_required", sub.id, { reason }),
			true,
		);
		this.#schedulePump(sub);
	}

	#schedulePump(sub: Subscription<TEvent>): void {
		if (!sub.onEvent || sub.pumpScheduled || !this.#subscriptions.has(sub.id)) return;
		sub.pumpScheduled = true;
		queueMicrotask(() => {
			sub.pumpScheduled = false;
			void this.#pump(sub);
		});
	}

	async #pump(sub: Subscription<TEvent>): Promise<void> {
		if (!sub.onEvent || !this.#subscriptions.has(sub.id)) return;
		const item = sub.controlQueue.shift() ?? this.#takeRateLimitedItem(sub);
		if (!item) return;
		if (!item.control) sub.queueBytes = Math.max(0, sub.queueBytes - item.bytes);
		try {
			await sub.onEvent(item.event);
			sub.delivered += 1;
			sub.lastDeliveryAt = new Date().toISOString();
		} catch {
			sub.dropped += 1;
			void this.#recordAudit({
				action: "delivery_failure",
				outcome: "failed",
				subscriptionId: sub.id,
				identity: sub.identity,
				scope: sub.scope,
				topic: item.event.topic,
			});
			this.remove(sub.id, "delivery-failed", "revoked");
			return;
		}
		if (sub.controlQueue.length > 0 || sub.queue.length > 0) this.#schedulePump(sub);
	}

	#takeRateLimitedItem(sub: Subscription<TEvent>): QueueItem<TEvent> | undefined {
		const item = sub.queue[0];
		if (!item) return undefined;
		const now = Date.now();
		if (now < sub.nextDeliveryAt) {
			if (!sub.pumpTimer) {
				sub.pumpTimer = setTimeout(
					() => {
						sub.pumpTimer = undefined;
						this.#schedulePump(sub);
					},
					Math.max(1, sub.nextDeliveryAt - now),
				);
			}
			return undefined;
		}
		sub.queue.shift();
		sub.nextDeliveryAt = now + 1_000 / sub.limits.maxRatePerSecond;
		return item;
	}

	#normalizeLimits(
		queue: IntegrationEventQueueLimits | undefined,
	): Required<IntegrationEventQueueLimits> {
		return {
			maxEvents: Math.min(
				boundedInteger(
					queue?.maxEvents,
					this.#defaults.maxEvents,
					INTEGRATION_EVENT_MAX_QUEUE_EVENTS,
				),
				this.#defaults.maxEvents,
			),
			maxBytes: Math.min(
				boundedInteger(queue?.maxBytes, this.#defaults.maxBytes, INTEGRATION_EVENT_MAX_QUEUE_BYTES),
				this.#defaults.maxBytes,
			),
			maxRatePerSecond: Math.min(
				boundedRate(queue?.maxRatePerSecond, this.#defaults.maxRatePerSecond),
				this.#defaults.maxRatePerSecond,
			),
		};
	}

	async #authorizeRequest(
		phase: "subscribe" | "deliver",
		identity: IntegrationSubscriptionIdentity,
		topics: readonly string[],
		scope: ResourceScope,
		boundScopes: readonly ResourceScope[],
		permittedCapabilities?: readonly string[],
		event?: TEvent,
	): Promise<IntegrationEventAuthorizationDecision> {
		try {
			return normalizeDecision(
				await this.#authorize({
					phase,
					identity,
					topics,
					scope,
					boundScopes,
					permittedCapabilities,
					event,
				}),
			);
		} catch {
			return { allowed: false, revoke: true, reason: "authorization-failed" };
		}
	}

	#index(sub: Subscription<TEvent>): void {
		for (const topic of sub.topics) mapAdd(this.#byTopic, topic, sub.id);
		mapAdd(this.#byAuthority, sub.identity.authorityId, sub.id);
		mapAdd(this.#byRuntime, runtimeKey(sub.identity.runtime), sub.id);
		mapAdd(this.#byRuntimeBase, runtimeBaseKey(sub.identity.runtime), sub.id);
		mapAdd(this.#byConnection, sub.identity.connectionId, sub.id);
		mapAdd(this.#byCredential, sub.identity.credentialId, sub.id);
		mapAdd(this.#bySession, sub.identity.sessionId, sub.id);
		mapAdd(this.#bySubject, subjectKey(sub.identity.subject), sub.id);
	}

	#unindex(sub: Subscription<TEvent>): void {
		for (const topic of sub.topics) mapDelete(this.#byTopic, topic, sub.id);
		mapDelete(this.#byAuthority, sub.identity.authorityId, sub.id);
		mapDelete(this.#byRuntime, runtimeKey(sub.identity.runtime), sub.id);
		mapDelete(this.#byRuntimeBase, runtimeBaseKey(sub.identity.runtime), sub.id);
		mapDelete(this.#byConnection, sub.identity.connectionId, sub.id);
		mapDelete(this.#byCredential, sub.identity.credentialId, sub.id);
		mapDelete(this.#bySession, sub.identity.sessionId, sub.id);
		mapDelete(this.#bySubject, subjectKey(sub.identity.subject), sub.id);
	}

	#removeIndexed(
		index: Map<string, Set<string>>,
		key: string,
		reason: string,
		predicate: (sub: Subscription<TEvent>) => boolean = () => true,
	): number {
		let removed = 0;
		for (const id of [...(index.get(key) ?? [])]) {
			const sub = this.#subscriptions.get(id);
			if (sub && predicate(sub) && this.remove(id, reason, "revoked")) removed += 1;
		}
		return removed;
	}

	#acquireDispatchSlot(): boolean {
		const now = Date.now();
		if (now - this.#dispatchWindowStartedAt >= 1_000) {
			this.#dispatchWindowStartedAt = now;
			this.#dispatchesInWindow = 0;
		}
		if (
			this.#dispatchesInWindow >= this.#maxDispatchesPerSecond ||
			this.#dispatchesInFlight >= this.#maxConcurrentDispatches
		) {
			return false;
		}
		this.#dispatchesInWindow += 1;
		this.#dispatchesInFlight += 1;
		return true;
	}

	#releaseDispatchSlot(): void {
		this.#dispatchesInFlight = Math.max(0, this.#dispatchesInFlight - 1);
	}

	async #recordAudit(record: IntegrationEventAuditRecord): Promise<void> {
		try {
			await this.#audit?.(record);
		} catch {
			// Audit is best-effort and must not alter authorization or delivery results.
		}
	}
}
