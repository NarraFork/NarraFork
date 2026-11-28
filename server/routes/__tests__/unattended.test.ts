import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { cleanDb } from "../../../tests/setup";
import { db, sqlite } from "../../db";
import { users } from "../../db/schema";
import { buildAppErrorResponse } from "../../lib/app-error-response";
import { createToken } from "../../lib/auth";

/**
 * The route is tested against a fake service: the real singleton would start a 5 s poll
 * timer and touch the runtime registry, neither of which belongs in an HTTP contract test.
 * Service behaviour is covered by `services/__tests__/unattended-mode.test.ts`.
 */
function fixtureStatus() {
	return {
		enabled: false,
		phase: "off" as "off" | "waiting" | "quiet" | "shutting_down",
		armedAt: null as string | null,
		quietSince: null as string | null,
		shutdownAt: null as string | null,
		pollIntervalMs: 5_000,
		checkedAt: null as string | null,
		blocked: false,
		options: {
			powerOff: true,
			powerOffCommand: null as string | null,
			quietSeconds: 120,
			armDelaySeconds: 60,
		},
		blockers: {
			narrators: 0,
			compacting: 0,
			queuedDeliveries: false,
			backgroundTasks: false,
			dueScheduledTasks: false,
			maintenance: false,
			unknown: false,
		},
		powerOffPlan: {
			supported: true,
			command: ["/usr/bin/systemctl", "poweroff"],
			note: undefined as string | undefined,
		},
		diagnostics: {
			narratorIds: ["narrator-secret"],
			executions: {
				backgroundBash: 0,
				ordinary: 0,
				responses: 0,
				preAdmission: 0,
				toolStartGrants: 0,
				pausedTools: 0,
			},
			dbWorkingNarrators: 0,
			pendingPublications: false,
		},
		lastError: "secret-diagnostic" as string | undefined,
	};
}

let status = fixtureStatus();
const calls: Array<{ action: "enable" | "disable"; options?: unknown }> = [];

mock.module("../../services/unattended-mode", () => ({
	UNATTENDED_SHUTDOWN_REASON: "unattended_idle",
	unattendedMode: {
		status: () => status,
		enable: (options: Record<string, unknown>) => {
			calls.push({ action: "enable", options });
			status = {
				...status,
				enabled: true,
				phase: "waiting",
				quietSince: new Date().toISOString(),
				options: { ...status.options, ...options },
			};
			return status;
		},
		disable: () => {
			calls.push({ action: "disable" });
			if (status.phase === "shutting_down") {
				return { success: false, error: "already_shutting_down", status };
			}
			status = { ...status, enabled: false, phase: "off" };
			return { success: true, status };
		},
	},
}));

const { unattendedRoutes } = await import("../unattended");

const app = new Hono().route("/api/system/unattended", unattendedRoutes);
app.onError((error, c) => buildAppErrorResponse(error, c) ?? c.json({ error: String(error) }, 500));

let admin: string;
let member: string;

beforeEach(async () => {
	cleanDb(sqlite);
	status = fixtureStatus();
	calls.length = 0;
	for (const role of ["admin", "user"] as const) {
		const id = `unattended-${role}`;
		await db.insert(users).values({
			id,
			username: id,
			role,
			passwordHash: "unused",
			createdAt: new Date().toISOString(),
		});
		const token = await createToken(id);
		if (role === "admin") admin = token;
		else member = token;
	}
});

afterEach(() => {
	cleanDb(sqlite);
});

afterAll(() => mock.restore());

function get(token?: string) {
	return app.request("/api/system/unattended", {
		headers: token ? { Authorization: `Bearer ${token}` } : {},
	});
}

function post(body: unknown, token?: string) {
	return app.request("/api/system/unattended", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
		body: JSON.stringify(body),
	});
}

function cancel(token?: string) {
	return app.request("/api/system/unattended/cancel", {
		method: "POST",
		headers: token ? { Authorization: `Bearer ${token}` } : {},
	});
}

describe("unattended mode HTTP surface", () => {
	test("anonymous callers are rejected", async () => {
		expect((await get()).status).toBe(401);
		expect((await post({ enabled: true })).status).toBe(401);
		expect((await cancel()).status).toBe(401);
	});

	test("administrators see the full status", async () => {
		const response = await get(admin);
		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		const body = (await response.json()) as Record<string, unknown>;
		expect(body.phase).toBe("off");
		expect(body.powerOffPlan).toBeDefined();
		expect(body.diagnostics).toBeDefined();
		expect(body.lastError).toBe("secret-diagnostic");
	});

	test("ordinary users see the banner summary without administrative detail", async () => {
		const response = await get(member);
		expect(response.status).toBe(200);
		const body = (await response.json()) as Record<string, unknown>;
		expect(body.phase).toBe("off");
		expect(body.blockers).toBeDefined();
		expect(body.options).toEqual({ powerOff: true, quietSeconds: 120, armDelaySeconds: 60 });
		expect(body.powerOffPlan).toBeUndefined();
		expect(body.diagnostics).toBeUndefined();
		expect(body.lastError).toBeUndefined();
		expect(JSON.stringify(body)).not.toContain("narrator-secret");
	});

	test("only administrators may arm or change the mode", async () => {
		expect((await post({ enabled: true }, member)).status).toBe(403);
		const response = await post({ enabled: true }, admin);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { success: boolean; status: { enabled: boolean } };
		expect(body.success).toBe(true);
		expect(body.status.enabled).toBe(true);
		expect(calls).toEqual([{ action: "enable", options: {} }]);
	});

	test("administrators may disarm the mode", async () => {
		await post({ enabled: true }, admin);
		const response = await post({ enabled: false }, admin);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { status: { phase: string } };
		expect(body.status.phase).toBe("off");
	});

	test("invalid options are rejected instead of silently clamped", async () => {
		expect((await post({ enabled: true, quietSeconds: 1 }, admin)).status).toBe(400);
		expect((await post({ enabled: true, quietSeconds: 86_401 }, admin)).status).toBe(400);
		expect((await post({ enabled: true, armDelaySeconds: -1 }, admin)).status).toBe(400);
		expect((await post({ enabled: true, armDelaySeconds: 60 }, admin)).status).toBe(400);
		expect((await post({ enabled: true, armDelaySeconds: 70 }, admin)).status).toBe(200);
		expect((await post({ enabled: true, powerOffCommand: "a\nb" }, admin)).status).toBe(400);
		expect((await post({ enabled: true, unknownKey: 1 }, admin)).status).toBe(400);
		expect((await post({}, admin)).status).toBe(400);
	});

	test("any signed-in user may cancel — the safety valve is not admin-only", async () => {
		await post({ enabled: true }, admin);
		const response = await cancel(member);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { success: boolean; status: { phase: string } };
		expect(body.success).toBe(true);
		expect(body.status.phase).toBe("off");
		expect(calls.at(-1)).toEqual({ action: "disable" });
	});

	test("cancelling after the shutdown began reports a conflict", async () => {
		status = { ...status, enabled: true, phase: "shutting_down" };
		const response = await cancel(member);
		expect(response.status).toBe(409);
		const body = (await response.json()) as { success: boolean };
		expect(body.success).toBe(false);
	});
});
