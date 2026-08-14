/**
 * Regression test: events pushed to plugin UI sessions.
 *
 * The plugin UI panel (team-panel iframe) subscribes with a userId-scoped
 * invocation scope, but host events carry no actor identity (the internal
 * event bus has no "acting user" for narrator lifecycle events, and the
 * mapper never fills `actor`). Previously `matchesScope` required
 * `event.actor?.id === userId`, so every event was dropped before it reached
 * the subscription queue and the panel never refreshed. Scope enforcement for
 * actor-less events is done through the subscription's narratorIds filter
 * (`matchesFilter`) instead.
 */

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { NarraForkEvent } from "../../lib/event-bus";
import type { PublicEvent } from "../../lib/plugins/protocol";
import {
	PluginEventGateway,
	type PluginEventMapper,
	type PublicEventMapping,
} from "../plugin-event-gateway";

/** A minimal event bus matching the PluginEventBus contract. */
function makeBus() {
	const emitter = new EventEmitter();
	return {
		onAny: (listener: (event: NarraForkEvent) => void) => {
			emitter.on("any", listener);
			return () => emitter.off("any", listener);
		},
		offAny: (listener: (event: NarraForkEvent) => void) => {
			emitter.off("any", listener);
		},
		emit: (event: NarraForkEvent) => {
			emitter.emit("any", event);
		},
	};
}

/** Mapper that mimics narrator:status_changed → lifecycle without an actor. */
const narratorLifecycleMapper: PluginEventMapper = (event) => {
	if (event.type !== "narrator:status_changed") return undefined;
	const value = event as { narratorId: string; status: string };
	const mapping: PublicEventMapping = {
		schema: "narrafork.public-event",
		schemaVersion: 1,
		topic: "narrafork.narrator.lifecycle",
		eventClass: "lifecycle",
		occurredAt: new Date().toISOString(),
		redaction: "user_scoped",
		data: { narratorId: value.narratorId, status: value.status },
		resource: { type: "narrator", id: value.narratorId, narratorId: value.narratorId },
	};
	return mapping;
};

/**
 * Gateway with a permissive capability broker so the legacy dispatcher's
 * deliver-phase authorization passes; the point under test is the
 * matchesScope/matchesFilter gate, not capability enforcement.
 */
function makeGateway() {
	const bus = makeBus();
	const gateway = new PluginEventGateway({
		eventBus: bus,
		mapper: narratorLifecycleMapper,
		capabilityBroker: {
			authorize: async () => ({ allowed: true }),
			check: async () => ({ allowed: true }),
		} as never,
	});
	return { bus, gateway };
}

describe("plugin event gateway scope matching (UI panel)", () => {
	test("userId-scoped subscription receives an actor-less narrator event", async () => {
		const { bus, gateway } = makeGateway();
		const result = await gateway.subscribe({
			principal: {
				pluginId: "com.whisent.narrator-team",
				installationId: "inst-1",
				authorityId: "auth-1",
				grantRevision: 1,
				packageVersion: "0.1.37",
				runtimeId: "ui:sess-1",
				generation: 1,
				sessionId: "sess-1",
				contributionId: "team-panel",
			},
			invocationScope: { userId: "user-1" },
			scope: { userId: "user-1" },
			topics: ["narrafork.narrator.lifecycle"],
			filter: { narratorIds: ["narrator-1"] },
			mode: "live",
			delivery: { maxRatePerSecond: 10 },
		});
		expect(typeof result.subscriptionId).toBe("string");

		// Emit a status change for the subscribed narrator; the mapped public
		// event has NO actor, which previously made matchesScope return false
		// for the userId-scoped subscription.
		bus.emit({
			type: "narrator:status_changed",
			narratorId: "narrator-1",
			status: "idle",
		});
		// Allow the async dispatch/pump to enqueue.
		await new Promise((resolve) => setTimeout(resolve, 50));

		const events = gateway.poll(result.subscriptionId, 10);
		expect(events).toHaveLength(1);
		expect((events[0] as PublicEvent).topic).toBe("narrafork.narrator.lifecycle");
		expect((events[0] as PublicEvent).data).toMatchObject({
			narratorId: "narrator-1",
			status: "idle",
		});
	});

	test("narrator filter still excludes events for other narrators", async () => {
		const { bus, gateway } = makeGateway();
		const result = await gateway.subscribe({
			principal: {
				pluginId: "com.whisent.narrator-team",
				installationId: "inst-1",
				authorityId: "auth-1",
				grantRevision: 1,
				packageVersion: "0.1.37",
				runtimeId: "ui:sess-2",
				generation: 1,
				sessionId: "sess-2",
				contributionId: "team-panel",
			},
			invocationScope: { userId: "user-1" },
			scope: { userId: "user-1" },
			topics: ["narrafork.narrator.lifecycle"],
			filter: { narratorIds: ["narrator-1"] },
			mode: "live",
			delivery: { maxRatePerSecond: 10 },
		});

		bus.emit({
			type: "narrator:status_changed",
			narratorId: "narrator-2", // not in the filter
			status: "idle",
		});
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(gateway.poll(result.subscriptionId, 10)).toHaveLength(0);
	});

	test("a subscription with an actor-bearing event still enforces userId scope", async () => {
		const bus = makeBus();
		const gateway = new PluginEventGateway({
			eventBus: bus,
			mapper: (event) => {
				const raw = event as unknown as { type?: string; userId?: string; payload?: string };
				if (raw.type !== "custom:user_event") return undefined;
				const value = raw as { userId: string; payload: string };
				return {
					schema: "narrafork.public-event",
					schemaVersion: 1,
					topic: "narrafork.narrator.lifecycle",
					eventClass: "lifecycle",
					occurredAt: new Date().toISOString(),
					redaction: "user_scoped",
					data: { narratorId: "narrator-1", payload: value.payload },
					actor: { kind: "user", id: value.userId },
				} as PublicEventMapping;
			},
			capabilityBroker: {
				authorize: async () => ({ allowed: true }),
				check: async () => ({ allowed: true }),
			} as never,
		});
		const result = await gateway.subscribe({
			principal: {
				pluginId: "com.whisent.narrator-team",
				installationId: "inst-1",
				authorityId: "auth-1",
				grantRevision: 1,
				packageVersion: "0.1.37",
				runtimeId: "ui:sess-3",
				generation: 1,
				sessionId: "sess-3",
				contributionId: "team-panel",
			},
			invocationScope: { userId: "user-1" },
			scope: { userId: "user-1" },
			topics: ["narrafork.narrator.lifecycle"],
			mode: "live",
			delivery: { maxRatePerSecond: 10 },
		});

		// Same user → delivered.
		bus.emit({ type: "custom:user_event", userId: "user-1", payload: "ok" } as never);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(gateway.poll(result.subscriptionId, 10)).toHaveLength(1);

		// Different user → still excluded by the actor check.
		bus.emit({ type: "custom:user_event", userId: "user-2", payload: "no" } as never);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(gateway.poll(result.subscriptionId, 10)).toHaveLength(0);
	});
});
