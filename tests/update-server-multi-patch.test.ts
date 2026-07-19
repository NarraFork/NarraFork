import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { createCheckRoutes } from "../update-server/routes/check";
import {
	createDownloadRoutes,
	MAX_RANGE_COUNT,
	MAX_RANGE_RESPONSE_BYTES,
} from "../update-server/routes/download";
import type { StorageBackend } from "../update-server/storage/types";
import type { ReleaseMeta, ZstdPatchMeta } from "../update-server/types";

class MemoryStorage implements StorageBackend {
	readonly files = new Map<string, Buffer>();

	async saveFile(path: string, data: Buffer | ReadableStream): Promise<void> {
		if (Buffer.isBuffer(data)) {
			this.files.set(path, Buffer.from(data));
			return;
		}
		this.files.set(path, Buffer.from(await new Response(data).arrayBuffer()));
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

class CancellationTrackingStorage extends MemoryStorage {
	cancelledStreams = 0;

	override async getFileSliceStream(): Promise<ReadableStream | null> {
		return new ReadableStream({
			cancel: () => {
				this.cancelledStreams += 1;
			},
		});
	}
}

class OversizedRangeStorage extends MemoryStorage {
	sliceRequested = false;

	override async getFileSize(): Promise<number | null> {
		return MAX_RANGE_RESPONSE_BYTES + 1;
	}

	override async getFileSliceStream(
		_path: string,
		_start: number,
		_end: number,
	): Promise<ReadableStream | null> {
		this.sliceRequested = true;
		return new Blob([]).stream();
	}
}

function createTestApp(storage: StorageBackend) {
	const app = new Hono();
	app.route("/api/v2/products", createCheckRoutes(storage));
	app.route("/api/v2/products", createDownloadRoutes(storage));
	return app;
}

function patchMeta(fromVersion: string, toVersion: string, patchSize: number): ZstdPatchMeta {
	return {
		fromVersion,
		toVersion,
		stableEnd: 0,
		newTailSize: 100,
		patchSize,
		newFileSize: 100,
		newFileSha512: "target-sha",
	};
}

describe("update server multi-base patches", () => {
	test("selects and downloads the exact direct patch for each client version", async () => {
		const storage = new MemoryStorage();
		const product = `multi-${randomUUID()}`;
		const version = "0.5.7";
		const platform = "linux-x64";
		const filename = "narrafork-0.5.7-linux-x64";
		const base = `products/${product}/releases/${version}/${platform}`;
		const meta: ReleaseMeta = {
			version,
			channel: "beta",
			releaseDate: "2026-07-13T00:00:00.000Z",
			platforms: {
				[platform]: {
					filename,
					size: 100,
					sha512: "target-sha",
					hasZstdPatch: true,
					zstdPatchFromVersion: "0.5.6",
					zstdPatchFromVersions: ["0.5.5", "0.5.6"],
				},
			},
		};
		await storage.saveFile(
			`products/${product}/releases/${version}/meta.json`,
			Buffer.from(JSON.stringify(meta)),
		);

		for (const fromVersion of ["0.5.5", "0.5.6"]) {
			const patch = Buffer.from(`patch-${fromVersion}`);
			const stem = `${filename}.from-${fromVersion}.zstd-patch`;
			await storage.saveFile(`${base}/${stem}`, patch);
			await storage.saveFile(
				`${base}/${stem}.meta.json`,
				Buffer.from(JSON.stringify(patchMeta(fromVersion, version, patch.length))),
			);
		}

		const app = createTestApp(storage);
		for (const fromVersion of ["0.5.5", "0.5.6"]) {
			const response = await app.request(
				`/api/v2/products/${product}/releases/latest?channel=beta&platform=${platform}&version=${fromVersion}`,
			);
			const body = (await response.json()) as {
				zstdPatch?: { fromVersion: string; url: string; metaUrl: string };
			};
			expect(body.zstdPatch?.fromVersion).toBe(fromVersion);
			expect(body.zstdPatch?.url).toContain(`fromVersion=${fromVersion}`);
			expect(body.zstdPatch?.metaUrl).toContain(`fromVersion=${fromVersion}`);

			const patchResponse = await app.request(body.zstdPatch?.url ?? "");
			expect(patchResponse.status).toBe(200);
			expect(await patchResponse.text()).toBe(`patch-${fromVersion}`);
		}
	});

	test("returns exact published release metadata", async () => {
		const storage = new MemoryStorage();
		const product = `metadata-${randomUUID()}`;
		const version = "0.5.10";
		const meta: ReleaseMeta = {
			version,
			channel: "beta",
			releaseDate: "2026-07-16T00:00:00.000Z",
			platforms: {
				"linux-x64": {
					filename: "narrafork-0.5.10-linux-x64",
					size: 123,
					sha512: "published-sha",
					hasZstdPatch: true,
				},
			},
		};
		await storage.saveFile(
			`products/${product}/releases/${version}/meta.json`,
			Buffer.from(JSON.stringify(meta)),
		);
		const app = createTestApp(storage);

		const response = await app.request(`/api/v2/products/${product}/releases/${version}/metadata`);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(meta);
		const missing = await app.request(`/api/v2/products/${product}/releases/0.5.99/metadata`);
		expect(missing.status).toBe(404);
	});

	test("keeps serving legacy canonical patch files", async () => {
		const storage = new MemoryStorage();
		const product = `legacy-${randomUUID()}`;
		const version = "0.5.7";
		const platform = "linux-x64";
		const filename = "narrafork-0.5.7-linux-x64";
		const base = `products/${product}/releases/${version}/${platform}`;
		const meta: ReleaseMeta = {
			version,
			channel: "beta",
			releaseDate: "2026-07-13T00:00:00.000Z",
			platforms: {
				[platform]: {
					filename,
					size: 100,
					sha512: "target-sha",
					hasZstdPatch: true,
					zstdPatchFromVersion: "0.5.6",
				},
			},
		};
		const patch = Buffer.from("legacy-patch");
		await storage.saveFile(
			`products/${product}/releases/${version}/meta.json`,
			Buffer.from(JSON.stringify(meta)),
		);
		await storage.saveFile(`${base}/${filename}.zstd-patch`, patch);
		await storage.saveFile(
			`${base}/${filename}.zstd-patch.meta.json`,
			Buffer.from(JSON.stringify(patchMeta("0.5.6", version, patch.length))),
		);

		const app = createTestApp(storage);
		const response = await app.request(
			`/api/v2/products/${product}/releases/latest?channel=beta&platform=${platform}&version=0.5.6`,
		);
		const body = (await response.json()) as { zstdPatch?: { url: string } };
		expect(body.zstdPatch?.url).not.toContain("fromVersion=");
		const patchResponse = await app.request(body.zstdPatch?.url ?? "");
		expect(await patchResponse.text()).toBe("legacy-patch");
	});

	test("serves bounded multipart ranges", async () => {
		const storage = new MemoryStorage();
		const product = `range-${randomUUID()}`;
		const version = "0.5.7";
		const filename = "narrafork-0.5.7-linux-x64";
		await storage.saveFile(
			`products/${product}/releases/${version}/linux-x64/${filename}`,
			Buffer.from("abcdefghijklmnopqrstuvwxyz"),
		);
		const app = createTestApp(storage);

		const response = await app.request(
			`/api/v2/products/${product}/releases/${version}/download/${filename}`,
			{ headers: { Range: "bytes=0-2,5-7" } },
		);
		const body = await response.text();
		expect(response.status).toBe(206);
		expect(response.headers.get("content-type")).toContain("multipart/byteranges");
		expect(body).toContain("abc");
		expect(body).toContain("fgh");
	});

	test("cancels every preflighted range stream when the client disconnects", async () => {
		const storage = new CancellationTrackingStorage();
		const product = `range-cancel-${randomUUID()}`;
		const version = "0.5.7";
		const filename = "narrafork-0.5.7-linux-x64";
		await storage.saveFile(
			`products/${product}/releases/${version}/linux-x64/${filename}`,
			Buffer.from("abcdefghijklmnopqrstuvwxyz"),
		);
		const app = createTestApp(storage);
		const response = await app.request(
			`/api/v2/products/${product}/releases/${version}/download/${filename}`,
			{ headers: { Range: "bytes=0-2,5-7" } },
		);
		const reader = response.body?.getReader();
		expect(reader).toBeDefined();
		await reader?.read();
		await reader?.cancel();
		expect(storage.cancelledStreams).toBe(2);
	});

	test("rejects excessive or oversized buffered ranges before reading slices", async () => {
		const storage = new MemoryStorage();
		const product = `range-count-${randomUUID()}`;
		const version = "0.5.7";
		const filename = "narrafork-0.5.7-linux-x64";
		await storage.saveFile(
			`products/${product}/releases/${version}/linux-x64/${filename}`,
			Buffer.from("abcdefghijklmnopqrstuvwxyz"),
		);
		const app = createTestApp(storage);
		const tooManyRanges = Array.from({ length: MAX_RANGE_COUNT + 1 }, () => "0-0").join(",");
		const tooMany = await app.request(
			`/api/v2/products/${product}/releases/${version}/download/${filename}`,
			{ headers: { Range: `bytes=${tooManyRanges}` } },
		);
		expect(tooMany.status).toBe(416);

		const oversizedStorage = new OversizedRangeStorage();
		const oversizedApp = createTestApp(oversizedStorage);
		const oversized = await oversizedApp.request(
			`/api/v2/products/${product}/releases/${version}/download/${filename}`,
			{ headers: { Range: "bytes=0-" } },
		);
		expect(oversized.status).toBe(416);
		expect(oversizedStorage.sliceRequested).toBe(false);
	});
});
