import { describe, expect, test } from "bun:test";
import {
	PLUGIN_LIFECYCLE_REVOKE_ACTIONS,
	PLUGIN_LIFECYCLE_REVOKE_LAYERS,
	type PluginLifecycleRevokeAdapters,
	type PluginLifecycleRevokeContext,
	PluginLifecycleRevokeCoordinator,
	PluginLifecycleRevokeError,
} from "@server/services/plugin-lifecycle-revoke-coordinator";

const event = {
	eventId: "lifecycle-1",
	pluginId: "com.example.lifecycle",
	kind: "runtime_generation" as const,
	runtimeId: "runtime-2",
	runtimeGeneration: 4,
	reason: "runtime restarted",
};

function adaptersFor(
	handler: (context: PluginLifecycleRevokeContext) => void | Promise<void> = () => undefined,
): PluginLifecycleRevokeAdapters {
	return Object.fromEntries(
		PLUGIN_LIFECYCLE_REVOKE_LAYERS.map((layer) => [
			layer,
			async (context: PluginLifecycleRevokeContext) => {
				await handler(context);
			},
		]),
	) as PluginLifecycleRevokeAdapters;
}

describe("PluginLifecycleRevokeCoordinator", () => {
	test("runs every injected layer sequentially with the event-specific actions", async () => {
		const calls: string[] = [];
		const adapters = adaptersFor(async ({ layer, action }) => {
			calls.push(`start:${layer}`);
			await Promise.resolve();
			calls.push(`${layer}:${action}`);
		});
		const coordinator = new PluginLifecycleRevokeCoordinator({ adapters });

		const report = await coordinator.revoke(event);

		expect(report.status).toBe("succeeded");
		expect(report.steps).toHaveLength(PLUGIN_LIFECYCLE_REVOKE_LAYERS.length);
		expect(calls).toEqual(
			PLUGIN_LIFECYCLE_REVOKE_LAYERS.flatMap((layer) => [
				`start:${layer}`,
				`${layer}:${PLUGIN_LIFECYCLE_REVOKE_ACTIONS.runtime_generation[layer]}`,
			]),
		);
	});

	test("deduplicates repeated event IDs without invoking adapters twice", async () => {
		let invocationCount = 0;
		const coordinator = new PluginLifecycleRevokeCoordinator({
			adapters: adaptersFor(() => {
				invocationCount += 1;
			}),
		});

		const first = await coordinator.revoke({ ...event, eventId: "duplicate-1" });
		const second = await coordinator.revoke({ ...event, eventId: "duplicate-1" });

		expect(invocationCount).toBe(PLUGIN_LIFECYCLE_REVOKE_LAYERS.length);
		expect(first.deduplicated).toBe(false);
		expect(second.deduplicated).toBe(true);
		expect(second.steps).toEqual(first.steps);
		expect(coordinator.getReport("duplicate-1")?.deduplicated).toBe(false);
	});

	test("continues after an adapter failure and exposes an aggregate report", async () => {
		const calls: string[] = [];
		const logs: Array<{ errors: number; eventId: string }> = [];
		const adapters = adaptersFor(async ({ layer }) => {
			calls.push(layer);
			if (layer === "event_gateway") {
				throw Object.assign(new Error("gateway unavailable"), { code: "GATEWAY_DOWN" });
			}
		});
		const coordinator = new PluginLifecycleRevokeCoordinator({
			adapters,
			logger: {
				error: (_message, context) => {
					logs.push({ errors: context.errors.length, eventId: context.event.eventId });
				},
			},
		});

		let thrown: unknown;
		try {
			await coordinator.revoke({ ...event, eventId: "failure-1" });
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(PluginLifecycleRevokeError);
		const report = (thrown as PluginLifecycleRevokeError).report;
		expect(report.status).toBe("failed");
		expect(report.errors).toHaveLength(1);
		expect(report.errors[0]?.code).toBe("GATEWAY_DOWN");
		expect(report.steps).toHaveLength(PLUGIN_LIFECYCLE_REVOKE_LAYERS.length);
		expect(calls).toEqual([...PLUGIN_LIFECYCLE_REVOKE_LAYERS]);
		expect(logs).toEqual([{ errors: 1, eventId: "failure-1" }]);
		expect(coordinator.getReport("failure-1")?.errors[0]?.message).toBe("gateway unavailable");
	});

	test("fails closed when an adapter is missing instead of silently skipping it", async () => {
		const calls: string[] = [];
		const adapters = {
			...adaptersFor(({ layer }) => {
				calls.push(layer);
			}),
		};
		adapters.event_gateway = undefined;
		const coordinator = new PluginLifecycleRevokeCoordinator({ adapters });

		const report = await coordinator.revokeWithReport({ ...event, eventId: "missing-1" });

		expect(report.status).toBe("failed");
		expect(report.errors).toHaveLength(1);
		expect(report.errors[0]?.code).toBe("ADAPTER_MISSING");
		expect(calls).toEqual(
			PLUGIN_LIFECYCLE_REVOKE_LAYERS.filter((layer) => layer !== "event_gateway"),
		);
	});

	test("can stop after the first failure while reporting unattempted layers", async () => {
		const adapters = adaptersFor(({ layer }) => {
			if (layer === "capability_broker") throw new Error("broker unavailable");
		});
		const coordinator = new PluginLifecycleRevokeCoordinator({
			adapters,
			continueOnError: false,
		});

		const report = await coordinator.revokeWithReport({ ...event, eventId: "stop-1" });

		expect(report.errors.map((error) => error.code)).toEqual([
			undefined,
			"NOT_ATTEMPTED",
			"NOT_ATTEMPTED",
			"NOT_ATTEMPTED",
			"NOT_ATTEMPTED",
			"NOT_ATTEMPTED",
			"NOT_ATTEMPTED",
		]);
		expect(report.steps[0]?.status).toBe("succeeded");
		expect(report.steps[1]?.status).toBe("failed");
		expect(report.steps[2]?.status).toBe("not_attempted");
	});
});
