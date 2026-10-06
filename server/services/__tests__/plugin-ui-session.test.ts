import { describe, expect, test } from "bun:test";
import type { PluginUiSession } from "../plugin-ui-session";
import { PluginUiSessionService } from "../plugin-ui-session";

const binding = {
	pluginId: "com.example.ui",
	version: "1.0.0",
	hash: "a".repeat(64),
	authorityInstallationId: "installation-ui-authority",
	installationId: "installation-1",
	principalId: "user-1",
	contributionId: "panel",
	panelInstanceId: "panel-1",
	surface: "workspace" as const,
	surfaceScope: "workspace" as const,
};

describe("PluginUiSessionService", () => {
	test("binds capability to plugin package and principal", () => {
		const service = new PluginUiSessionService();
		const created = service.create(binding);
		expect(
			service.authenticate(created.session.sessionId, created.sessionToken, "user-1"),
		).toMatchObject(binding);
		expect(() =>
			service.authenticate(created.session.sessionId, created.sessionToken, "user-2"),
		).toThrow("principal mismatch");
		expect(() =>
			service.authenticateCapability(created.session.sessionId, created.sessionToken, {
				version: "2.0.0",
			}),
		).toThrow("binding mismatch");
		expect(
			service.authenticateCapability(created.session.sessionId, created.sessionToken, {
				pluginId: binding.pluginId,
			}),
		).toMatchObject({ pluginId: binding.pluginId });
		expect(
			service.authenticateAssetCapability(created.session.sessionId, created.assetToken, {
				pluginId: binding.pluginId,
			}),
		).toMatchObject({ pluginId: binding.pluginId });
		expect(() =>
			service.authenticateAssetCapability(created.session.sessionId, created.sessionToken),
		).toThrow("asset capability");
	});

	test("revokes and expires sessions", () => {
		let now = new Date("2026-07-16T00:00:00.000Z");
		const service = new PluginUiSessionService({ now: () => now, ttlMs: 1000 });
		const created = service.create(binding);
		expect(service.revoke(created.session.sessionId, "user-1")).toBe(true);
		expect(() =>
			service.authenticate(created.session.sessionId, created.sessionToken, "user-1"),
		).toThrow();
		const next = service.create(binding);
		now = new Date("2026-07-16T00:00:02.000Z");
		expect(() =>
			service.authenticate(next.session.sessionId, next.sessionToken, "user-1"),
		).toThrow();
		expect(() =>
			service.authenticateAssetCapability(next.session.sessionId, next.assetToken),
		).toThrow();
		service.close();
	});

	test("replaces keyed removal listeners without letting stale disposers remove the replacement", () => {
		const service = new PluginUiSessionService();
		const key = Symbol.for("plugin-ui-test-listener");
		let firstCalls = 0;
		let secondCalls = 0;
		const stopFirst = service.onRemoved(() => {
			firstCalls += 1;
		}, key);
		service.onRemoved(() => {
			secondCalls += 1;
		}, key);
		stopFirst();
		const created = service.create(binding);
		service.remove(created.session.sessionId, "test-removal");
		expect(firstCalls).toBe(0);
		expect(secondCalls).toBe(1);
		service.close();
	});

	test("notifies every removal path once and maintains one unrefed next-expiry timer", () => {
		let now = new Date("2026-07-20T00:00:00.000Z");
		type FakeTimer = {
			callback: () => void;
			delayMs: number;
			cleared: boolean;
			unrefCalls: number;
			unref(): void;
		};
		const active = new Set<FakeTimer>();
		const timers: FakeTimer[] = [];
		const setFakeTimeout = (callback: () => void, delayMs: number) => {
			const timer: FakeTimer = {
				callback: () => {
					active.delete(timer);
					callback();
				},
				delayMs,
				cleared: false,
				unrefCalls: 0,
				unref() {
					this.unrefCalls += 1;
				},
			};
			timers.push(timer);
			active.add(timer);
			return timer as unknown as ReturnType<typeof setTimeout>;
		};
		const service = new PluginUiSessionService({
			now: () => now,
			ttlMs: 1000,
			setTimeout: setFakeTimeout,
			clearTimeout: (value) => {
				const timer = value as unknown as FakeTimer;
				timer.cleared = true;
				active.delete(timer);
			},
		});
		const removals: Array<{ session: PluginUiSession; reason: string }> = [];
		service.onRemoved(() => {
			throw new Error("faulty listener");
		});
		const stopListening = service.onRemoved((session, reason) => {
			removals.push({ session, reason });
		});
		const first = service.create(binding);
		const second = service.create({ ...binding, panelInstanceId: "panel-2" });
		expect(active.size).toBe(1);
		expect([...active][0]?.delayMs).toBe(1000);
		expect(timers.every((timer) => timer.unrefCalls === 1)).toBe(true);

		expect(service.revoke(first.session.sessionId, "user-1", "route-delete")).toBe(true);
		expect(service.revoke(first.session.sessionId, "user-1", "route-delete")).toBe(false);
		expect(removals.map((item) => item.reason)).toEqual(["route-delete"]);
		expect(active.size).toBe(1);

		now = new Date("2026-07-20T00:00:02.000Z");
		active.values().next().value?.callback();
		expect(service.get(second.session.sessionId)).toBeUndefined();
		expect(removals.map((item) => item.reason)).toEqual(["route-delete", "expired"]);
		expect(active.size).toBe(0);

		const third = service.create({ ...binding, panelInstanceId: "panel-3" });
		expect(service.clearForPlugin(binding.pluginId, "plugin-disabled")).toBe(1);
		expect(service.remove(third.session.sessionId, "duplicate")).toBe(false);
		expect(removals.map((item) => item.reason)).toEqual([
			"route-delete",
			"expired",
			"plugin-disabled",
		]);
		stopListening();
		stopListening();
		service.close();
		service.close();
		expect(() => service.create(binding)).toThrow("service is closed");
	});
});
