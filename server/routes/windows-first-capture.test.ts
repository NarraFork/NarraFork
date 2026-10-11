import { afterEach, beforeEach, expect, test } from "bun:test";
import { canonicalWindowsFirstCaptureBytes } from "@shared/windows-first-capture";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db";
import { narrators, users } from "../db/schema";
import { createToken } from "../lib/auth";
import { AppError } from "../lib/errors";
import { generateId } from "../lib/id";
import { WINDOWS_FIRST_CAPTURE_CONFIG_ENV } from "../lib/windows-io-authority-first-capture-config";
import { invalidateUserCache, requireAuth } from "../middleware/auth";
import { windowsFirstCaptureRoutes } from "./windows-first-capture";

// Real JWT middleware + request-local opaque session + production route/composer.
// No production resolver/signer/custody replacement. Positive native capture is NOT claimed.
let userId: string;
let outsiderId: string;
let narratorId: string;
let token: string;
let outsideToken: string;
let app: Hono;
const original = process.env[WINDOWS_FIRST_CAPTURE_CONFIG_ENV];
beforeEach(async () => {
	delete process.env[WINDOWS_FIRST_CAPTURE_CONFIG_ENV];
	userId = generateId();
	outsiderId = generateId();
	narratorId = generateId();
	const now = new Date().toISOString();
	await db.insert(users).values(
		[userId, outsiderId].map((id) => ({
			id,
			username: id,
			role: "user" as const,
			passwordHash: "unit-not-a-credential",
			createdAt: now,
		})),
	);
	await db.insert(narrators).values({
		id: narratorId,
		title: "first-capture negative HTTP",
		ownerUserId: userId,
		visibility: "private",
		createdAt: now,
		updatedAt: now,
	});
	token = await createToken(userId, "user", 0);
	outsideToken = await createToken(outsiderId, "user", 0);
	app = new Hono();
	app.use("*", requireAuth);
	app.route("/api/narrators", windowsFirstCaptureRoutes);
	app.onError((error, c) =>
		error instanceof AppError
			? c.json({ code: error.code, error: error.message }, error.statusCode as 400)
			: c.json({ code: "unexpected" }, 500),
	);
});
afterEach(async () => {
	invalidateUserCache(userId);
	invalidateUserCache(outsiderId);
	await db.delete(narrators).where(eq(narrators.id, narratorId));
	await db.delete(users).where(inArray(users.id, [userId, outsiderId]));
	if (original === undefined) delete process.env[WINDOWS_FIRST_CAPTURE_CONFIG_ENV];
	else process.env[WINDOWS_FIRST_CAPTURE_CONFIG_ENV] = original;
});
const request = () => ({ path: "C:\\工作区\\original.txt", requestId: "unit_negative_request" });
function post(
	body: BodyInit = Buffer.from(canonicalWindowsFirstCaptureBytes(request())),
	bearer: string | undefined = token,
) {
	return app.request(`/api/narrators/${narratorId}/windows-metadata-captures`, {
		method: "POST",
		body,
		headers: {
			"content-type": "application/json",
			...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
		},
	});
}

test("actual signed first-party HTTP session reaches production unavailable gate without fallback", async () => {
	const response = await post();
	expect(response.status).toBe(503);
	expect(response.headers.get("cache-control")).toBe("no-store");
	const value = await response.json();
	expect(value.code).toBe("WINDOWS_FIRST_CAPTURE_ADMIN_CONFIGURATION_MISSING");
	expect(value).not.toHaveProperty("descriptor");
	expect(value).not.toHaveProperty("proof");
});

test("unauthenticated/bad JWT cannot enter first-capture session origin", async () => {
	for (const bearer of ["", "forged-jwt"]) expect((await post(undefined, bearer)).status).toBe(401);
});

test("authenticated outsider is denied narrator read, even before configuration gate", async () => {
	expect((await post(undefined, outsideToken)).status).toBe(404);
});

test("original token revocation remains effective on dedicated production entry", async () => {
	await db.update(users).set({ tokenVersion: 1 }).where(eq(users.id, userId));
	invalidateUserCache(userId);
	expect((await post()).status).toBe(401);
});

test("HTTP authority injection, unknown fields and duplicate/canonical substitutions are invalid", async () => {
	for (const body of [
		Buffer.from(canonicalWindowsFirstCaptureBytes({ ...request(), root: "forged" })),
		Buffer.from(canonicalWindowsFirstCaptureBytes({ ...request(), windowsFirstCaptureOrigin: {} })),
		'{"path":"C:\\\\a","path":"C:\\\\b","requestId":"unit_negative_request"}',
		JSON.stringify(request(), null, 2),
	]) {
		const response = await post(body);
		expect(response.status).toBe(400);
		expect((await response.json()).code).toBe("WINDOWS_FIRST_CAPTURE_INVALID_METADATA");
	}
});

test("metadata body is bounded at 16KiB before composer/native dispatch", async () => {
	const response = await post(" ".repeat(16385));
	expect(response.status).toBe(413);
	expect((await response.json()).code).toBe("WINDOWS_FIRST_CAPTURE_METADATA_TOO_LARGE");
});

test("no query/result/status or second HTTP phase is accidentally exposed", async () => {
	const headers = { authorization: `Bearer ${token}` };
	for (const suffix of ["status", "result", "capture", "preauthorize"])
		expect(
			(
				await app.request(`/api/narrators/${narratorId}/windows-metadata-captures/${suffix}`, {
					headers,
				})
			).status,
		).toBe(404);
});
