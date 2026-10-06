import { describe, expect, test } from "bun:test";
import { narratorWebSocketBackendRefusal, resolveWSData } from "../ws-handler";

describe("PostgreSQL narrator WebSocket admission", () => {
	test("rejects both session and External OAuth narrator upgrades with a stable 503", async () => {
		for (const pathname of ["/ws/narrator", "/ws/external/v1/narrators"]) {
			const response = narratorWebSocketBackendRefusal(pathname, "postgres");
			expect(response?.status).toBe(503);
			expect(await response?.json()).toEqual({
				error: "Narrator WebSocket is not yet supported on the PostgreSQL backend",
				code: "POSTGRES_UNSUPPORTED",
			});
		}
	});

	test("does not gate terminal or other WebSocket channels on PostgreSQL", () => {
		for (const pathname of ["/ws/terminal", "/ws/vnet", "/ws/device"]) {
			expect(narratorWebSocketBackendRefusal(pathname, "postgres")).toBeNull();
		}
		expect(resolveWSData(new URL("http://localhost/ws/terminal"))?.channel).toBe("terminal");
	});

	test("leaves SQLite narrator WebSocket resolution unchanged", () => {
		expect(narratorWebSocketBackendRefusal("/ws/narrator", "sqlite")).toBeNull();
		expect(
			resolveWSData(new URL("http://localhost/ws/narrator?token=test"), {
				userId: "user-1",
				username: "user",
				avatarColor: null,
				avatarImageId: null,
			})?.channel,
		).toBe("narrator");
	});

	test("runs the Bun upgrade gate before OAuth, JWT, user lookup, or server.upgrade effects", async () => {
		const source = await Bun.file(new URL("../../main.ts", import.meta.url)).text();
		const gate = source.indexOf("const narratorWsRefusal = narratorWebSocketBackendRefusal(");
		expect(gate).toBeGreaterThan(-1);
		for (const laterEffect of [
			"await startupReadiness.barrier",
			"const rollout = getExternalWebSocketRolloutSettings()",
			'const token = url.searchParams.get("token")',
			"const user = await db.query.users.findFirst",
			"const upgraded = server.upgrade(req",
		]) {
			expect(source.indexOf(laterEffect, gate)).toBeGreaterThan(gate);
		}
	});
});
