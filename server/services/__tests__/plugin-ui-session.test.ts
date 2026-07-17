import { describe, expect, test } from "bun:test";
import { PluginUiSessionService } from "../plugin-ui-session";

const binding = {
	pluginId: "com.example.ui",
	version: "1.0.0",
	hash: "a".repeat(64),
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
	});
});
