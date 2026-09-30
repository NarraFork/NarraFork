import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { addToken, initConfig } from "../update-server/lib/config";
import { createReleaseRoutes } from "../update-server/routes/releases";
import type { StorageBackend } from "../update-server/storage/types";
import type { ReleaseMeta, ZstdPatchMeta } from "../update-server/types";

test("production HTTP entry allows bounded full release uploads above 128 MiB", () => {
	// app.request bypasses Bun.serve admission, so route tests alone cannot catch
	// an entry-point limit that rejects full binaries before authentication/routes.
	const entry = readFileSync(new URL("../update-server/index.ts", import.meta.url), "utf8");
	expect(entry).toMatch(/Bun\.serve\(\{[\s\S]*?maxRequestBodySize:\s*256\s*\*\s*1024\s*\*\s*1024/);
});

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

function makePatchMeta(targetSha: string, overrides: Partial<ZstdPatchMeta> = {}): ZstdPatchMeta {
	return {
		fromVersion: "0.5.10",
		toVersion: "0.5.11",
		oldFileSize: 100,
		oldFileSha512: "published-source-sha",
		stableEnd: 0,
		newTailSize: 120,
		patchSize: 5,
		newFileSize: 120,
		newFileSha512: targetSha,
		...overrides,
	};
}

function makeUploadForm(
	version: string,
	targetSha: string,
	patchMeta: ZstdPatchMeta,
	allowOverwrite = false,
): FormData {
	const patch = Buffer.from("patch");
	const form = new FormData();
	form.append("version", version);
	form.append("channel", "beta");
	form.append("platform", "linux-x64");
	form.append("filename", `narrafork-${version}-linux-x64`);
	form.append("size", "120");
	form.append("sha512", targetSha);
	form.append("zstdPatch", new Blob([patch]), "patch.zst");
	form.append("zstdPatchMeta", new Blob([JSON.stringify(patchMeta)]), "patch.meta.json");
	if (allowOverwrite) form.append("allowOverwrite", "true");
	return form;
}

function makeFullUploadForm(
	version: string,
	binary: Buffer,
	patchMeta: ZstdPatchMeta,
	allowOverwrite = false,
): FormData {
	const form = new FormData();
	form.append("version", version);
	form.append("channel", "beta");
	form.append("platform", "linux-x64");
	form.append("file", new Blob([Uint8Array.from(binary)]), `narrafork-${version}-linux-x64`);
	form.append("zstdPatch", new Blob([Uint8Array.from(Buffer.from("patch"))]), "patch.zst");
	form.append("zstdPatchMeta", new Blob([JSON.stringify(patchMeta)]), "patch.meta.json");
	if (allowOverwrite) form.append("allowOverwrite", "true");
	return form;
}

function snapshotFiles(storage: MemoryStorage, prefix: string): Array<[string, Buffer]> {
	return [...storage.files.entries()]
		.filter(([path]) => path.startsWith(prefix))
		.map(([path, value]) => [path, Buffer.from(value)] as [string, Buffer])
		.sort(([left], [right]) => left.localeCompare(right));
}

test("release upload route keeps published platform identities immutable", async () => {
	const configDirectory = mkdtempSync(join(tmpdir(), "nf-update-integrity-"));
	try {
		const { adminToken } = await initConfig(join(configDirectory, "config.json"));
		expect(adminToken).toBeTruthy();
		const { token: uploadToken } = await addToken("uploader", "upload");
		const storage = new MemoryStorage();
		const product = `integrity-${crypto.randomUUID()}`;
		const sourceMeta: ReleaseMeta = {
			version: "0.5.10",
			channel: "beta",
			releaseDate: "2026-07-16T00:00:00.000Z",
			platforms: {
				"linux-x64": {
					filename: "narrafork-0.5.10-linux-x64",
					size: 100,
					sha512: "published-source-sha",
					hasZstdPatch: true,
				},
			},
		};
		await storage.saveFile(
			`products/${product}/releases/0.5.10/meta.json`,
			Buffer.from(JSON.stringify(sourceMeta)),
		);
		const app = new Hono();
		app.route("/api/v2/products", createReleaseRoutes(storage));
		const upload = (token: string, form: FormData) =>
			app.request(`/api/v2/products/${product}/releases`, {
				method: "POST",
				headers: { Authorization: `Bearer ${token}` },
				body: form,
			});

		const releasePath = `products/${product}/releases/0.5.11`;
		const binaryPath = `${releasePath}/linux-x64/narrafork-0.5.11-linux-x64`;
		const oldBinary = Buffer.alloc(120, 0x61);
		const oldSha = createHash("sha512").update(oldBinary).digest("base64");
		const newBinary = Buffer.alloc(120, 0x62);
		const newSha = createHash("sha512").update(newBinary).digest("base64");
		const initial = await upload(
			adminToken as string,
			makeUploadForm("0.5.11", oldSha, makePatchMeta(oldSha)),
		);
		expect(initial.status).toBe(200);
		await storage.saveFile(binaryPath, oldBinary);

		const sameIdentityRetry = await upload(
			uploadToken,
			makeUploadForm("0.5.11", oldSha, makePatchMeta(oldSha)),
		);
		expect(sameIdentityRetry.status).toBe(200);

		const publishedSnapshot = snapshotFiles(storage, releasePath);
		const defaultImmutable = await upload(
			adminToken as string,
			makeUploadForm("0.5.11", newSha, makePatchMeta(newSha)),
		);
		expect(defaultImmutable.status).toBe(409);
		expect(snapshotFiles(storage, releasePath)).toEqual(publishedSnapshot);

		const ignoredUploaderOverride = await upload(
			uploadToken,
			makeUploadForm("0.5.11", newSha, makePatchMeta(newSha), true),
		);
		expect(ignoredUploaderOverride.status).toBe(409);
		expect(snapshotFiles(storage, releasePath)).toEqual(publishedSnapshot);

		const ignoredAdminDeltaOverride = await upload(
			adminToken as string,
			makeUploadForm("0.5.11", newSha, makePatchMeta(newSha), true),
		);
		expect(ignoredAdminDeltaOverride.status).toBe(409);
		expect(snapshotFiles(storage, releasePath)).toEqual(publishedSnapshot);

		const ignoredAdminFullOverride = await upload(
			adminToken as string,
			makeFullUploadForm("0.5.11", newBinary, makePatchMeta(newSha), true),
		);
		expect(ignoredAdminFullOverride.status).toBe(409);
		expect(snapshotFiles(storage, releasePath)).toEqual(publishedSnapshot);

		const invalidSourceMeta = makePatchMeta("target-c", {
			toVersion: "0.5.12",
			oldFileSha512: "overwritten-local-source",
		});
		const invalidSource = await upload(
			adminToken as string,
			makeUploadForm("0.5.12", "target-c", invalidSourceMeta),
		);
		expect(invalidSource.status).toBe(400);
		expect(await storage.fileExists(`products/${product}/releases/0.5.12/meta.json`)).toBe(false);
	} finally {
		rmSync(configDirectory, { recursive: true, force: true });
	}
});
