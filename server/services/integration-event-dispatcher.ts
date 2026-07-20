import type { CanonicalCapabilityId } from "@shared/integrations/capabilities";
import { generateId } from "../lib/id";
import {
	type IntegrationEventAuditRecord,
	type IntegrationEventAuthorizationDecision,
	type IntegrationEventAuthorizationRequest,
	IntegrationEventDispatcher,
} from "../lib/integrations/kernel";
import type { JsonValue, PublicEvent } from "../lib/plugins/protocol";
import { publicEventSchema } from "../lib/plugins/protocol";
import { integrationAuditService } from "./integration-audit-service";
import { setIntegrationAuthorityInvalidationListener } from "./integration-authority-invalidation";
import { integrationAuthorizationService } from "./integration-authorization-service";

function controlEvent(
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
		data: { subscriptionId, ...data } as Record<string, JsonValue>,
		redaction: "public",
		resyncHint: { queryId: "narrafork.events.resync_required" },
	});
}

async function authorizePublicEvent(
	request: IntegrationEventAuthorizationRequest<PublicEvent>,
): Promise<IntegrationEventAuthorizationDecision> {
	if (request.permittedCapabilities && !request.permittedCapabilities.includes("event.subscribe")) {
		return { allowed: false, revoke: true, reason: "event-subscribe-scope-missing" };
	}
	for (const topic of request.topics) {
		const result = await integrationAuthorizationService.authorize({
			authorityId: request.identity.authorityId,
			authorityRevision: request.identity.authorityRevision,
			operation: request.phase === "subscribe" ? "event.subscribe" : "event.deliver",
			capability: "event.subscribe",
			scope: request.scope,
			resource: { type: "event", id: topic },
			boundScopes: [...request.boundScopes],
			runtime: request.identity.runtime,
			permittedCapabilities: request.permittedCapabilities
				? ([...request.permittedCapabilities] as CanonicalCapabilityId[])
				: undefined,
			constraints: { topics: [topic] },
			resourceContainerScope: request.scope,
		});
		if (!result.decision.allowed) {
			return {
				allowed: false,
				revoke: true,
				reason: result.decision.code,
				authorityRevision: result.authorityRevision,
			};
		}
	}
	return {
		allowed: true,
		authorityRevision: request.identity.authorityRevision,
	};
}

async function auditIntegrationEvent(record: IntegrationEventAuditRecord): Promise<void> {
	const oauth = record.identity.subject.type === "oauth_client";
	await integrationAuditService.record({
		principal: record.identity.subject,
		credential: oauth
			? { type: "oauth_token", id: record.identity.credentialId ?? record.identity.authorityId }
			: { type: "plugin_credential", id: record.identity.authorityId },
		authorityId: record.identity.authorityId,
		transport: oauth ? "oauth-ws" : "plugin-event",
		operationId: `event.${record.action}`,
		capabilityId: "event.subscribe",
		resource: {
			type: "event",
			id: record.topic ?? record.subscriptionId ?? record.identity.connectionId,
		},
		scope: record.scope,
		outcome:
			record.action === "overflow"
				? "overflow"
				: record.action === "revoke"
					? "revoked"
					: record.outcome,
		reasonCode: record.reason ?? null,
		metadata: {
			runtime: `${record.identity.runtime.type}:${record.identity.runtime.id}`,
			runtimeGeneration: record.identity.runtime.generation,
			...(record.queueEvents === undefined ? {} : { queueEvents: record.queueEvents }),
			...(record.queueBytes === undefined ? {} : { queueBytes: record.queueBytes }),
		},
	});
}

/** Shared server-side integration subscription state and delivery kernel. */
export const integrationEventDispatcher = new IntegrationEventDispatcher<PublicEvent>({
	authorize: authorizePublicEvent,
	audit: auditIntegrationEvent,
	controlEvent,
	defaultQueue: {
		maxEvents: 100,
		maxBytes: 256 * 1024,
		maxRatePerSecond: 100,
	},
	maxSubscriptions: 2_048,
	maxConcurrentDispatches: 64,
	maxDispatchesPerSecond: 2_000,
	authorityValidationTtlMs: 1_000,
});

setIntegrationAuthorityInvalidationListener("event-dispatcher", (event) => {
	if (event.state === "active") {
		integrationEventDispatcher.invalidateAuthority(event.authorityId, event.revision, event.reason);
		return;
	}
	integrationEventDispatcher.revokeAuthority(event.authorityId, event.reason);
});
