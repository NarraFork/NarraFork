import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Hono } from "hono";
import { sign } from "hono/jwt";
import { buildAppErrorResponse } from "../../lib/app-error-response";
import { settings } from "../../lib/settings";
import { getAvatarPath, saveAvatarImage, setUploadsDirForTests } from "../../lib/uploads";
import type { AuthSessionStore } from "../../services/auth/session-store";
import { authMfaStore, authSessionStore, setAuthStores } from "../../services/auth/store";
import { authRoutes } from "../auth";

const app = new Hono();
app.route("/api/auth", authRoutes);
app.onError((error, c) => buildAppErrorResponse(error, c) ?? c.json({ error: "Internal" }, 500));

function pngHeader(width: number, height: number): ArrayBuffer {
	const buffer = new ArrayBuffer(24);
	const bytes = new Uint8Array(buffer);
	bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const view = new DataView(buffer);
	view.setUint32(8, 13);
	bytes.set([0x49, 0x48, 0x44, 0x52], 12);
	view.setUint32(16, width);
	view.setUint32(20, height);
	return buffer;
}

async function sessionToken(userId: string): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	return sign(
		{ sub: userId, role: "user", iat: now, exp: now + 3600, sv: 0 },
		settings.auth.jwtSecret,
	);
}

afterEach(() => {
	setAuthStores(undefined);
	setUploadsDirForTests(null);
});

describe("auth avatar replacement rollback", () => {
	test("a database failure removes only the new file and preserves the old avatar", async () => {
		const root = mkdtempSync(resolve(tmpdir(), "narrafork-auth-avatar-rollback-"));
		const userId = "auth-avatar-rollback-user";
		try {
			setUploadsDirForTests(root);
			const old = await saveAvatarImage(
				userId,
				new File([pngHeader(16, 16)], "old.png", { type: "image/png" }),
			);
			const oldPath = getAvatarPath(userId, old.imageId);
			expect(oldPath).not.toBeNull();

			const original = authSessionStore;
			const failingStore: AuthSessionStore = {
				...original,
				findSessionState: async (id) => ({ id, role: "user", tokenVersion: 0 }),
				findSessionProfile: async (id) => ({
					id,
					username: "avatar-user",
					role: "user",
					avatarColor: null,
					avatarImageId: old.imageId,
					gitUsername: null,
					gitEmail: null,
					createdAt: new Date().toISOString(),
					tokenVersion: 0,
					language: "en",
				}),
				setAvatarImage: async () => {
					throw new Error("database unavailable");
				},
			};
			setAuthStores({ session: failingStore, mfa: authMfaStore });

			const form = new FormData();
			form.set("file", new File([pngHeader(32, 24)], "new.png", { type: "image/png" }));
			const response = await app.request("/api/auth/me/avatar", {
				method: "PATCH",
				headers: { Authorization: `Bearer ${await sessionToken(userId)}` },
				body: form,
			});
			expect(response.status).toBe(500);
			expect(getAvatarPath(userId, old.imageId)).toBe(oldPath);
			expect(readdirSync(resolve(root, "avatars", userId))).toEqual([`${old.imageId}.png`]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
