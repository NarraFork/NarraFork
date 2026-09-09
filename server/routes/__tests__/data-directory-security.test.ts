import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, inArray } from "drizzle-orm";
import { app } from "../../app";
import { db } from "../../db";
import { users } from "../../db/schema";
import { createToken } from "../../lib/auth";
import { generateId } from "../../lib/id";
import * as home from "../../lib/narrafork-home";
import { invalidateUserCache } from "../../middleware/auth";

let root: string;
let data: string;
let admin: string;
let member: string;
const userIds: string[] = [];
let restoreHome: (() => void) | undefined;
const base = "http://localhost/api/settings/data-directory-security";

beforeEach(async () => {
	expect(process.env.NARRAFORK_TEST).toBe("1");
	root = await mkdtemp(join(await realpath(tmpdir()), "nf-directory-route-"));
	await chmod(root, 0o755);
	data = join(root, "appdata");
	await mkdir(data, { mode: 0o700 });
	await chmod(data, 0o777);
	const spy = spyOn(home, "getNarraforkHome").mockReturnValue(data);
	restoreHome = () => spy.mockRestore();
	for (const role of ["admin", "user"] as const) {
		const id = generateId();
		userIds.push(id);
		db.insert(users)
			.values({
				id,
				username: id,
				role,
				passwordHash: "unused",
				createdAt: new Date().toISOString(),
			})
			.run();
		const token = await createToken(id, role);
		if (role === "admin") admin = token;
		else member = token;
	}
});
afterEach(async () => {
	restoreHome?.();
	for (const id of userIds) invalidateUserCache(id);
	if (userIds.length)
		db.delete(users)
			.where(inArray(users.id, userIds.splice(0)))
			.run();
	await rm(root, { recursive: true, force: true });
});
function get(token?: string) {
	return app.request(base, { headers: token ? { authorization: `Bearer ${token}` } : {} });
}
function repair(token: string | undefined, body: unknown = { confirmed: true }) {
	return app.request(`${base}/repair`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(token ? { authorization: `Bearer ${token}` } : {}),
		},
		body: JSON.stringify(body),
	});
}

describe("data directory maintenance authorization", () => {
	test("unauthenticated requests cannot inspect or repair", async () => {
		expect((await get()).status).toBe(401);
		expect((await repair(undefined)).status).toBe(401);
	});
	test.skipIf(process.platform === "win32")(
		"ordinary users get only a redacted status and cannot repair",
		async () => {
			const response = await get(member);
			expect(response.status).toBe(200);
			expect(response.headers.get("Cache-Control")).toBe("no-store");
			expect(await response.json()).toEqual({ status: "restricted", canRepair: false });
			expect((await repair(member)).status).toBe(403);
			expect((await lstat(data)).mode & 0o777).toBe(0o777);
		},
	);
	test.skipIf(process.platform === "win32")(
		"administrator can inspect and confirm a leaf-only repair",
		async () => {
			const before = await get(admin);
			expect(await before.json()).toMatchObject({
				status: "restricted",
				canRepair: true,
				details: { path: data, mode: "0777" },
			});
			const repaired = await repair(admin);
			expect(repaired.status).toBe(200);
			expect(await repaired.json()).toEqual({ status: "ok", canRepair: false });
			expect((await lstat(data)).mode & 0o777).toBe(0o700);
			expect((await lstat(root)).mode & 0o777).toBe(0o755);
			expect(await (await repair(admin)).json()).toEqual({ status: "ok", canRepair: false });
		},
	);
	for (const body of [{}, { confirmed: false }, { confirmed: true, path: "/home/another-user" }]) {
		test(`rejects unconfirmed or arbitrary path input ${JSON.stringify(body)}`, async () => {
			expect((await repair(admin, body)).status).toBe(400);
		});
	}
	test("repair request body is bounded", async () => {
		expect((await repair(admin, { confirmed: true, padding: "x".repeat(2048) })).status).toBe(413);
	});
	test.skipIf(process.platform === "win32")(
		"downgrade while reading confirmation prevents repair and details disclosure",
		async () => {
			const entered = Promise.withResolvers<void>();
			const resume = Promise.withResolvers<void>();
			const originalText = Request.prototype.text;
			const spy = spyOn(Request.prototype, "text").mockImplementation(async function (
				this: Request,
			) {
				if (this.url === `${base}/repair`) {
					entered.resolve();
					await resume.promise;
				}
				return originalText.call(this);
			});
			try {
				const pending = repair(admin);
				await entered.promise;
				db.update(users).set({ role: "user" }).where(eq(users.id, userIds[0])).run();
				resume.resolve();
				const response = await pending;
				expect(response.status).toBe(403);
				expect(await response.text()).not.toContain(data);
				expect((await lstat(data)).mode & 0o777).toBe(0o777);
			} finally {
				resume.resolve();
				spy.mockRestore();
			}
		},
	);
	test("administrator role is checked against live account state", async () => {
		const adminId = userIds[0];
		db.update(users).set({ role: "user" }).where(eq(users.id, adminId)).run();
		invalidateUserCache(adminId);
		expect((await repair(admin)).status).toBe(403);
	});
});
