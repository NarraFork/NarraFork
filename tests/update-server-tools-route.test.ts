import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { addToken, initConfig } from "../update-server/lib/config";
import { createToolRoutes, isSafeToolFilename } from "../update-server/routes/tools";
import { LocalStorage, UnsafeStoragePathError } from "../update-server/storage/local";
import type { StorageBackend } from "../update-server/storage/types";

class MemoryStorage implements StorageBackend {
	readonly files = new Map<string, Buffer>();

	async saveFile(path: string, data: Buffer | ReadableStream): Promise<void> {
		this.files.set(
			path,
			Buffer.isBuffer(data)
				? Buffer.from(data)
				: Buffer.from(await new Response(data).arrayBuffer()),
		);
	}

	async getFile(path: string): Promise<Buffer | null> {
		const value = this.files.get(path);
		return value ? Buffer.from(value) : null;
	}

	async getFileStream(path: string): Promise<ReadableStream | null> {
		const value = this.files.get(path);
		return value ? new Blob([Uint8Array.from(value)]).stream() : null;
	}

	async getFileSize(path: string): Promise<number | null> {
		return this.files.get(path)?.length ?? null;
	}

	async deleteFile(path: string): Promise<void> {
		this.files.delete(path);
	}

	async deleteDirectory(path: string): Promise<void> {
		for (const key of this.files.keys()) {
			if (key === path || key.startsWith(`${path}/`)) this.files.delete(key);
		}
	}

	async listFiles(prefix: string): Promise<string[]> {
		return [...this.files.keys()].filter((key) => key.startsWith(prefix));
	}

	async fileExists(path: string): Promise<boolean> {
		return this.files.has(path);
	}

	async getFileSliceStream(
		path: string,
		start: number,
		end: number,
	): Promise<ReadableStream | null> {
		const value = this.files.get(path);
		return value ? new Blob([Uint8Array.from(value.subarray(start, end + 1))]).stream() : null;
	}
}

async function withApp(
	run: (ctx: { app: Hono; storage: MemoryStorage; uploadToken: string }) => Promise<void>,
): Promise<void> {
	const configDirectory = mkdtempSync(join(tmpdir(), "nf-update-tools-"));
	try {
		await initConfig(join(configDirectory, "config.json"));
		const { token: uploadToken } = await addToken("uploader", "upload");
		const storage = new MemoryStorage();
		const app = new Hono();
		app.route("/api/v2/tools", createToolRoutes(storage));
		await run({ app, storage, uploadToken });
	} finally {
		rmSync(configDirectory, { recursive: true, force: true });
	}
}

async function put(
	app: Hono,
	filename: string,
	token: string | null,
	body: Uint8Array,
): Promise<Response> {
	const headers: Record<string, string> = { "Content-Type": "application/octet-stream" };
	if (token) headers.Authorization = `Bearer ${token}`;
	return app.request(`/api/v2/tools/${filename}`, {
		method: "PUT",
		headers,
		body: body.byteLength === 0 ? undefined : new Blob([Uint8Array.from(body)]),
	});
}

test("tool upload stores the artifact and serves it back byte-identically", async () => {
	await withApp(async ({ app, storage, uploadToken }) => {
		const payload = new Uint8Array(Buffer.from("executor-binary-bytes".repeat(32)));
		const upload = await put(app, "narrafork-executor-1.2.3-linux-amd64", uploadToken, payload);
		expect(upload.status).toBe(200);
		const result = (await upload.json()) as { success: boolean; size: number; sha512: string };
		expect(result.success).toBe(true);
		expect(result.size).toBe(payload.byteLength);
		expect(result.sha512).toBe(
			new Bun.CryptoHasher("sha512").update(Buffer.from(payload)).digest("base64"),
		);
		expect(storage.files.has("tools/narrafork-executor-1.2.3-linux-amd64")).toBe(true);

		const download = await app.request("/api/v2/tools/narrafork-executor-1.2.3-linux-amd64");
		expect(download.status).toBe(200);
		expect(new Uint8Array(await download.arrayBuffer())).toEqual(payload);
	});
});

test("tool upload requires an authenticated upload-capable token", async () => {
	await withApp(async ({ app, storage }) => {
		const anonymous = await put(app, "anon-tool", null, new Uint8Array([1, 2, 3]));
		expect(anonymous.status).toBe(401);
		expect(storage.files.has("tools/anon-tool")).toBe(false);

		const badToken = await put(app, "anon-tool", "nfup_not_a_real_token", new Uint8Array([1]));
		expect(badToken.status).toBe(401);
		expect(storage.files.has("tools/anon-tool")).toBe(false);
	});
});

test("tool upload rejects empty bodies without clobbering a published artifact", async () => {
	await withApp(async ({ app, storage, uploadToken }) => {
		const original = new Uint8Array(Buffer.from("original-artifact"));
		expect((await put(app, "keeper", uploadToken, original)).status).toBe(200);

		const empty = await put(app, "keeper", uploadToken, new Uint8Array(0));
		expect(empty.status).toBe(400);
		expect(new Uint8Array(storage.files.get("tools/keeper") as Buffer)).toEqual(original);
	});
});

test("unsafe tool filenames are rejected on both download and upload", async () => {
	// Encoded traversal reaches the handler as a decoded path parameter, so the
	// filename guard has to run before any storage path is built.
	for (const filename of [
		"..%2F..%2Fconfig.json",
		"..",
		"sub%2Ftool",
		"tool%00",
		"%2Fetc%2Fpasswd",
	]) {
		await withApp(async ({ app, storage, uploadToken }) => {
			const upload = await put(app, filename, uploadToken, new Uint8Array([9]));
			expect(upload.status).not.toBe(200);
			expect(storage.files.size).toBe(0);

			const download = await app.request(`/api/v2/tools/${filename}`);
			expect(download.status).not.toBe(200);
		});
	}
});

test("isSafeToolFilename accepts release artifact names and rejects path syntax", () => {
	expect(isSafeToolFilename("narrafork-executor-0.5.24-windows-amd64.exe")).toBe(true);
	expect(isSafeToolFilename("narrafork-executor-manifest.json")).toBe(true);
	expect(isSafeToolFilename("rg-linux-x64")).toBe(true);
	expect(isSafeToolFilename("")).toBe(false);
	expect(isSafeToolFilename("..")).toBe(false);
	expect(isSafeToolFilename("../config.json")).toBe(false);
	expect(isSafeToolFilename("sub/tool")).toBe(false);
	expect(isSafeToolFilename("sub\\tool")).toBe(false);
	expect(isSafeToolFilename("tool\0")).toBe(false);
	expect(isSafeToolFilename("a".repeat(256))).toBe(false);
});

test("local storage refuses paths that escape the base directory", () => {
	const base = mkdtempSync(join(tmpdir(), "nf-update-storage-"));
	const outside = join(base, "..", `escape-${process.pid}.txt`);
	try {
		writeFileSync(outside, "untouched");
		const storage = new LocalStorage(join(base, "data"));
		expect(storage.getFileSize(`../escape-${process.pid}.txt`)).rejects.toThrow(
			UnsafeStoragePathError,
		);
		expect(storage.saveFile("../escaped.txt", Buffer.from("x"))).rejects.toThrow(
			UnsafeStoragePathError,
		);
		expect(readFileSync(outside, "utf8")).toBe("untouched");
	} finally {
		rmSync(base, { recursive: true, force: true });
		rmSync(outside, { force: true });
	}
});
