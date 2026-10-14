import { expect, mock, test } from "bun:test";
import { Hono } from "hono";

// Isolated route contract tests never initialize the real main database.
const calls: unknown[][] = [];
const service = {
	preview: async (...args: unknown[]) => {
		calls.push(args);
		return { phase: "none", canMigrate: true, revision: "a".repeat(64) };
	},
	migrate: async (...args: unknown[]) => {
		calls.push(args);
		return { phase: "cleanup_pending", narratorIds: ["n"], syncDisabled: true };
	},
};
mock.module("../services/legacy-project-migration", () => ({
	legacyProjectMigrationService: service,
}));
mock.module("../lib/project-access", () => ({
	projectPrincipalOf: () => ({ userId: "verified-owner", isAdmin: false }),
}));
const { legacyProjectMigrationRoutes } = await import("./legacy-project-migration");
const app = new Hono();
app.onError(() => new Response("invalid", { status: 400 }));
app.route("/api/projects", legacyProjectMigrationRoutes);
test("preview delegates verified principal and returns immutable preview", async () => {
	const result = await app.request("/api/projects/p/legacy-migration/preview?userId=attacker");
	expect(result.status).toBe(200);
	expect(calls.at(-1)).toEqual(["p", { userId: "verified-owner", isAdmin: false }]);
});
test("confirmation must be explicit, strict and include a valid revision", async () => {
	for (const body of [
		{ revision: "a".repeat(64) },
		{ confirm: false, revision: "a".repeat(64) },
		{ confirm: true, revision: "stale" },
		{ confirm: true, revision: "a".repeat(64), actorUserId: "attacker" },
	]) {
		const before = calls.length;
		const result = await app.request("/api/projects/p/legacy-migration", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		expect(result.status).toBe(400);
		expect(calls.length).toBe(before);
	}
});
test("cleanup pending returns 202 and delegates CAS plus verified actor", async () => {
	const result = await app.request("/api/projects/p/legacy-migration", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ confirm: true, revision: "a".repeat(64) }),
	});
	expect(result.status).toBe(202);
	expect(calls.at(-1)).toEqual(["p", { userId: "verified-owner", isAdmin: false }, "a".repeat(64)]);
});
