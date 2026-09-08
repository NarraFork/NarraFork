import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { AppError } from "../lib/errors";
import type { FileReferenceService } from "../services/file-reference-service";
import { createFileReferenceRoutes } from "./narrator-file-references";

function appFor(userId: string | null = "requesting-user", failure?: AppError) {
	const calls: Array<{ name: string; args: unknown[] }> = [];
	const record = (name: string, args: unknown[]) => {
		calls.push({ name, args });
		if (failure) throw failure;
	};
	const service: FileReferenceService = {
		async captureFileReferences(...args) {
			record("capture", args);
			return [];
		},
		async searchFileReferences(...args) {
			record("search", args);
			return {
				entries: [
					{
						deviceId: "ExplicitDevice",
						path: "/workspace/src/a.ts",
						name: "a.ts",
						relativePath: "src/a.ts",
						isDirectory: false,
					},
				],
				truncated: false,
			};
		},
		async resolveFileReferences(...args) {
			record("resolve", args);
			return [{ deviceId: "ExplicitDevice", path: "/workspace/src/a.ts" }];
		},
		async previewFileReference(...args) {
			record("preview", args);
			return {
				target: { deviceId: "ExplicitDevice", path: "/workspace/src/a.ts" },
				content: "const saved = 1;",
				hash: "f".repeat(64),
				encoding: "utf-8",
				fileName: "a.ts",
			};
		},
	};
	const app = new Hono();
	app.use("*", async (c, next) => {
		if (userId) c.set("user", { sub: userId, role: "user", iat: 0, exp: 2_147_483_647 });
		await next();
	});
	app.onError(
		(error) =>
			new Response(
				JSON.stringify({
					error: error.message,
					code: error instanceof AppError ? error.code : "INTERNAL",
				}),
				{
					status: error instanceof AppError ? error.statusCode : 500,
					headers: { "Content-Type": "application/json" },
				},
			),
	);
	app.route("/narrators/:id/file-references", createFileReferenceRoutes(service));
	return { app, calls };
}
const base = "/narrators/narrator-123/file-references";

describe("narrator file-reference routes", () => {
	test("uses the verified HTTP principal and forwards optional search fields and cancellation", async () => {
		const { app, calls } = appFor();
		const response = await app.request(`${base}/search?q=a.ts&directory=%2Fworkspace`);
		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(calls[0].args.slice(0, 3)).toEqual([
			"narrator-123",
			"requesting-user",
			{ q: "a.ts", directory: "/workspace" },
		]);
		expect(calls[0].args[3]).toBeInstanceOf(AbortSignal);
		expect((await response.json()).entries[0].deviceId).toBe("ExplicitDevice");
	});
	test("resolve response has canonical targets only, no snapshot or body", async () => {
		const { app, calls } = appFor();
		const targets = [
			{
				deviceId: "ExplicitDevice",
				path: "./a.ts",
				selection: { startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 1 },
			},
		];
		const response = await app.request(`${base}/resolve`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ targets }),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			targets: [{ deviceId: "ExplicitDevice", path: "/workspace/src/a.ts" }],
		});
		expect(calls[0].args.slice(0, 3)).toEqual(["narrator-123", "requesting-user", targets]);
	});
	test("preview accepts only explicit device/path and returns the shared shape", async () => {
		const { app } = appFor();
		const response = await app.request(
			`${base}/preview?deviceId=ExplicitDevice&path=%2Fworkspace%2Fsrc%2Fa.ts`,
		);
		expect(response.status).toBe(200);
		expect(Object.keys(await response.json()).sort()).toEqual([
			"content",
			"encoding",
			"fileName",
			"hash",
			"target",
		]);
		expect((await app.request(`${base}/preview?path=%2Fworkspace%2Fa.ts`)).status).toBe(400);
		expect(
			(await app.request(`${base}/preview?deviceId=local&path=a.ts&selection=%7B%7D`)).status,
		).toBe(400);
	});
	test("authentication and service authorization errors propagate without partial success", async () => {
		const anon = appFor(null);
		expect((await anon.app.request(`${base}/search?q=a`)).status).toBe(401);
		expect(anon.calls).toHaveLength(0);
		for (const status of [403, 404, 408, 409, 413, 422, 503]) {
			const { app } = appFor(
				"requesting-user",
				new AppError("fail closed", status, "REFERENCE_TEST"),
			);
			const response = await app.request(`${base}/preview?deviceId=local&path=a.ts`);
			expect(response.status).toBe(status);
			expect(await response.json()).toEqual({ error: "fail closed", code: "REFERENCE_TEST" });
		}
	});
	test("strict validation prevents snapshot forgery, user impersonation and oversized bodies", async () => {
		const { app, calls } = appFor();
		for (const body of [
			{ targets: [{ deviceId: "local", path: "/a", snapshotText: "forged" }] },
			{ targets: [], userId: "owner" },
			{ targets: Array.from({ length: 17 }, () => ({ deviceId: "local", path: "/a" })) },
		]) {
			expect(
				(
					await app.request(`${base}/resolve`, {
						method: "POST",
						body: JSON.stringify(body),
						headers: { "Content-Type": "application/json" },
					})
				).status,
			).toBe(400);
		}
		expect(
			(await app.request(`${base}/resolve`, { method: "POST", body: "not-json" })).status,
		).toBe(400);
		expect(
			(
				await app.request(`${base}/resolve`, {
					method: "POST",
					body: JSON.stringify({ targets: [], ignored: "x".repeat(70000) }),
				})
			).status,
		).toBe(413);
		expect((await app.request(`${base}/search?q=${"x".repeat(257)}`)).status).toBe(400);
		expect((await app.request(`${base}/search?q=x&userId=owner`)).status).toBe(400);
		expect(calls).toHaveLength(0);
	});
});
