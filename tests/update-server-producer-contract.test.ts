import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UpdateServerMirrorHttp } from "../scripts/lib/update-server-bridge-http";
import {
	IndependentMirrorError,
	mirrorPublishedMainRelease,
} from "../scripts/lib/update-server-main-mirror";
import { mergeUpdateIndex } from "../shared/update-index";
import { createApp } from "../update-server/app";
import { initConfig } from "../update-server/lib/config";
import { MirrorIngestService } from "../update-server/services/mirror-ingest";
import { LocalStorage } from "../update-server/storage/local";
import { mirrorFixture, repository, sha } from "./scripts/mirror-fixture";

test("real canonical CAS conflict makes producer refresh GitHub once and retry without re-uploading or rolling channels back", async () => {
	const directory = await mkdtemp(join(tmpdir(), "nf-real-mirror-cas-"));
	try {
		const configPath = join(directory, "config.json");
		const { adminToken } = await initConfig(configPath);
		const persisted = JSON.parse(await readFile(configPath, "utf8"));
		persisted.mirrorRepositories = { narrafork: repository };
		persisted.mirrorLimits = { quotaBytes: 1024 * 1024, minFreeBytes: 0, uploadTimeoutMs: 1000 };
		await writeFile(configPath, JSON.stringify(persisted));
		await initConfig(configPath);
		const storage = new LocalStorage(join(directory, "data"));
		const app = createApp(storage);
		const fixture = mirrorFixture(true, true);
		const config = { serverUrl: "https://only-in-process.invalid", token: adminToken as string };
		let intervened = false;
		let puts = 0;
		const snapshotStatuses: number[] = [];
		const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
			const path = new URL(String(input)).pathname;
			if (init?.method === "PUT") puts++;
			if (init?.method === "POST" && path.endsWith("/snapshot") && !intervened) {
				intervened = true;
				const incoming = JSON.parse(String(init.body));
				const nextRelease = structuredClone(fixture.release);
				nextRelease.version = "1.3.0";
				nextRelease.tag = "v1.3.0";
				delete nextRelease.notes;
				const file = nextRelease.files[0];
				file.name = "narrafork-1.3.0-linux-x64";
				file.metadata.name = `${file.name}.metadata.json`;
				file.patches = [];
				fixture.index = mergeUpdateIndex(fixture.index, nextRelease, repository);
				// A concurrent approved mirror commits the fresh canonical catalog first.
				const ahead = await app.request(path, {
					...init,
					body: JSON.stringify({
						...incoming,
						index: fixture.index,
						indexCommit: fixture.indexCommit,
					}),
				});
				expect(ahead.status).toBe(200);
			}
			const response = await app.request(path, init);
			if (init?.method === "POST" && path.endsWith("/snapshot"))
				snapshotStatuses.push(response.status);
			return response;
		}) as unknown as typeof fetch;
		const http = new UpdateServerMirrorHttp(config, { fetchImpl });
		const receipt = await mirrorPublishedMainRelease({
			kind: "main",
			repository,
			tag: fixture.release.tag,
			config,
			run: fixture.run,
			http,
			downloadAsset: fixture.downloadAsset,
		});
		expect(receipt.status).toBe("MIRRORED");
		expect(snapshotStatuses).toEqual([409, 200]);
		expect(puts).toBe(5);
		expect(fixture.downloaded).toHaveLength(2);
		const snapshot = JSON.parse(
			(await storage.getFile("mirror-snapshots/narrafork.json"))?.toString("utf8") ?? "null",
		);
		expect(snapshot.index.generation).toBe(2);
		expect(snapshot.index.channels.stable).toBe("1.3.0");
		expect(snapshot.targets.map((target: { version: string }) => target.version)).toContain(
			"1.2.0",
		);
		expect(fixture.indexReads).toBeGreaterThan(2);
		expect(await storage.listFiles("products")).toEqual([]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

for (const withPatch of [true, false]) {
	test(`actual producer commits an empty Hono/LocalStorage mirror using only server verification receipts (${withPatch ? "full-and-patch" : "full-only"})`, async () => {
		const directory = await mkdtemp(join(tmpdir(), "nf-real-mirror-contract-"));
		try {
			const configPath = join(directory, "config.json");
			const { adminToken } = await initConfig(configPath);
			const persisted = JSON.parse(await readFile(configPath, "utf8"));
			persisted.mirrorRepositories = { narrafork: repository };
			persisted.mirrorLimits = { quotaBytes: 1024 * 1024, minFreeBytes: 0, uploadTimeoutMs: 1000 };
			await writeFile(configPath, JSON.stringify(persisted));
			await initConfig(configPath);
			const storage = new LocalStorage(join(directory, "data"));
			const app = createApp(storage);
			const fixture = mirrorFixture(withPatch, true);
			const calls: { method: string; path: string; status: number }[] = [];
			const probes: number[] = [];
			let committed = false;
			const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
				const path = new URL(String(input)).pathname;
				const method = init?.method ?? "GET";
				expect(method).not.toBe("GET");
				const response = await app.request(path, init);
				calls.push({ method, path, status: response.status });
				if (method === "PUT" && response.status === 200) {
					const probe = await app.request(path);
					probes.push(probe.status);
					expect(probe.status).toBe(404);
				}
				if (method === "POST" && path.endsWith("/snapshot") && response.status === 200)
					committed = true;
				return response;
			}) as unknown as typeof fetch;
			const config = { serverUrl: "https://only-in-process.invalid", token: adminToken as string };
			const http = new UpdateServerMirrorHttp(config, { fetchImpl });
			const receipt = await mirrorPublishedMainRelease({
				kind: "main",
				repository,
				tag: fixture.release.tag,
				config,
				run: fixture.run,
				http,
				downloadAsset: fixture.downloadAsset,
			});
			expect(receipt.status).toBe("MIRRORED");
			expect(receipt.snapshotCommitted).toBe(true);
			expect(receipt.uploaded).toEqual(receipt.verified);
			expect(receipt.uploaded.length).toBe(withPatch ? 5 : 3);
			expect(probes).toHaveLength(receipt.uploaded.length);
			const commitPosition = calls.findIndex(
				(call) => call.method === "POST" && call.path.endsWith("/snapshot"),
			);
			expect(commitPosition).toBe(receipt.uploaded.length);
			expect(committed).toBe(true);
			expect(calls.filter((call) => call.method === "GET")).toEqual([]);
			const snapshot = JSON.parse(
				(await storage.getFile("mirror-snapshots/narrafork.json"))?.toString("utf8") ?? "null",
			);
			expect(snapshot.index).toEqual(fixture.index);
			for (const asset of (await new MirrorIngestService(storage).readMain("narrafork"))?.assets ??
				[]) {
				const bytes = await storage.getFile(`mirror-objects/${asset.sha256}`);
				expect(bytes?.length).toBe(asset.size);
				expect(sha(bytes as Buffer)).toBe(asset.sha256);
			}
			expect(await storage.listFiles("products")).toEqual([]);
			const fullBinary = fixture.release.files[0].sha256;
			expect(await storage.fileExists(`mirror-objects/${fullBinary}`)).toBe(true);
			expect(snapshot.targets[0].projectionVersion).toBe(2);
			const full = await app.request(`/api/v3/products/narrafork/mirror/assets/${fullBinary}`);
			expect(full.status).toBe(200);
			expect(sha(new Uint8Array(await full.arrayBuffer()))).toBe(fullBinary);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
}

test("actual upload acknowledgement identity failure prevents snapshot publication and leaves bytes private", async () => {
	const directory = await mkdtemp(join(tmpdir(), "nf-real-mirror-ack-"));
	try {
		const configPath = join(directory, "config.json");
		const { adminToken } = await initConfig(configPath);
		const persisted = JSON.parse(await readFile(configPath, "utf8"));
		persisted.mirrorRepositories = { narrafork: repository };
		persisted.mirrorLimits = { quotaBytes: 1024 * 1024, minFreeBytes: 0, uploadTimeoutMs: 1000 };
		await writeFile(configPath, JSON.stringify(persisted));
		await initConfig(configPath);
		const storage = new LocalStorage(join(directory, "data"));
		const app = createApp(storage);
		const fixture = mirrorFixture(false, false);
		const config = { serverUrl: "https://only-in-process.invalid", token: adminToken as string };
		const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
			const path = new URL(String(input)).pathname;
			const response = await app.request(path, init);
			if (init?.method === "PUT" && response.status === 200) {
				const ack = await response.json();
				return Response.json({ ...ack, sha256: "f".repeat(64) });
			}
			return response;
		}) as unknown as typeof fetch;
		const http = new UpdateServerMirrorHttp(config, { fetchImpl });
		let failure: IndependentMirrorError | undefined;
		try {
			await mirrorPublishedMainRelease({
				kind: "main",
				repository,
				tag: fixture.release.tag,
				config,
				run: fixture.run,
				http,
				downloadAsset: fixture.downloadAsset,
			});
		} catch (error) {
			if (!(error instanceof IndependentMirrorError)) throw error;
			failure = error;
		}
		expect(failure?.receipt.status).toBe("FAILED");
		expect(failure?.receipt.snapshotCommitted).toBe(false);
		expect(failure?.receipt.uploaded).toEqual([]);
		expect(failure?.receipt.verified).toEqual([]);
		expect(await storage.fileExists("mirror-snapshots/narrafork.json")).toBe(false);
		const metadataSha = fixture.release.files[0].metadata.sha256;
		expect(await storage.fileExists(`mirror-objects/${metadataSha}`)).toBe(true);
		expect(
			(await app.request(`/api/v3/products/narrafork/mirror/assets/${metadataSha}`)).status,
		).toBe(404);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
