import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { buildAppErrorResponse } from "@server/lib/app-error-response";
import { getNarraforkPath } from "@server/lib/narrafork-home";
import { tutorialRoutes } from "@server/routes/tutorial";
import { ERROR_CATALOG } from "@shared/error-catalog";
import { Hono } from "hono";

const app = new Hono();
app.route("/api/tutorial", tutorialRoutes);
app.onError(
	(error, c) => buildAppErrorResponse(error, c) ?? c.json({ error: "Unexpected error" }, 500),
);

describe("retired tutorial API", () => {
	for (const [method, path] of [
		["GET", ""],
		["GET", "/"],
		["GET", "/first-turn"],
		["GET", "/sandbox/status"],
		["POST", "/tool-calls/start"],
		["POST", "/first-turn/reset"],
		["PATCH", "/first-turn/progress"],
		["DELETE", "/unknown/path"],
	]) {
		test(`${method} ${path || "/"} returns a localizable 410 without provisioning`, async () => {
			const sandboxPath = getNarraforkPath("tutorial-workspace");
			expect(existsSync(sandboxPath)).toBe(false);
			const response = await app.request(`/api/tutorial${path}`, {
				method,
				// Deliberately invalid: retired writes must not even parse old payloads.
				...(method === "POST" || method === "PATCH"
					? { body: "not json", headers: { "Content-Type": "application/json" } }
					: {}),
			});
			expect(response.status).toBe(410);
			expect(await response.json()).toEqual({
				error: ERROR_CATALOG.TUTORIAL_REMOVED.en,
				code: "TUTORIAL_REMOVED",
				messageCode: "TUTORIAL_REMOVED",
			});
			expect(existsSync(sandboxPath)).toBe(false);
		});
	}

	test("does not intercept unrelated routes", async () => {
		const response = await app.request("/api/learning");
		expect(response.status).toBe(404);
	});
});
