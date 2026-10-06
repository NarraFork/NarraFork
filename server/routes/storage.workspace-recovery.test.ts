import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { AppError } from "../lib/errors";

const calls: { action: string; input: unknown }[] = [];
const original = { ...(await import("../services/workspace-scope-recovery")) };
mock.module("../services/workspace-scope-recovery", () => ({
	...original,
	listWorkspaceBarriers: async () => ({ items: [], nextCursor: null }),
	retryWorkspaceRecoveryPersistence: async (scopeId: string) => {
		calls.push({ action: "retry", input: scopeId });
		return { retried: 1, remaining: 0 };
	},
	...Object.fromEntries(
		["begin", "observe", "commit", "cancel"].map((action) => [
			`${action}WorkspaceMaintenance`,
			async (input: unknown) => {
				calls.push({ action, input });
				return { ok: true };
			},
		]),
	),
}));
const { storageRoutes } = await import("./storage");
const app = new Hono();
app.use("*", async (c, next) => {
	const role = c.req.header("x-test-role");
	if (role)
		c.set("user", {
			sub: "authenticated-admin",
			role: role as "admin" | "user",
			iat: 0,
			exp: 9999999999,
		});
	await next();
});
app.onError(
	(error) =>
		new Response(JSON.stringify({ error: error.message }), {
			status: error instanceof AppError ? error.statusCode : 500,
		}),
);
app.route("/storage", storageRoutes);
const token = "a".repeat(64);
function request(action: string, body: unknown, role: string | null = "admin") {
	return app.request(`/storage/workspace-barriers/scope-a/maintenance/${action}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...(role ? { "x-test-role": role } : {}) },
		body: JSON.stringify(body),
	});
}
beforeEach(() => {
	calls.length = 0;
});
afterAll(() => mock.restore());
describe("administrator maintenance routes", () => {
	test("every maintenance action rejects anonymous and ordinary users", async () => {
		for (const action of ["begin", "observe", "commit", "cancel"]) {
			expect((await request(action, {}, null)).status).toBe(401);
			expect((await request(action, {}, "user")).status).toBe(403);
		}
		expect(calls).toEqual([]);
	});
	test("begin validates attestation and binds the authenticated admin, not client authority", async () => {
		expect(
			(await request("begin", { acknowledgeWritersStopped: false, operatorReason: "Stopped" }))
				.status,
		).toBe(400);
		expect(
			(
				await request("begin", {
					acknowledgeWritersStopped: true,
					operatorReason: "Stopped",
					assertAuthority: true,
				})
			).status,
		).toBe(400);
		expect(
			(
				await request("begin", {
					acknowledgeWritersStopped: true,
					operatorReason: "Stopped",
					leaseId: "lease-a",
				})
			).status,
		).toBe(200);
		expect(calls).toEqual([
			{
				action: "begin",
				input: {
					scopeId: "scope-a",
					leaseId: "lease-a",
					adminUserId: "authenticated-admin",
					acknowledgeWritersStopped: true,
					operatorReason: "Stopped",
				},
			},
		]);
	});
	test("observe/cancel require bounded capability tokens and commit cannot select another lease", async () => {
		for (const action of ["observe", "cancel"]) {
			expect((await request(action, { maintenanceToken: "invalid" })).status).toBe(400);
			expect((await request(action, { maintenanceToken: token })).status).toBe(200);
		}
		const commit = {
			maintenanceToken: token,
			confirmationToken: token,
			acknowledgements: [],
			acknowledgeInspected: true,
		};
		expect((await request("commit", { ...commit, leaseId: "other" })).status).toBe(400);
		expect((await request("commit", commit)).status).toBe(200);
		expect(calls.map((entry) => entry.action)).toEqual(["observe", "cancel", "commit"]);
		expect(calls[2]?.input).toMatchObject({
			adminUserId: "authenticated-admin",
			scopeId: "scope-a",
			maintenanceToken: token,
		});
	});
	test("scope-specific metadata retry requires administrator and does not run on GET", async () => {
		const url = "/storage/workspace-barriers/scope-a/retry-persistence";
		expect(
			(await app.request(url, { method: "POST", headers: { "x-test-role": "user" } })).status,
		).toBe(403);
		expect(
			(await app.request(url, { method: "POST", headers: { "x-test-role": "admin" } })).status,
		).toBe(200);
		expect(calls).toEqual([{ action: "retry", input: "scope-a" }]);
	});
	test("GET inventory does not start, renew or commit maintenance", async () => {
		expect(
			(await app.request("/storage/workspace-barriers", { headers: { "x-test-role": "admin" } }))
				.status,
		).toBe(200);
		expect(calls).toEqual([]);
	});
});
