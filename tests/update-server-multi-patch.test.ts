import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { createCheckRoutes } from "../update-server/routes/check";
import { createDownloadRoutes } from "../update-server/routes/download";
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

	async getFileSlice(path: string, start: number, end: number): Promise<Buffer | null> {
		const value = this.files.get(path);
		return value ? value.subarray(start, end + 1) : null;
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
});
