import { describe, expect, test } from "bun:test";
import type { JsonValue } from "@server/lib/plugins/protocol";
import type { HostCallContext, PluginPrincipal } from "@server/services/plugin-capability-broker";
import {
	PluginScheduler,
	type PluginSchedulerCapabilityBroker,
	PluginSchedulerError,
} from "@server/services/plugin-scheduler";

const principal: PluginPrincipal = {
	pluginId: "com.example.scheduler",
	packageVersion: "1.0.0",
	runtimeId: "runtime-1",
	runtimeGeneration: 1,
	installationId: "installation-1",
};

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function broker(
	authorize: PluginSchedulerCapabilityBroker["authorize"] = async () => ({
		allowed: true,
		capability: "schedule.register",
		context: {} as HostCallContext,
		grant: { capability: "schedule.register", scope: { type: "global" } },
		effectiveCapabilities: ["schedule.register"],
		cacheHit: false,
	}),
): PluginSchedulerCapabilityBroker {
	return { authorize };
}

function futureIso(offsetMs = 60_000): string {
	return new Date(Date.now() + offsetMs).toISOString();
}

function registration(id: string, payload?: JsonValue) {
	return {
		plugin: principal,
		contributionId: id,
		schedule: { kind: "once" as const, runAt: futureIso() },
		payload,
	};
}

describe("PluginScheduler", () => {
	test("enforces total/per-plugin quotas and minimum interval/cron frequency", () => {
		const scheduler = new PluginScheduler({
			capabilityBroker: broker(),
			maxSchedules: 1,
			maxSchedulesPerPlugin: 1,
			minIntervalMs: 120_000,
		});
		try {
			expect(() =>
				scheduler.register({
					plugin: principal,
					contributionId: "too-fast",
					schedule: { kind: "interval", intervalMs: 119_999 },
				}),
			).toThrow(expect.objectContaining({ code: "RATE_LIMITED" }));
			expect(() =>
				scheduler.register({
					plugin: principal,
					contributionId: "cron-too-fast",
					schedule: { kind: "cron", expression: "* * * * *" },
				}),
			).toThrow(expect.objectContaining({ code: "RATE_LIMITED" }));

			scheduler.register(registration("one"));
			expect(() => scheduler.register(registration("two"))).toThrow(
				expect.objectContaining({ code: "RATE_LIMITED" }),
			);
		} finally {
			scheduler.close();
		}
	});

	test("cancels host-owned timers before a one-time schedule fires", async () => {
		let calls = 0;
		const scheduler = new PluginScheduler({
			capabilityBroker: broker(),
			minIntervalMs: 5,
			handler: () => {
				calls += 1;
			},
		});
		try {
			const descriptor = scheduler.register({
				plugin: principal,
				contributionId: "cancelled",
				schedule: { kind: "once", runAt: futureIso(40) },
			});
			expect(scheduler.cancel(descriptor.fullId)).toBe(true);
			await sleep(70);
			expect(calls).toBe(0);
			expect(scheduler.get(descriptor.fullId)).toMatchObject({
				status: "cancelled",
				nextRunAt: undefined,
			});
		} finally {
			scheduler.close();
		}
	});

	test("uses plugin_background authorization and automatically stops on revoke", async () => {
		const authorizationContexts: HostCallContext[] = [];
		const scheduler = new PluginScheduler({
			capabilityBroker: broker(async (request) => {
				authorizationContexts.push(request.context);
				return {
					allowed: false,
					error: { code: "PERMISSION_DENIED", reason: "GRANT_REVOKED" },
				};
			}),
			minIntervalMs: 5,
			handler: () => {
				throw new Error("must not execute");
			},
		});
		try {
			const descriptor = scheduler.register(registration("revoked"));
			const record = await scheduler.triggerNow(descriptor.fullId);
			expect(record.outcome).toBe("denied");
			expect(authorizationContexts[0]?.invocation).toEqual({
				kind: "plugin_background",
				source: "schedule",
			});
			expect(authorizationContexts[0]?.plugin).toMatchObject({
				pluginId: principal.pluginId,
				runtimeId: principal.runtimeId,
			});
			expect(scheduler.get(descriptor.fullId)).toMatchObject({
				status: "revoked",
				enabled: false,
			});
		} finally {
			scheduler.close();
		}
	});

	test("aborts and records executions that exceed the host timeout", async () => {
		let aborted = false;
		const scheduler = new PluginScheduler({
			capabilityBroker: broker(),
			defaultTimeoutMs: 15,
			maxTimeoutMs: 20,
			minIntervalMs: 5,
			handler: (_payload, context) =>
				new Promise((_resolve, reject) => {
					context.signal.addEventListener("abort", () => {
						aborted = true;
						reject(new DOMException("aborted", "AbortError"));
					});
				}),
		});
		try {
			const descriptor = scheduler.register(registration("timeout"));
			const record = await scheduler.triggerNow(descriptor.fullId);
			expect(record.outcome).toBe("timeout");
			expect(record.errorCode).toBe("TIMEOUT");
			expect(aborted).toBe(true);
		} finally {
			scheduler.close();
		}
	});

	test("keeps concurrency at one and records overlapping triggers without running them", async () => {
		let release: (() => void) | undefined;
		let signalStarted: (() => void) | undefined;
		let calls = 0;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started = new Promise<void>((resolve) => {
			signalStarted = resolve;
		});
		const scheduler = new PluginScheduler({
			capabilityBroker: broker(),
			defaultTimeoutMs: 200,
			minIntervalMs: 5,
			handler: async () => {
				calls += 1;
				signalStarted?.();
				await gate;
			},
		});
		try {
			const descriptor = scheduler.register(registration("overlap"));
			const first = scheduler.triggerNow(descriptor.fullId);
			await started;
			const overlapping = await scheduler.triggerNow(descriptor.fullId);
			expect(overlapping.outcome).toBe("skipped_overlap");
			expect(calls).toBe(1);
			release?.();
			expect((await first).outcome).toBe("succeeded");
		} finally {
			scheduler.close();
		}
	});

	test("exports only bounded JSON definitions and omits handlers/runtime state", () => {
		const scheduler = new PluginScheduler({
			capabilityBroker: broker(),
			minIntervalMs: 5,
		});
		try {
			scheduler.register(registration("persisted", { safe: true }));
			const definitions = scheduler.exportDefinitions();
			expect(JSON.parse(JSON.stringify(definitions))).toEqual(definitions);
			expect(JSON.stringify(definitions)).not.toContain("runtimeId");
			expect(JSON.stringify(definitions)).not.toContain("handler");
		} finally {
			scheduler.close();
		}
	});

	test("rejects invalid persisted definitions during recovery", async () => {
		const scheduler = new PluginScheduler({ capabilityBroker: broker() });
		try {
			await expect(
				scheduler.restore([
					{
						schema: "narrafork.plugin-schedule",
						schemaVersion: 1,
						pluginId: principal.pluginId,
						contributionId: "bad",
						schedule: { kind: "interval", intervalMs: 1 },
						enabled: true,
						extra: true,
					} as never,
				]),
			).rejects.toBeInstanceOf(PluginSchedulerError);
		} finally {
			scheduler.close();
		}
	});
});
