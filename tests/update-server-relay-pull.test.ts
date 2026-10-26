import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertServerVerified, MirrorRelayStage } from "../scripts/lib/mirror-relay-stage";
import { mirrorPublishedMainRelease } from "../scripts/lib/update-server-main-mirror";
import { type MirrorSnapshotV1, mirrorAssetsForTarget } from "../shared/independent-update-mirror";
import {
	createRelayReady,
	RELAY_TTL_MS,
	type RelayReadyManifest,
	relayObjectPath,
	relayReadyDirectory,
	relayReadyPath,
} from "../shared/mirror-relay";
import {
	EXECUTOR_MANIFEST_FILENAME,
	EXECUTOR_PLATFORMS,
	executorPublishedFilename,
} from "../shared/remote-executor";
import { WebDavClient } from "../shared/webdav-transport";
import { createApp } from "../update-server/app";
import { initConfig } from "../update-server/lib/config";
import { resolveMirrorRelaySettings } from "../update-server/lib/mirror-relay-config";
import { MirrorIngestService } from "../update-server/services/mirror-ingest";
import {
	MirrorRelayPuller,
	type RelayPullEvent,
} from "../update-server/services/mirror-relay-pull";
import { LocalStorage } from "../update-server/storage/local";
import type { ServerConfig } from "../update-server/types";
import { createWebDavFixture } from "./fixtures/webdav-fixture";
import { mirrorFixture, repository } from "./scripts/mirror-fixture";

const key = Buffer.alloc(32, 8).toString("base64");
const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const root = "/api/v3/products/narrafork/mirror";
const hash = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const signal = () => AbortSignal.timeout(10_000);

async function setup(
	intercept?: NonNullable<Parameters<typeof createWebDavFixture>[0]>["intercept"],
	mirrorLimits?: ServerConfig["mirrorLimits"],
	relayBudgets: { totalTimeoutMinutes?: number; transferTimeoutMinutes?: number } = {},
) {
	const directory = mkdtempSync(join(tmpdir(), "nf-relay-pull-"));
	const path = join(directory, "config.json");
	writeFileSync(
		path,
		JSON.stringify({
			tokens: [],
			port: 7780,
			host: "localhost",
			dataDir: "data",
			mirrorRepositories: { narrafork: repository },
			mirrorLimits,
			storage: { type: "local" },
			cors: { enabled: false, origins: [] },
			mirrorRelay: {
				...relayBudgets,
				enabled: true,
				url: "https://dav.example.test/private/",
				feed: "default",
				usernameEnv: "DAV_USER",
				passwordEnv: "DAV_PASSWORD",
				signingKeyEnv: "RELAY_KEY",
			},
		}),
	);
	await initConfig(path);
	const storage = new LocalStorage(join(directory, "data"));
	const ingest = new MirrorIngestService(storage);
	const app = createApp(storage, ingest);
	const dav = createWebDavFixture({ intercept });
	const settings = resolveMirrorRelaySettings(
		{
			mirrorRepositories: { narrafork: repository },
			mirrorRelay: {
				...relayBudgets,
				enabled: true,
				url: dav.baseUrl,
				usernameEnv: "DAV_USER",
				passwordEnv: "DAV_PASSWORD",
				signingKeyEnv: "RELAY_KEY",
			},
		},
		{ DAV_USER: "reader", DAV_PASSWORD: "private-pass", RELAY_KEY: key },
	);
	if (!settings) throw new Error("Expected relay settings");
	const clock = { now: NOW };
	const events: RelayPullEvent[] = [];
	const makePuller = () =>
		new MirrorRelayPuller(storage, ingest, settings, {
			fetchImpl: dav.fetchImpl,
			now: () => clock.now,
			onEvent: (event) => events.push(event),
		});
	const client = new WebDavClient(settings.webdav, { fetchImpl: dav.fetchImpl });
	const puller = makePuller();
	return {
		directory,
		storage,
		ingest,
		app,
		dav,
		settings,
		clock,
		events,
		client,
		puller,
		makePuller,
		async close() {
			await puller.stop();
			rmSync(directory, { recursive: true, force: true });
		},
	};
}
type Context = Awaited<ReturnType<typeof setup>>;

/** Stage exact canonical bytes without calling any update-server endpoint. */
async function stage(
	ctx: Context,
	options: { jobId?: string; patch?: boolean; now?: number; signingKey?: string } = {},
) {
	const f = mirrorFixture(options.patch ?? true, true);
	const snapshot: MirrorSnapshotV1 = {
		schemaVersion: 1,
		repository,
		index: f.index,
		indexCommit: f.indexCommit,
		targetVersion: f.release.version,
		assets: mirrorAssetsForTarget(f.index, f.release.version),
	};
	const payload = Buffer.from(JSON.stringify(snapshot));
	const now = options.now ?? ctx.clock.now;
	const manifest: RelayReadyManifest = {
		schemaVersion: 1,
		feed: "default",
		product: "narrafork",
		repository,
		kind: "main",
		tag: f.release.tag,
		jobId: options.jobId ?? "job-1",
		createdAt: new Date(now).toISOString(),
		expiresAt: new Date(now + RELAY_TTL_MS).toISOString(),
		payload: { size: payload.length, sha256: hash(payload) },
	};
	const objectDirectory = relayObjectPath(manifest, manifest.payload.sha256)
		.split("/")
		.slice(0, -1)
		.join("/");
	await ctx.client.ensureCollection(objectDirectory, signal());
	for (const asset of snapshot.assets) {
		const bytes = asset.kind === "notes" ? Buffer.from(f.notesRaw) : f.raw.get(asset.name);
		if (!bytes) throw new Error("Missing canonical test bytes");
		await ctx.client.put(relayObjectPath(manifest, asset.sha256), bytes, asset, signal());
	}
	await ctx.client.put(
		relayObjectPath(manifest, manifest.payload.sha256),
		payload,
		manifest.payload,
		signal(),
	);
	const ready = createRelayReady(manifest, options.signingKey ?? key);
	await ctx.client.ensureCollection(
		relayReadyDirectory("default", "narrafork", "main", manifest.createdAt.slice(0, 10)),
		signal(),
	);
	await ctx.client.put(
		relayReadyPath(manifest, ready.manifestHash),
		ready.bytes,
		{ size: ready.bytes.length, sha256: hash(ready.bytes) },
		signal(),
	);
	const url = (path: string) => new URL(path, ctx.dav.baseUrl).pathname;
	return {
		f,
		snapshot,
		manifest,
		ready,
		readyPath: url(relayReadyPath(manifest, ready.manifestHash)),
		payloadPath: url(relayObjectPath(manifest, manifest.payload.sha256)),
		assetPath: (sha256: string) => url(relayObjectPath(manifest, sha256)),
	};
}

async function pollUntilSeen(ctx: Context, count = 1) {
	let committed = 0;
	let failed = 0;
	for (let i = 0; i < 6 && committed + failed < count; i++) {
		const result = await ctx.puller.pollOnce();
		committed += result.committed;
		failed += result.failed;
	}
	return { committed, failed };
}

test("actual optional pull imports patch/metadata through WebDAV, server verifies and serves only committed bytes", async () => {
	const ctx = await setup();
	try {
		const staged = await stage(ctx);
		expect((await ctx.app.request(`${root}/index`)).status).toBe(404);
		const start = ctx.dav.requests.length;
		expect(await pollUntilSeen(ctx)).toEqual({ committed: 1, failed: 0 });
		const requests = ctx.dav.requests.slice(start);
		expect(requests.length).toBeGreaterThan(0);
		expect(requests.every((r) => ["GET", "PROPFIND"].includes(r.method))).toBe(true);
		expect(requests.filter((r) => r.method === "GET" && r.path.includes("/objects/")).length).toBe(
			staged.snapshot.assets.length + 1,
		);
		const index = await (await ctx.app.request(`${root}/index`)).json();
		expect(index).toEqual(staged.f.index);
		for (const asset of staged.snapshot.assets) {
			const response = await ctx.app.request(`${root}/assets/${asset.sha256}`);
			expect(response.status).toBe(200);
			expect(hash(new Uint8Array(await response.arrayBuffer()))).toBe(asset.sha256);
		}
		expect(ctx.events.some((event) => event.code === "COMMITTED")).toBe(true);
		const state = await ctx.storage.getFile("mirror-relay-state/default/narrafork.json");
		expect(state?.toString()).toContain("COMMITTED");
		const log = JSON.stringify(ctx.events);
		for (const sensitive of [key, "private-pass", "dav.example.test", "https:"])
			expect(log).not.toContain(sensitive);
	} finally {
		await ctx.close();
	}
});

for (const cap of [undefined, 120_000])
	test(`configured relay job/stream deadlines reach real ingest (operator cap=${cap})`, async () => {
		const ctx = await setup(undefined, cap === undefined ? undefined : { uploadTimeoutMs: cap }, {
			totalTimeoutMinutes: 30,
			transferTimeoutMinutes: 20,
		});
		const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
		const deadlines: number[] = [];
		const selected = spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
			deadlines.push(ms);
			return nativeTimeout(ms);
		});
		const saved = spyOn(ctx.storage, "saveVerifiedFile");
		try {
			await stage(ctx);
			expect(await pollUntilSeen(ctx)).toEqual({ committed: 1, failed: 0 });
			expect(deadlines).toContain(30 * 60_000);
			expect(deadlines).not.toContain(25 * 60_000);
			expect(ctx.settings.webdav.transferTimeoutMs).toBe(20 * 60_000);
			for (const call of saved.mock.calls) expect(call[2].timeoutMs).toBe(cap ?? 20 * 60_000);
		} finally {
			selected.mockRestore();
			saved.mockRestore();
			await ctx.close();
		}
	});

for (const budget of [
	{ label: "unset operator cap", operator: undefined, selected: 900_000, committed: 1 },
	{
		label: "explicit direct-sized operator cap",
		operator: 120_000,
		selected: 120_000,
		committed: 0,
	},
	{ label: "stricter operator", operator: 180_000, selected: 180_000, committed: 0 },
	{ label: "operator above direct ceiling", operator: 600_000, selected: 600_000, committed: 1 },
	{ label: "fixed relay ceiling", operator: 1_200_000, selected: 900_000, committed: 1 },
]) {
	test(`real relay ingest honors ${budget.label} budget for a healthy slow patch`, async () => {
		let slowPath = "";
		let patchBytes: Uint8Array = new Uint8Array();
		let finished = false;
		let cancelled = false;
		const ctx = await setup(
			(request) => {
				if (request.method !== "GET" || new URL(request.url).pathname !== slowPath) return null;
				let timer: ReturnType<typeof setTimeout>;
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(patchBytes.subarray(0, 1));
							timer = setTimeout(() => {
								controller.enqueue(patchBytes.subarray(1));
								finished = true;
								controller.close();
							}, 300);
						},
						cancel() {
							cancelled = true;
							clearTimeout(timer);
						},
					}),
					{ headers: { "content-length": String(patchBytes.length) } },
				);
			},
			budget.operator === undefined ? undefined : { uploadTimeoutMs: budget.operator },
		);
		try {
			const staged = await stage(ctx);
			const patch = staged.snapshot.assets.find((asset) => asset.kind === "patch");
			if (!patch) throw new Error("Expected patch");
			slowPath = staged.assetPath(patch.sha256);
			patchBytes = ctx.dav.objects.get(slowPath) as Uint8Array;
			// Exercise the real LocalStorage timers: 120s becomes 120ms and 15m becomes 900ms.
			// The healthy 300ms stream therefore fails under the old direct-only clamp.
			const original = ctx.storage.saveVerifiedFile.bind(ctx.storage);
			const saving = spyOn(ctx.storage, "saveVerifiedFile").mockImplementation(
				(path, stream, options) =>
					original(path, stream, { ...options, timeoutMs: options.timeoutMs / 1000 }),
			);
			try {
				expect(await pollUntilSeen(ctx)).toEqual({
					committed: budget.committed,
					failed: 1 - budget.committed,
				});
				const patchSave = saving.mock.calls.find((call) => call[2].sha256 === patch.sha256);
				expect(patchSave?.[2].timeoutMs).toBe(budget.selected);
				expect(finished).toBe(budget.committed === 1);
				if (budget.committed) {
					expect(await ctx.storage.getFile(`mirror-objects/${patch.sha256}`)).toEqual(
						Buffer.from(patchBytes),
					);
					expect((await ctx.app.request(`${root}/index`)).status).toBe(200);
				} else {
					expect(cancelled).toBe(true);
					expect(await ctx.storage.getFile(`mirror-objects/${patch.sha256}`)).toBeNull();
					expect((await ctx.app.request(`${root}/index`)).status).toBe(404);
				}
				expect(
					(await ctx.storage.listFiles("mirror-objects")).some((path) => path.endsWith(".tmp")),
				).toBe(false);
			} finally {
				saving.mockRestore();
			}
		} finally {
			await ctx.close();
		}
	});
}

test("metadata-only release imports with no patch or full binary request", async () => {
	const ctx = await setup();
	try {
		const staged = await stage(ctx, { patch: false });
		expect(await pollUntilSeen(ctx)).toEqual({ committed: 1, failed: 0 });
		expect(staged.snapshot.assets.some((a) => a.kind === "patch")).toBe(false);
		expect((await ctx.app.request(`${root}/availability/1.2.0/linux-x64`)).status).toBe(200);
	} finally {
		await ctx.close();
	}
});

for (const failure of ["bad-hash", "missing", "truncated", "oversized"] as const) {
	test(`server refuses ${failure} patch without publishing or leaving temporary files`, async () => {
		const ctx = await setup();
		try {
			const staged = await stage(ctx);
			const patch = staged.snapshot.assets.find((a) => a.kind === "patch");
			if (!patch) throw new Error("Expected patch");
			const path = staged.assetPath(patch.sha256);
			if (failure === "missing") ctx.dav.objects.delete(path);
			else
				ctx.dav.objects.set(
					path,
					new Uint8Array(
						patch.size + (failure === "truncated" ? -1 : failure === "oversized" ? 1 : 0),
					).fill(99),
				);
			expect(await pollUntilSeen(ctx)).toEqual({ committed: 0, failed: 1 });
			expect((await ctx.app.request(`${root}/index`)).status).toBe(404);
			expect((await ctx.app.request(`${root}/assets/${patch.sha256}`)).status).toBe(404);
			expect(
				(await ctx.storage.listFiles("mirror-objects")).some((name) => name.endsWith(".tmp")),
			).toBe(false);
			const gets = ctx.dav.requests.filter((r) => r.method === "GET").length;
			await ctx.puller.pollOnce();
			expect(ctx.dav.requests.filter((r) => r.method === "GET").length).toBe(gets);
		} finally {
			await ctx.close();
		}
	});
}

test("ready signature failure never fetches payload and is retryable instead of marked completed", async () => {
	const ctx = await setup();
	try {
		const staged = await stage(ctx, { signingKey: Buffer.alloc(32, 44).toString("base64") });
		const start = ctx.dav.requests.length;
		expect(await pollUntilSeen(ctx)).toEqual({ committed: 0, failed: 1 });
		expect(
			ctx.dav.requests
				.slice(start)
				.filter((r) => r.method === "GET")
				.map((r) => r.path),
		).toEqual([staged.readyPath]);
		const state = (
			await ctx.storage.getFile("mirror-relay-state/default/narrafork.json")
		)?.toString();
		expect(state).toContain("RETRY");
		expect(state).not.toContain("COMMITTED");
		const before = Object.values(
			(
				JSON.parse(state ?? "{}") as {
					entries: Record<string, { expiresAt: number; attempts: number }>;
				}
			).entries,
		)[0];
		ctx.clock.now += 24 * 60 * 60_000;
		for (let i = 0; i < 3; i++) await ctx.puller.pollOnce();
		const afterBytes = await ctx.storage.getFile("mirror-relay-state/default/narrafork.json");
		const after = Object.values(
			(
				JSON.parse(afterBytes?.toString() ?? "{}") as {
					entries: Record<string, { expiresAt: number; attempts: number }>;
				}
			).entries,
		)[0];
		expect(after.attempts).toBeGreaterThan(before.attempts);
		expect(after.expiresAt).toBe(before.expiresAt);
	} finally {
		await ctx.close();
	}
});

test("valid signature cannot authorize different payload bytes, repository or canonical target", async () => {
	const ctx = await setup();
	try {
		const staged = await stage(ctx);
		const raw = ctx.dav.objects.get(staged.payloadPath);
		if (!raw) throw new Error("Expected payload bytes");
		const corrupt = Uint8Array.from(raw);
		corrupt[corrupt.length - 1] ^= 1;
		ctx.dav.objects.set(staged.payloadPath, corrupt);
		expect(await pollUntilSeen(ctx)).toEqual({ committed: 0, failed: 1 });
		expect((await ctx.app.request(`${root}/index`)).status).toBe(404);
	} finally {
		await ctx.close();
	}
});

test("completed checkpoint survives a new puller and avoids re-downloading all objects", async () => {
	const ctx = await setup();
	let restarted: MirrorRelayPuller | undefined;
	try {
		await stage(ctx);
		expect(await pollUntilSeen(ctx)).toEqual({ committed: 1, failed: 0 });
		await ctx.puller.stop();
		restarted = ctx.makePuller();
		const count = ctx.dav.requests.filter((r) => r.method === "GET").length;
		for (let i = 0; i < 3; i++) await restarted.pollOnce();
		expect(ctx.dav.requests.filter((r) => r.method === "GET").length).toBe(count);
	} finally {
		await restarted?.stop();
		await ctx.close();
	}
});

test("crash after commit but before checkpoint safely replays the same immutable bytes", async () => {
	const ctx = await setup();
	let restarted: MirrorRelayPuller | undefined;
	try {
		const staged = await stage(ctx);
		expect(await pollUntilSeen(ctx)).toEqual({ committed: 1, failed: 0 });
		await ctx.storage.deleteFile("mirror-relay-state/default/narrafork.json");
		await ctx.puller.stop();
		restarted = ctx.makePuller();
		const result = await restarted.pollOnce();
		expect(result.committed).toBe(1);
		expect(await (await ctx.app.request(`${root}/index`)).json()).toEqual(staged.f.index);
	} finally {
		await restarted?.stop();
		await ctx.close();
	}
});

test("polling is single-flight and stopped workers perform no discovery or downloads", async () => {
	const ctx = await setup();
	try {
		await stage(ctx);
		const first = ctx.puller.pollOnce();
		const second = ctx.puller.pollOnce();
		expect(first).toBe(second);
		expect((await first).committed).toBe(1);
		await ctx.puller.stop();
		const count = ctx.dav.requests.length;
		ctx.puller.start();
		expect(await ctx.puller.pollOnce()).toEqual({ committed: 0, failed: 0, skipped: 0 });
		expect(ctx.dav.requests.length).toBe(count);
	} finally {
		await ctx.close();
	}
});

test("failed job does not block a good ready in the same poll", async () => {
	const ctx = await setup();
	try {
		const bad = await stage(ctx, { jobId: "bad-job" });
		ctx.dav.objects.delete(bad.payloadPath);
		await stage(ctx, { jobId: "good-job" });
		const result = await ctx.puller.pollOnce();
		expect(result.committed).toBe(1);
		expect(result.failed).toBe(1);
		expect((await ctx.app.request(`${root}/index`)).status).toBe(200);
	} finally {
		await ctx.close();
	}
});

test("server only scans the valid time window and never imports expired jobs", async () => {
	const ctx = await setup();
	try {
		await stage(ctx, { now: NOW - RELAY_TTL_MS - 24 * 60 * 60_000 });
		const start = ctx.dav.requests.length;
		for (let i = 0; i < 3; i++) {
			const result = await ctx.puller.pollOnce();
			expect(result.committed).toBe(0);
		}
		expect(ctx.dav.requests.slice(start).every((r) => r.method === "PROPFIND")).toBe(true);
		expect((await ctx.app.request(`${root}/index`)).status).toBe(404);
	} finally {
		await ctx.close();
	}
});

test("actual GitHub producer stages for pull without any update-server connection or asset readback", async () => {
	const ctx = await setup();
	try {
		const f = mirrorFixture(true, true);
		const receipt = await mirrorPublishedMainRelease({
			kind: "main",
			repository,
			tag: f.release.tag,
			transport: "webdav",
			run: f.run,
			downloadAsset: f.downloadAsset,
			relay: {
				config: ctx.settings.webdav,
				signingKey: key,
				client: ctx.client,
				now: () => new Date(ctx.clock.now),
				jobId: "actual-producer",
			},
		});
		expect(receipt.status).toBe("STAGED_FOR_PULL");
		expect(receipt.snapshotCommitted).toBe(false);
		expect(receipt.verified).toEqual([]);
		expect(f.httpCalls).toEqual([]);
		expect(ctx.dav.requests.filter((r) => r.method === "GET")).toEqual([]);
		expect((await ctx.app.request(`${root}/index`)).status).toBe(404);
		expect(await pollUntilSeen(ctx)).toEqual({ committed: 1, failed: 0 });
		expect(await (await ctx.app.request(`${root}/index`)).json()).toEqual(f.index);
	} finally {
		await ctx.close();
	}
});

for (const mode of ["stop", "deadline", "storage-deadline"] as const) {
	test(`actual pull ${mode} cancels a hanging patch stream without commit or temp-file leakage`, async () => {
		let hangingPath = "";
		let cancelled = false;
		const entered = Promise.withResolvers<void>();
		const reading = Promise.withResolvers<void>();
		const ctx = await setup((request) => {
			if (request.method !== "GET" || new URL(request.url).pathname !== hangingPath) return null;
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new Uint8Array([1, 2, 3]));
					},
					pull() {
						reading.resolve();
					},
					cancel() {
						cancelled = true;
					},
				}),
			);
		});
		let short: MirrorRelayPuller | undefined;
		try {
			const staged = await stage(ctx);
			const patch = staged.snapshot.assets.find((a) => a.kind === "patch");
			if (!patch) throw new Error("Expected patch");
			hangingPath = staged.assetPath(patch.sha256);
			const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
			const jobDeadline = new AbortController();
			const deadline = spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
				// Trigger the job cancellation only after the hanging stream has arrived. A real 150ms
				// timeout races CI scheduling and can expire before the fixture reaches its checkpoint.
				if (ms === 25 * 60_000) return jobDeadline.signal;
				return originalTimeout(ms);
			});
			const originalSave = ctx.storage.saveVerifiedFile.bind(ctx.storage);
			const saving = spyOn(ctx.storage, "saveVerifiedFile").mockImplementation(
				(path, stream, options) => {
					const work = originalSave(path, stream, {
						...options,
						// Keep the native storage timer and TimeoutError semantics, but allow enough time for
						// the fixture to observe the blocked read before expiry on a loaded CI runner.
						timeoutMs: mode === "storage-deadline" ? 1_000 : options.timeoutMs,
					});
					if (options.sha256 === patch.sha256) entered.resolve();
					return work;
				},
			);
			try {
				short = new MirrorRelayPuller(ctx.storage, ctx.ingest, ctx.settings, {
					fetchImpl: ctx.dav.fetchImpl,
					now: () => ctx.clock.now,
				});
				const work = short.pollOnce();
				await entered.promise;
				// Admission can complete asynchronously. Wait until writeStream is actually blocked in
				// reader.read(), so cancellation exercises the hanging-body path rather than setup/admission.
				await reading.promise;
				const expired = () => new DOMException("The operation timed out.", "TimeoutError");
				if (mode === "stop") await short.stop();
				else if (mode === "deadline") jobDeadline.abort(expired());
				const result = await work;
				expect(result.committed).toBe(0);
				if (mode !== "stop") expect(result.failed).toBe(1);
				expect(deadline.mock.calls.some(([ms]) => ms === 25 * 60_000)).toBe(true);
				expect(
					saving.mock.calls.find((call) => call[2].sha256 === patch.sha256)?.[2].timeoutMs,
				).toBe(15 * 60_000);
				expect(cancelled).toBe(true);
				expect((await ctx.app.request(`${root}/index`)).status).toBe(404);
				expect(
					(await ctx.storage.listFiles("mirror-objects")).some((path) => path.endsWith(".tmp")),
				).toBe(false);
				// Cancellation/deadline must release both shared ingest and storage admission locks.
				const bytes = ctx.dav.objects.get(hangingPath);
				if (!bytes) throw new Error("Expected canonical patch bytes");
				await ctx.ingest.ingestAsset(
					"narrafork",
					patch,
					new Blob([Uint8Array.from(bytes)]).stream(),
					signal(),
					"relay",
				);
			} finally {
				saving.mockRestore();
				deadline.mockRestore();
			}
		} finally {
			await short?.stop();
			await ctx.close();
		}
	});
}

function executorPayload(commit: string) {
	const version = "1.2.0";
	const tag = `executor-v${version}`;
	const content = JSON.stringify({
		schemaVersion: 1,
		repository,
		tag,
		commit,
		manifest: {
			version,
			protocolVersion: 1,
			releasedAt: "2026-07-01T00:00:00.000Z",
			platforms: Object.fromEntries(
				EXECUTOR_PLATFORMS.map((platform) => [
					platform,
					{
						filename: executorPublishedFilename(version, platform),
						size: 128,
						sha256: "f".repeat(64),
					},
				]),
			),
		},
		licenses: [{ name: "LICENSE-executor.txt", size: 7, sha256: hash(Buffer.from("License")) }],
	});
	return {
		schemaVersion: 1,
		repository,
		kind: "executor" as const,
		tag,
		assets: [
			{
				name: EXECUTOR_MANIFEST_FILENAME,
				size: Buffer.byteLength(content),
				sha256: hash(Buffer.from(content)),
				content,
			},
			{
				name: "LICENSE-executor.txt",
				size: 7,
				sha256: hash(Buffer.from("License")),
				content: "License",
			},
		],
	};
}

for (const corrupt of [false, true]) {
	test(`relay streams executor binary objects before atomic tag commit (corrupt=${corrupt})`, async () => {
		const ctx = await setup();
		try {
			const original = executorPayload("a".repeat(40));
			const bytes = Buffer.alloc(128, 6);
			const manifest = JSON.parse(original.assets[0].content);
			for (const entry of Object.values(manifest.manifest.platforms) as { sha256: string }[])
				entry.sha256 = hash(bytes);
			const content = JSON.stringify(manifest);
			const binaries = EXECUTOR_PLATFORMS.map((platform) => ({
				kind: "executor-binary",
				version: "1.2.0",
				platform,
				name: executorPublishedFilename("1.2.0", platform),
				size: bytes.length,
				sha256: hash(bytes),
			}));
			const payload = {
				...original,
				binaries,
				assets: [
					{
						...original.assets[0],
						content,
						size: Buffer.byteLength(content),
						sha256: hash(Buffer.from(content)),
					},
					original.assets[1],
				],
			};
			const producer = new MirrorRelayStage(
				{ kind: "executor", repository, tag: payload.tag },
				{
					config: ctx.settings.webdav,
					signingKey: key,
					client: ctx.client,
					now: () => new Date(ctx.clock.now),
					jobId: "executor-binary-stream",
				},
				signal(),
			);
			// The signed JSON stays small; the binary is its own object, never base64 in payload.
			await producer.uploadObject(binaries[0], bytes);
			await producer.preparePayload(payload, 1024 * 1024);
			await producer.publish(async () => {});
			if (corrupt) {
				const objectRequest = ctx.dav.requests.find(
					(r) => r.method === "PUT" && r.path.endsWith(hash(bytes)),
				);
				if (!objectRequest) throw new Error("Missing binary object");
				ctx.dav.objects.set(objectRequest.path, Buffer.alloc(128, 9));
			}
			const result = { committed: 0, failed: 0 };
			for (let i = 0; i < 3; i++) {
				const poll = await ctx.puller.pollOnce();
				result.committed += poll.committed;
				result.failed += poll.failed;
			}
			expect(result.committed).toBe(corrupt ? 0 : 1);
			expect(result.failed).toBe(corrupt ? 1 : 0);
			const response = await ctx.app.request(
				`${root}/tools/executor/${payload.tag}/assets/${binaries[0].name}`,
			);
			expect(response.status).toBe(corrupt ? 404 : 200);
			if (!corrupt) expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true);
			expect(ctx.dav.requests.some((r) => r.method === "GET" && r.path.endsWith(hash(bytes)))).toBe(
				true,
			);
		} finally {
			await ctx.close();
		}
	});
}

// GitHub repository slugs are case-insensitive, but the relay carries the slug as the
// publisher spelled it. `GITHUB_REPOSITORY` keeps the repository's own casing, so a
// mixed-case repository signed a tools manifest that the operator-configured lowercase
// slug then had to accept. Only the payload side was lowercased before comparison, so
// every tools import failed with a bare IMPORT_FAILED and the mirror silently served no
// executor/helpers binaries at all.
test("relay commits tools for a mixed-case repository slug", async () => {
	const ctx = await setup();
	try {
		const mixed = "Fixture-Owner/Fork-Product";
		const payload = executorPayload("a".repeat(40));
		const binary = Buffer.alloc(128, 7);
		const manifest = JSON.parse(payload.assets[0].content);
		for (const entry of Object.values(manifest.manifest.platforms) as { sha256: string }[])
			entry.sha256 = hash(binary);
		const content = JSON.stringify(manifest);
		const binaries = EXECUTOR_PLATFORMS.map((entry) => ({
			kind: "executor-binary",
			version: "1.2.0",
			platform: entry,
			name: executorPublishedFilename("1.2.0", entry),
			size: binary.length,
			sha256: hash(binary),
		}));
		const producer = new MirrorRelayStage(
			{ kind: "executor", repository: mixed, tag: payload.tag },
			{
				config: ctx.settings.webdav,
				signingKey: key,
				client: ctx.client,
				now: () => new Date(ctx.clock.now),
				jobId: "mixed-case-repository",
			},
			signal(),
		);
		// Every platform shares one object here, so a single PUT backs all six identities.
		await producer.uploadObject(binaries[0], binary);
		await producer.preparePayload(
			{
				...payload,
				repository: mixed,
				binaries,
				assets: [
					{
						...payload.assets[0],
						content,
						size: Buffer.byteLength(content),
						sha256: hash(Buffer.from(content)),
					},
					payload.assets[1],
				],
			},
			1024 * 1024,
		);
		await producer.publish(async () => {});

		let committed = 0;
		for (let i = 0; i < 3; i++) committed += (await ctx.puller.pollOnce()).committed;
		expect(ctx.events.filter((event) => event.code !== "DISCOVERY_FAILED")).toEqual([
			expect.objectContaining({ code: "COMMITTED", kind: "executor" }),
		]);
		expect(committed).toBe(1);
		// Stored metadata is canonical, so the direct-upload read path finds it too.
		expect(await (await ctx.app.request(`${root}/tools/executor/${payload.tag}`)).json()).toEqual(
			expect.objectContaining({ repository: mixed.toLowerCase(), binaries }),
		);
		const response = await ctx.app.request(
			`${root}/tools/executor/${payload.tag}/assets/${binaries[0].name}`,
		);
		expect(response.status).toBe(200);
		expect(Buffer.from(await response.arrayBuffer()).equals(binary)).toBe(true);
	} finally {
		await ctx.close();
	}
});

test("actual tools same-tag conflict becomes terminal CONFLICT instead of re-downloading forever", async () => {
	const ctx = await setup();
	try {
		const original = executorPayload("a".repeat(40));
		await ctx.ingest.commitTools("narrafork", "executor", original.tag, original, signal());
		const changed = executorPayload("b".repeat(40));
		const stage = new MirrorRelayStage(
			{ kind: "executor", repository, tag: changed.tag },
			{
				config: ctx.settings.webdav,
				signingKey: key,
				client: ctx.client,
				now: () => new Date(ctx.clock.now),
				jobId: "executor-conflict",
			},
			signal(),
		);
		await stage.preparePayload(changed, 1024 * 1024);
		await stage.publish(async () => {});
		expect(await pollUntilSeen(ctx)).toEqual({ committed: 0, failed: 1 });
		const state = (
			await ctx.storage.getFile("mirror-relay-state/default/narrafork.json")
		)?.toString();
		expect(state).toContain("CONFLICT");
		expect(state).not.toContain("RETRY");
		const count = ctx.dav.requests.filter((r) => r.method === "GET").length;
		ctx.clock.now += 24 * 60 * 60_000;
		for (let i = 0; i < 3; i++) await ctx.puller.pollOnce();
		expect(ctx.dav.requests.filter((r) => r.method === "GET").length).toBe(count);
		expect(await (await ctx.app.request(`${root}/tools/executor/${original.tag}`)).json()).toEqual(
			original,
		);
	} finally {
		await ctx.close();
	}
});

test("hourly polling with alternating discovery groups cannot phase-lock on poisoned halves", async () => {
	const ctx = await setup();
	let hourly: MirrorRelayPuller | undefined;
	try {
		ctx.clock.now = Date.parse("2026-10-15T12:30:00.000Z");
		const mainPaths: string[] = [];
		const executorPaths: string[] = [];
		for (let i = 0; i < 8; i++) {
			const staged = await stage(ctx, { jobId: `main-${i}` });
			mainPaths.push(staged.readyPath);
		}
		for (let i = 0; i < 8; i++) {
			const payload = executorPayload("a".repeat(40));
			const before = new Set(ctx.dav.objects.keys());
			const staged = new MirrorRelayStage(
				{ kind: "executor", repository, tag: payload.tag },
				{
					config: ctx.settings.webdav,
					signingKey: key,
					client: ctx.client,
					now: () => new Date(ctx.clock.now),
					jobId: `executor-${i}`,
				},
				signal(),
			);
			await staged.preparePayload(payload, 1024 * 1024);
			await staged.publish(async () => {});
			const path = [...ctx.dav.objects.keys()].find((p) => !before.has(p) && p.includes("/ready/"));
			if (!path) throw new Error("Expected executor ready");
			executorPaths.push(path);
		}
		for (const path of [...mainPaths.slice(0, 4), ...executorPaths.slice(4)]) {
			const raw = ctx.dav.objects.get(path);
			if (!raw) throw new Error("Expected ready");
			const envelope = JSON.parse(new TextDecoder().decode(raw));
			envelope.hmac = "0".repeat(64);
			ctx.dav.objects.set(path, Buffer.from(JSON.stringify(envelope)));
		}
		hourly = new MirrorRelayPuller(
			ctx.storage,
			ctx.ingest,
			{
				...ctx.settings,
				webdav: ctx.settings.webdav,
				signingKey: ctx.settings.signingKey,
				pollIntervalMs: 3600_000,
			},
			{ fetchImpl: ctx.dav.fetchImpl, now: () => ctx.clock.now },
		);
		let committed = 0;
		for (let i = 0; i < 6; i++) {
			committed += (await hourly.pollOnce()).committed;
			ctx.clock.now += 3600_000;
		}
		expect(committed).toBe(8);
		expect((await ctx.app.request(`${root}/index`)).status).toBe(200);
		expect((await ctx.app.request(`${root}/tools/executor/executor-v1.2.0`)).status).toBe(200);
	} finally {
		await hourly?.stop();
		await ctx.close();
	}
});

test("real direct main/tools receipts accept mixed-case repository identity but no different repository", async () => {
	const ctx = await setup();
	try {
		const staged = await stage(ctx, { patch: false });
		for (const asset of staged.snapshot.assets) {
			const bytes =
				asset.kind === "notes" ? Buffer.from(staged.f.notesRaw) : staged.f.raw.get(asset.name);
			if (!bytes) throw new Error("Expected metadata");
			await ctx.ingest.ingestAsset(
				"narrafork",
				asset,
				new Blob([Uint8Array.from(bytes)]).stream(),
				signal(),
			);
		}
		const main = await ctx.ingest.commitMain("narrafork", staged.snapshot, signal());
		const mainIdentity = {
			repository: repository.toUpperCase(),
			indexCommit: staged.snapshot.indexCommit,
			generation: staged.snapshot.index.generation,
			targetVersion: staged.snapshot.targetVersion,
		};
		expect(() => assertServerVerified(main, mainIdentity, staged.snapshot.assets)).not.toThrow();
		expect(() =>
			assertServerVerified(
				main,
				{ ...mainIdentity, repository: "different/fork" },
				staged.snapshot.assets,
			),
		).toThrow();
		const payload = executorPayload("a".repeat(40));
		const tools = await ctx.ingest.commitTools(
			"narrafork",
			"executor",
			payload.tag,
			payload,
			signal(),
		);
		const toolsIdentity = {
			repository: repository.toUpperCase(),
			kind: "executor",
			tag: payload.tag,
		};
		expect(() => assertServerVerified(tools, toolsIdentity, payload.assets)).not.toThrow();
		expect(() =>
			assertServerVerified(
				tools,
				{ ...toolsIdentity, repository: "different/fork" },
				payload.assets,
			),
		).toThrow();
		expect(() =>
			assertServerVerified(
				tools,
				{ ...toolsIdentity, tag: payload.tag.toUpperCase() },
				payload.assets,
			),
		).toThrow();
	} finally {
		await ctx.close();
	}
});
