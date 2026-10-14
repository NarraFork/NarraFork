import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { AppError } from "../lib/errors";
import {
	createLegacyMigrationArtifactIo,
	type LegacyArtifactDescriptor,
} from "../services/legacy-migration-artifact-io";
import { createLegacyMigrationArtifactRoutes } from "./legacy-migration-artifacts";

let temp: string;
let app: Hono;
let seen: string[];
beforeEach(async () => {
	temp = await mkdtemp(join(tmpdir(), "nf-artifact-routes-"));
	const root = join(temp, "artifact");
	await mkdir(root);
	await writeFile(join(root, "file"), "archive");
	seen = [];
	const descriptor: LegacyArtifactDescriptor = {
		id: "artifact",
		sourceChapterId: "old",
		narratorId: "narrator",
		ownerUserId: "owner",
		kind: "ignored_archive",
		deviceId: "local",
		workspacePath: "/private/live",
		artifactPath: root,
		shadowKey: null,
		state: "claimed",
		manifestDigest: "secret digest",
		latestSnapshotCommitSha: null,
	};
	const service = createLegacyMigrationArtifactIo({
		authorize: async (id, principal) => {
			seen.push(principal.userId);
			return id === "artifact" && ["reader", "owner"].includes(principal.userId)
				? { ...descriptor }
				: null;
		},
		authorizeWrite: async (_descriptor, principal) => {
			if (principal.userId !== "owner") throw new AppError("Forbidden", 403, "FORBIDDEN");
		},
	});
	app = new Hono();
	// Test-only verified session seam: body/query never participate in authentication.
	app.use("*", async (c, next) => {
		const verified = c.req.header("X-Test-Verified-Session");
		if (verified) c.set("user", { sub: verified, role: "user", iat: 0, exp: 9999999999 });
		await next();
	});
	app.onError(
		(error) =>
			new Response(
				JSON.stringify({ code: error instanceof AppError ? error.code : "INTERNAL_ERROR" }),
				{
					status: error instanceof AppError ? error.statusCode : 500,
				},
			),
	);
	app.route("/api/legacy-migration-artifacts", createLegacyMigrationArtifactRoutes(service));
});
afterEach(async () => {
	await rm(temp, { recursive: true, force: true });
});

test("descriptor route exposes only small authorized projection", async () => {
	const response = await app.request("/api/legacy-migration-artifacts/artifact", {
		headers: { "X-Test-Verified-Session": "reader" },
	});
	expect(response.status).toBe(200);
	const body = await response.json();
	expect(body.kind).toBe("ignored_archive");
	expect(body.capabilities.restore).toBe(false);
	expect(body).not.toHaveProperty("artifactPath");
	expect(body).not.toHaveProperty("manifestDigest");
	expect(seen).toEqual(["reader"]);
});
test("missing auth cannot be replaced by body or query actor", async () => {
	const response = await app.request(
		"/api/legacy-migration-artifacts/artifact?userId=owner&isAdmin=true",
	);
	expect(response.status).toBe(404);
	expect(seen).toEqual([]);
});
test("file and entries handlers are usable and reject traversal/page overflow", async () => {
	const headers = { "X-Test-Verified-Session": "reader" };
	const file = await app.request("/api/legacy-migration-artifacts/artifact/file?path=file", {
		headers,
	});
	expect(file.status).toBe(200);
	expect(Buffer.from((await file.json()).content, "base64").toString()).toBe("archive");
	const entries = await app.request("/api/legacy-migration-artifacts/artifact/entries?limit=1", {
		headers,
	});
	expect(entries.status).toBe(200);
	expect((await entries.json()).entries).toEqual([{ path: "file", kind: "file" }]);
	for (const suffix of [
		"file?path=../secret",
		"entries?limit=101",
		"entries?cursor=-1",
		"tree?sha=HEAD",
	])
		expect(
			(await app.request(`/api/legacy-migration-artifacts/artifact/${suffix}`, { headers })).status,
		).toBe(400);
});
test("restore preview ignores user target paths and enforces verified write principal", async () => {
	const reader = await app.request("/api/legacy-migration-artifacts/artifact/restore-preview", {
		method: "POST",
		headers: { "X-Test-Verified-Session": "reader", "Content-Type": "application/json" },
		body: JSON.stringify({ actor: { userId: "owner", isAdmin: true }, targetPath: "/etc" }),
	});
	expect(reader.status).toBe(403);
	expect(seen.every((id) => id === "reader")).toBe(true);
	const owner = await app.request("/api/legacy-migration-artifacts/artifact/restore-preview", {
		method: "POST",
		headers: { "X-Test-Verified-Session": "owner" },
		body: "arbitrary target ignored",
	});
	expect(owner.status).toBe(200);
	expect(await owner.json()).toMatchObject({ readOnly: true, available: false });
});
