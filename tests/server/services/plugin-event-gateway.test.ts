import { afterEach, describe, expect, it } from "bun:test";
import type { NarraForkEvent } from "../../../server/lib/event-bus";
import {
	type PluginCapabilityBroker,
	type PluginEventBus,
	PluginEventGateway,
	type PublicEventMapping,
} from "../../../server/services/plugin-event-gateway";

class FakeEventBus implements PluginEventBus {
	private readonly listeners = new Set<(event: NarraForkEvent) => void>();

	onAny(listener: (event: NarraForkEvent) => void): void {
		this.listeners.add(listener);
	}

	offAny(listener: (event: NarraForkEvent) => void): void {
		this.listeners.delete(listener);
	}

	emit(event: NarraForkEvent): void {
		for (const listener of this.listeners) listener(event);
	}
}

function sleep(ms = 10): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function eventually(predicate: () => boolean, timeoutMs = 500): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate() && Date.now() < deadline) await sleep(2);
	if (!predicate()) throw new Error("condition did not become true");
}

function allowAllBroker(overrides: Partial<PluginCapabilityBroker> = {}): PluginCapabilityBroker {
	return {
		authorize: () => true,
		isRuntimeActive: () => true,
		...overrides,
	};
}

function mappingFor(
	topic: PublicEventMapping["topic"],
	data: Record<string, unknown>,
): PublicEventMapping {
	return {
		topic,
		eventClass: topic.endsWith("attention") ? "attention" : "lifecycle",
		data: data as PublicEventMapping["data"],
		redaction: "user_scoped",
	};
}

afterEach(async () => {
	await sleep(2);
});

describe("PluginEventGateway", () => {
	it("validates topic/filter and rejects a widened scope before authorization", async () => {
		const bus = new FakeEventBus();
		const authorizeCalls: string[] = [];
		const gateway = new PluginEventGateway({
			eventBus: bus,
			capabilityBroker: {
				authorize: ({ topic }) => {
					authorizeCalls.push(topic);
					return true;
				},
			},
		});
		try {
			await expect(
				gateway.subscribe({
					pluginId: "plugin.test",
					topics: ["narrafork.chapter.created", "narrafork.chapter.lifecycle"],
					filter: { topic: ["narrafork.chapter.created"] },
					invocationScope: { projectId: "project-1" },
					scope: { projectId: "project-2" },
				}),
			).rejects.toThrow("PERMISSION_DENIED");
			expect(authorizeCalls).toHaveLength(0);

			await expect(
				gateway.subscribe({
					pluginId: "plugin.test",
					topics: ["narrafork.narrator.lifecycle"],
					invocationScope: { narratorId: "narrator-1" },
					scope: { projectId: "project-1" },
				}),
			).rejects.toThrow("PERMISSION_DENIED");

			await expect(
				gateway.subscribe({
					pluginId: "plugin.test",
					topics: ["narrafork.chapter.created"],
					filter: { topic: ["narrafork.unknown.changed"] as never },
				}),
			).rejects.toThrow("INVALID_SUBSCRIPTION");
		} finally {
			gateway.close();
		}
	});

	it("delivers only events matching the authorized structured filter", async () => {
		const bus = new FakeEventBus();
		const received: string[] = [];
		const gateway = new PluginEventGateway({ eventBus: bus, capabilityBroker: allowAllBroker() });
		try {
			await gateway.subscribe({
				pluginId: "plugin.test",
				topics: ["narrafork.chapter.created"],
				filter: { projectIds: ["project-1"] },
				onEvent: (event) => {
					received.push(String(event.data.chapterId));
				},
			});
			bus.emit({ type: "chapter:created", chapterId: "chapter-1", projectId: "project-1" });
			bus.emit({ type: "chapter:created", chapterId: "chapter-2", projectId: "project-2" });
			await eventually(() => received.length === 1);
			expect(received).toEqual(["chapter-1"]);
		} finally {
			gateway.close();
		}
	});

	it("maps and redacts narrator events without contentJson, tool payloads, or secrets", async () => {
		const bus = new FakeEventBus();
		const received: unknown[] = [];
		const gateway = new PluginEventGateway({ eventBus: bus, capabilityBroker: allowAllBroker() });
		try {
			await gateway.subscribe({
				pluginId: "plugin.test",
				topics: ["narrafork.narrator.lifecycle"],
				onEvent: (event) => {
					received.push(event);
				},
			});
			bus.emit({
				type: "narrator:error",
				narratorId: "narrator-1",
				error: "JWT_SECRET=do-not-leak",
			});
			await eventually(() => received.length === 1);
			const serialized = JSON.stringify(received[0]);
			expect(serialized).not.toContain("JWT_SECRET");
			expect(serialized).not.toContain("contentJson");
			expect(serialized).not.toContain("private-request");
			expect((received[0] as { data: { status: string } }).data.status).toBe("error");
		} finally {
			gateway.close();
		}
	});

	it("sanitizes sensitive custom mapper data and drops unknown internal events with bounded diagnostics", async () => {
		const bus = new FakeEventBus();
		const received: unknown[] = [];
		const gateway = new PluginEventGateway({
			eventBus: bus,
			capabilityBroker: allowAllBroker(),
			mapper: (event, context) => {
				if (event.type !== "narrator:message") return undefined;
				return {
					...mappingFor("narrafork.narrator.message.changed", {
						contentJson: [{ type: "text", text: "private" }],
						toolInput: { secret: "private" },
						publicValue: "ok",
					}),
					eventId: context.eventId,
				};
			},
		});
		try {
			await gateway.subscribe({
				pluginId: "plugin.test",
				topics: ["narrafork.narrator.message.changed"],
				onEvent: (event) => {
					received.push(event);
				},
			});
			bus.emit({
				type: "chapter:files_changed",
				chapterId: "chapter-1",
				worktreePath: "/secret/path",
			});
			bus.emit({ type: "narrator:message", narratorId: "narrator-1", role: "assistant" });
			await eventually(() => received.length === 1);
			expect(JSON.stringify(received[0])).not.toContain("contentJson");
			expect(JSON.stringify(received[0])).not.toContain("toolInput");
			expect((received[0] as { data: { publicValue: string } }).data.publicValue).toBe("ok");
			expect(gateway.listDiagnostics().some((item) => item.code === "UNKNOWN_INTERNAL_EVENT")).toBe(
				true,
			);
		} finally {
			gateway.close();
		}
	});

	it("supports cancellation and stops delivery after unsubscribe", async () => {
		const bus = new FakeEventBus();
		const received: string[] = [];
		const gateway = new PluginEventGateway({ eventBus: bus, capabilityBroker: allowAllBroker() });
		try {
			const subscription = await gateway.subscribe({
				pluginId: "plugin.test",
				topics: ["narrafork.chapter.created"],
				onEvent: (event) => {
					received.push(String(event.data.chapterId));
				},
			});
			expect(gateway.unsubscribe(subscription.subscriptionId)).toBe(true);
			bus.emit({ type: "chapter:created", chapterId: "chapter-1", projectId: "project-1" });
			await sleep(20);
			expect(received).toEqual([]);
			expect(gateway.poll(subscription.subscriptionId)).toEqual([]);
		} finally {
			gateway.close();
		}
	});

	it("emits overflow and resync_required while keeping eventBus.emit synchronous", async () => {
		const bus = new FakeEventBus();
		const gateway = new PluginEventGateway({
			eventBus: bus,
			capabilityBroker: allowAllBroker(),
			defaultQueueEvents: 1,
			defaultRatePerSecond: 0.1,
		});
		try {
			const subscription = await gateway.subscribe({
				pluginId: "plugin.test",
				topics: ["narrafork.chapter.commits.changed"],
			});
			const started = performance.now();
			bus.emit({ type: "chapter:commits_updated", chapterId: "chapter-1", newCount: 1 });
			bus.emit({ type: "chapter:commits_updated", chapterId: "chapter-2", newCount: 2 });
			expect(performance.now() - started).toBeLessThan(20);
			await sleep(25);
			const events = gateway.poll(subscription.subscriptionId, 10);
			expect(events.map((event) => event.topic)).toContain("narrafork.events.overflow");
			expect(events.map((event) => event.topic)).toContain("narrafork.events.resync_required");
			expect(gateway.listDiagnostics().some((item) => item.code === "QUEUE_OVERFLOW")).toBe(true);
		} finally {
			gateway.close();
		}
	});

	it("throttles callback delivery to the negotiated rate", async () => {
		const bus = new FakeEventBus();
		const received: number[] = [];
		const gateway = new PluginEventGateway({ eventBus: bus, capabilityBroker: allowAllBroker() });
		try {
			await gateway.subscribe({
				pluginId: "plugin.test",
				topics: ["narrafork.narrator.attention"],
				delivery: { maxRatePerSecond: 10 },
				onEvent: (event) => {
					received.push(Number(event.data.sequence));
				},
			});
			for (let sequence = 1; sequence <= 3; sequence++) {
				bus.emit({
					type: "narrator:attention",
					narratorId: "narrator-1",
					reason: "done",
					detail: `sequence-${sequence}`,
				});
			}
			await sleep(25);
			expect(received.length).toBe(1);
			await eventually(() => received.length >= 2, 300);
		} finally {
			gateway.close();
		}
	});

	it("enforces the global subscription budget across plugins", async () => {
		const bus = new FakeEventBus();
		const gateway = new PluginEventGateway({
			eventBus: bus,
			capabilityBroker: allowAllBroker(),
			maxSubscriptions: 1,
		});
		try {
			await gateway.subscribe({
				pluginId: "plugin.first",
				topics: ["narrafork.chapter.created"],
			});
			await expect(
				gateway.subscribe({
					pluginId: "plugin.second",
					topics: ["narrafork.chapter.created"],
				}),
			).rejects.toThrow("SUBSCRIPTION_QUOTA_EXCEEDED");
			expect(gateway.getDiagnostics().at(-1)).toMatchObject({
				code: "QUOTA_EXCEEDED",
				pluginId: "plugin.second",
				count: 1,
			});
		} finally {
			gateway.close();
		}
	});

	it("re-authorizes each delivery, records audit summaries, and revokes on plugin disable", async () => {
		const bus = new FakeEventBus();
		let allowed = true;
		const audits: string[] = [];
		const gateway = new PluginEventGateway({
			eventBus: bus,
			capabilityBroker: {
				authorize: () => allowed,
				audit: (summary) => {
					audits.push(`${summary.methodId}:${summary.outcome}`);
				},
			},
		});
		try {
			const subscription = await gateway.subscribe({
				pluginId: "plugin.test",
				runtimeId: "runtime-1",
				generation: 3,
				topics: ["narrafork.chapter.created"],
			});
			allowed = false;
			bus.emit({ type: "chapter:created", chapterId: "chapter-1", projectId: "project-1" });
			await sleep(20);
			expect(gateway.poll(subscription.subscriptionId)).toEqual([]);
			allowed = true;
			const second = await gateway.subscribe({
				pluginId: "plugin.test",
				topics: ["narrafork.chapter.created"],
			});
			bus.emit({ type: "chapter:created", chapterId: "chapter-2", projectId: "project-1" });
			await sleep(20);
			expect(gateway.disablePlugin("plugin.test")).toBe(2);
			expect(gateway.poll(second.subscriptionId)).toEqual([]);
			expect(audits).toContain("events.subscribe:succeeded");
			expect(audits).toContain("events.deliver:succeeded");
		} finally {
			gateway.close();
		}
	});
});
