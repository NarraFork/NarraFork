import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { cleanDb } from "../../../tests/setup";
import { db, sqlite } from "../../db";
import { users } from "../../db/schema";
import { buildAppErrorResponse } from "../../lib/app-error-response";
import { createToken } from "../../lib/auth";
import { registerOperatorShutdownHandler } from "../../lib/server-restart";
import { invalidateUserCache } from "../../middleware/auth";
import { systemLifecycle } from "../../services/system-lifecycle-service";
import { resetUpdateCoordinationForTests } from "../../services/update-coordinator";
import { systemLifecycleRoutes } from "../system-lifecycle";

const app = new Hono().route("/api/system/lifecycle", systemLifecycleRoutes);
app.onError((error, c) => buildAppErrorResponse(error, c) ?? c.json({ error: String(error) }, 500));
let admin: string;
let member: string;
const restores: Array<() => void> = [];
beforeEach(async () => {
	cleanDb(sqlite);
	resetUpdateCoordinationForTests();
	registerOperatorShutdownHandler(null);
	for (const role of ["admin", "user"] as const) {
		const id = `lifecycle-${role}`;
		await db.insert(users).values({
			id,
			username: id,
			role,
			passwordHash: "unused",
			createdAt: new Date().toISOString(),
		});
		invalidateUserCache(id);
		const token = await createToken(id, role);
		if (role === "admin") admin = token;
		else member = token;
	}
});
afterEach(() => {
	for (const restore of restores.splice(0)) restore();
	registerOperatorShutdownHandler(null);
	resetUpdateCoordinationForTests();
	cleanDb(sqlite);
});
function request(path: string, token?: string) {
	return app.request(`/api/system/lifecycle/${path}`, {
		method: path === "status" ? "GET" : "POST",
		headers: token ? { Authorization: `Bearer ${token}` } : {},
	});
}

describe("system lifecycle administrator API", () => {
	test("all lifecycle endpoints reject unauthenticated and ordinary users", async () => {
		// Spies prove authorization prevents even entering the controller.
		const prepare = spyOn(systemLifecycle, "prepare");
		const shutdown = spyOn(systemLifecycle, "shutdown");
		const cancel = spyOn(systemLifecycle, "cancel");
		restores.push(
			() => prepare.mockRestore(),
			() => shutdown.mockRestore(),
			() => cancel.mockRestore(),
		);
		for (const path of ["status", "prepare", "shutdown", "cancel"]) {
			expect((await request(path)).status).toBe(401);
			expect((await request(path, member)).status).toBe(403);
		}
		expect(prepare).not.toHaveBeenCalled();
		expect(shutdown).not.toHaveBeenCalled();
		expect(cancel).not.toHaveBeenCalled();
	});

	test("administrator status is available, missing runtime handler is a conflict", async () => {
		const status = await request("status", admin);
		expect(status.status).toBe(200);
		expect(await status.json()).toMatchObject({ phase: "idle", shutdownRequested: false });
		for (const path of ["prepare", "shutdown"]) {
			const response = await request(path, admin);
			expect(response.status).toBe(409);
			expect(await response.json()).toMatchObject({ success: false });
		}
		expect((await request("cancel", admin)).status).toBe(202);
	});

	test("accepted operations return promptly without awaiting active work", async () => {
		const responseBody = {
			success: true as const,
			status: { ...systemLifecycle.status(), phase: "preparing" as const },
		};
		const prepare = spyOn(systemLifecycle, "prepare").mockReturnValue(responseBody);
		restores.push(() => prepare.mockRestore());
		const response = await request("prepare", admin);
		expect(response.status).toBe(202);
		expect(await response.json()).toEqual(JSON.parse(JSON.stringify(responseBody)));
		expect(prepare).toHaveBeenCalledTimes(1);
	});
});
