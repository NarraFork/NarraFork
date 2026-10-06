import { describe, expect, test } from "bun:test";
import type { ResourceScope } from "@shared/integrations/resources";
import {
	type IntegrationDispatchEvent,
	type IntegrationEventAuthorizationRequest,
	IntegrationEventDispatcher,
} from "../../../../server/lib/integrations/kernel/event-dispatcher";
import { type PublicEvent, publicEventSchema } from "../../../../server/lib/plugins/protocol";
import { PluginEventGateway } from "../../../../server/services/plugin-event-gateway";

type TestEvent = IntegrationDispatchEvent & {
	eventId: string;
	topic: string;
	occurredAt: string;
	eventClass: "lifecycle" | "state" | "audit";
	authorityId?: string;
	resource?: { type: string; id: string };
	data: Record<string, unknown>;
};

interface AuthorityState {
	revision: number;
	active: boolean;
	topics: Set<string>;
	scopes: Set<string>;
}

function scopeKey(scope: ResourceScope): string {
	return scope.type === "global" ? "global" : `${scope.type}:${scope.id}`;
}

function event(
	eventId: string,
	topic: string,
	authorityId?: string,
	resourceId = eventId,
): TestEvent {
	return {
		eventId,
		topic,
		occurredAt: new Date().toISOString(),
		eventClass: "lifecycle",
		authorityId,
		resource: { type: "event", id: resourceId },
		data: {},
	};
}

function createDispatcher(states: Map<string, AuthorityState>, queueEvents = 10) {
	return new IntegrationEventDispatcher<TestEvent>({
		authorize: (request: IntegrationEventAuthorizationRequest<TestEvent>) => {
			const state = states.get(request.identity.authorityId);
			if (!state?.active) {
				return { allowed: false, revoke: true, reason: "authority-inactive" };
			}
			if (state.revision !== request.identity.authorityRevision) {
				return {
					allowed: false,
					revoke: true,
					reason: "authority-revision-mismatch",
					authorityRevision: state.revision,
				};
			}
			if (
				request.permittedCapabilities &&
				!request.permittedCapabilities.includes("event.subscribe")
			) {
				return { allowed: false, revoke: true, reason: "scope-missing" };
			}
			if (request.topics.some((topic) => !state.topics.has(topic))) {
				return { allowed: false, revoke: false, reason: "topic-denied" };
			}
			if (!state.scopes.has(scopeKey(request.scope))) {
				return { allowed: false, revoke: false, reason: "scope-denied" };
			}
			return { allowed: true, authorityRevision: state.revision };
		},
		controlEvent: (topic, subscriptionId, data) => ({
			eventId: `${topic}:${subscriptionId}`,
			topic,
			occurredAt: new Date().toISOString(),
			eventClass: "audit",
			data,
		}),
		defaultQueue: { maxEvents: queueEvents, maxBytes: 8_192, maxRatePerSecond: 1_000 },
		authorityValidationTtlMs: 0,
	});
}

function state(revision: number, topics: string[], scopes = ["global"]): AuthorityState {
	return { revision, active: true, topics: new Set(topics), scopes: new Set(scopes) };
}

function identity(
	authorityId: string,
	authorityRevision: number,
	type: "plugin" | "oauth" = "plugin",
	generation = 1,
) {
	return {
		authorityId,
		authorityRevision,
		runtime: {
			type: type === "plugin" ? ("plugin" as const) : ("server" as const),
			id: `${type}-runtime`,
			generation,
		},
		subject:
			type === "plugin"
				? { type: "plugin" as const, id: `subject-${authorityId}` }
				: { type: "oauth_client" as const, id: `subject-${authorityId}` },
		connectionId: `${type}-connection-${authorityId}-${generation}`,
		credentialId: type === "oauth" ? `token-${authorityId}` : undefined,
	};
}

describe("IntegrationEventDispatcher", () => {
	test("isolates subscriptions across authorities and transports", async () => {
		const states = new Map([
			["plugin-authority", state(1, ["topic.changed"])],
			["oauth-authority", state(3, ["topic.changed"])],
		]);
		const dispatcher = createDispatcher(states);
		const plugin = await dispatcher.register({
			identity: identity("plugin-authority", 1, "plugin"),
			topics: ["topic.changed"],
			scope: { type: "global" },
			boundScopes: [{ type: "global" }],
			matchesEvent: (item) => item.authorityId === "plugin-authority",
		});
		const oauth = await dispatcher.register({
			identity: identity("oauth-authority", 3, "oauth"),
			topics: ["topic.changed"],
			scope: { type: "global" },
			boundScopes: [{ type: "global" }],
			permittedCapabilities: ["event.subscribe"],
			matchesEvent: (item) => item.authorityId === "oauth-authority",
		});

		dispatcher.publish(event("plugin-event", "topic.changed", "plugin-authority"));
		dispatcher.publish(event("oauth-event", "topic.changed", "oauth-authority"));
		await Bun.sleep(5);

		expect(dispatcher.poll(plugin).map((item) => item.eventId)).toEqual(["plugin-event"]);
		expect(dispatcher.poll(oauth).map((item) => item.eventId)).toEqual(["oauth-event"]);
		expect(dispatcher.revokeAuthority("plugin-authority")).toBe(1);
		expect(dispatcher.size).toBe(1);
	});

	test("fails closed for denied topics, scopes, and OAuth capability scope", async () => {
		const states = new Map([["authority", state(1, ["topic.allowed"], ["project:project-1"])]]);
		const dispatcher = createDispatcher(states);
		const base = {
			identity: identity("authority", 1, "oauth"),
			boundScopes: [{ type: "project" as const, id: "project-1" }],
		};
		await expect(
			dispatcher.register({
				...base,
				topics: ["topic.denied"],
				scope: { type: "project", id: "project-1" },
				permittedCapabilities: ["event.subscribe"],
			}),
		).rejects.toThrow("PERMISSION_DENIED");
		await expect(
			dispatcher.register({
				...base,
				topics: ["topic.allowed"],
				scope: { type: "project", id: "project-2" },
				permittedCapabilities: ["event.subscribe"],
			}),
		).rejects.toThrow("PERMISSION_DENIED");
		await expect(
			dispatcher.register({
				...base,
				topics: ["topic.allowed"],
				scope: { type: "project", id: "project-1" },
				permittedCapabilities: ["narrator.read"],
			}),
		).rejects.toThrow("PERMISSION_DENIED");
	});

	test("stops immediately after revision bump or authority revoke", async () => {
		const states = new Map([["authority", state(1, ["topic.changed"])]]);
		const dispatcher = createDispatcher(states);
		const subscription = await dispatcher.register({
			identity: identity("authority", 1),
			topics: ["topic.changed"],
			scope: { type: "global" },
			boundScopes: [{ type: "global" }],
		});
		states.set("authority", state(2, ["topic.changed"]));
		dispatcher.publish(event("after-bump", "topic.changed"));
		await Bun.sleep(5);
		expect(dispatcher.poll(subscription)).toEqual([]);
		expect(dispatcher.size).toBe(0);

		const replacement = await dispatcher.register({
			identity: identity("authority", 2),
			topics: ["topic.changed"],
			scope: { type: "global" },
			boundScopes: [{ type: "global" }],
		});
		expect(dispatcher.invalidateAuthority("authority", 3)).toBe(1);
		expect(dispatcher.poll(replacement)).toEqual([]);
	});

	test("replaces runtime generations through the runtime index", async () => {
		const states = new Map([["authority", state(1, ["topic.changed"])]]);
		const dispatcher = createDispatcher(states);
		const oldGeneration = await dispatcher.register({
			identity: identity("authority", 1, "plugin", 1),
			topics: ["topic.changed"],
			scope: { type: "global" },
			boundScopes: [{ type: "global" }],
		});
		const newGeneration = await dispatcher.register({
			identity: identity("authority", 1, "plugin", 2),
			topics: ["topic.changed"],
			scope: { type: "global" },
			boundScopes: [{ type: "global" }],
		});
		expect(
			dispatcher.invalidateRuntime({ type: "plugin", id: "plugin-runtime" }, 2, "runtime-replaced"),
		).toBe(1);
		dispatcher.publish(event("new-generation", "topic.changed"));
		await Bun.sleep(5);
		expect(dispatcher.poll(oldGeneration)).toEqual([]);
		expect(dispatcher.poll(newGeneration).map((item) => item.eventId)).toEqual(["new-generation"]);
	});

	test("uses one dispatcher for plugin and OAuth subscription adapters", async () => {
		const shared = new IntegrationEventDispatcher<PublicEvent>({ authorize: () => true });
		const gateway = new PluginEventGateway({
			dispatcher: shared,
			registerListener: false,
		});
		try {
			const plugin = await gateway.subscribe({
				pluginId: "plugin.test",
				authorityId: "plugin-authority",
				grantRevision: 1,
				runtimeId: "plugin-runtime",
				generation: 2,
				topics: ["narrafork.narrator.lifecycle"],
			});
			const oauth = await shared.register({
				identity: identity("oauth-authority", 4, "oauth"),
				topics: ["narrafork.narrator.lifecycle"],
				scope: { type: "global" },
				boundScopes: [{ type: "global" }],
				permittedCapabilities: ["event.subscribe"],
			});
			shared.publish(
				publicEventSchema.parse({
					schema: "narrafork.public-event",
					schemaVersion: 1,
					eventId: "shared-event",
					topic: "narrafork.narrator.lifecycle",
					eventClass: "lifecycle",
					occurredAt: new Date().toISOString(),
					data: { narratorId: "narrator-1" },
					redaction: "user_scoped",
				}),
			);
			await Bun.sleep(5);
			expect(gateway.poll(plugin.subscriptionId).map((item) => item.eventId)).toEqual([
				"shared-event",
			]);
			expect(shared.poll(oauth).map((item) => item.eventId)).toEqual(["shared-event"]);
			expect(shared.size).toBe(2);
		} finally {
			gateway.close();
			shared.clear();
		}
	});

	test("bounds queues and emits overflow plus resync without accumulating payloads", async () => {
		const states = new Map([["authority", state(1, ["topic.changed"])]]);
		const dispatcher = createDispatcher(states, 1);
		const subscription = await dispatcher.register({
			identity: identity("authority", 1),
			topics: ["topic.changed"],
			scope: { type: "global" },
			boundScopes: [{ type: "global" }],
		});
		dispatcher.publish(event("first", "topic.changed"));
		dispatcher.publish(event("second", "topic.changed"));
		await Bun.sleep(5);
		const delivered = dispatcher.poll(subscription, 10);
		expect(delivered.map((item) => item.topic)).toEqual([
			"narrafork.events.overflow",
			"narrafork.events.resync_required",
		]);
		expect(dispatcher.getDiagnostics()[0]).toMatchObject({
			status: "overflowed",
			queueBytes: 0,
			dropped: 1,
		});
	});
});
