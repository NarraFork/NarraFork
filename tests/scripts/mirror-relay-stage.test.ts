import { describe, expect, spyOn, test } from "bun:test";
import {
	MirrorRelayStage,
	type MirrorRelayStageOptions,
	resolveMirrorRelayConfig,
	resolveMirrorTransport,
} from "../../scripts/lib/mirror-relay-stage";
import { IndependentMirrorError, mirrorReceipt } from "../../scripts/lib/update-server-main-mirror";
import { mirrorPublishedGitHubRelease } from "../../scripts/mirror-update-server";
import { parseRelayReady, relayBucketExpired } from "../../shared/mirror-relay";
import { WebDavClient, WebDavError } from "../../shared/webdav-transport";
import { createWebDavFixture } from "../fixtures/webdav-fixture";
import { config, mirrorFixture, repository, sha } from "./mirror-fixture";

const now = new Date("2026-10-15T12:00:00.000Z");
const signingKey = Buffer.alloc(32, 7).toString("base64");
const identity = { kind: "main" as const, repository, tag: "v1.2.0" };
function fixture(options: Parameters<typeof createWebDavFixture>[0] = {}) {
	const dav = createWebDavFixture(options);
	const config = { url: dav.baseUrl, feed: "default", auth: { bearerToken: "fixture-token" } };
	const relay: MirrorRelayStageOptions = {
		config,
		signingKey,
		client: new WebDavClient(config, { fetchImpl: dav.fetchImpl }),
		now: () => now,
	};
	return { dav, relay };
}
const readyObjects = (dav: ReturnType<typeof createWebDavFixture>) =>
	[...dav.objects].filter(([path]) => path.includes("/ready/"));
function ready(dav: ReturnType<typeof createWebDavFixture>) {
	const [path, bytes] = readyObjects(dav)[0];
	const manifestHash = path.split("/").at(-1)?.slice(0, -5) as string;
	return parseRelayReady(bytes, signingKey, {
		manifestHash,
		feed: "default",
		product: "narrafork",
		repository,
		kind: "main",
		date: "2026-10-15",
		now: now.getTime(),
	});
}
async function simpleStage(f: ReturnType<typeof fixture>) {
	const stage = new MirrorRelayStage(identity, f.relay, new AbortController().signal);
	await stage.preparePayload({ schemaVersion: 1 }, 1024 * 1024);
	return stage.publish(async () => {});
}
describe("WebDAV relay producer", () => {
	test("concurrent same-hash objects share one conditional PUT and publication waits for settlement", async () => {
		const f = fixture();
		const stage = new MirrorRelayStage(identity, f.relay, AbortSignal.timeout(1000));
		const bytes = Buffer.from("one immutable object");
		const asset = { name: "first", size: bytes.length, sha256: sha(bytes) };
		let duplicateCanceled = false;
		const first = stage.uploadObject(asset, bytes);
		const second = stage.uploadObject(
			{ ...asset, name: "alias" },
			new ReadableStream({
				cancel() {
					duplicateCanceled = true;
				},
			}),
		);
		await expect(stage.preparePayload({ assets: [] }, 1024)).rejects.toThrow("settle");
		await Promise.all([first, second]);
		expect(duplicateCanceled).toBe(true);
		expect(
			f.dav.requests.filter((r) => r.method === "PUT" && r.path.endsWith(asset.sha256)),
		).toHaveLength(1);
		expect(
			f.dav.requests.filter((r) => r.method === "MKCOL" && /\/objects\/$/.test(r.path)),
		).toHaveLength(1);
		await stage.preparePayload({ assets: [asset] }, 1024);
		await stage.publish(async () => {});
		expect(readyObjects(f.dav)).toHaveLength(1);
	});
	test("failed object poisons the stage and cannot later publish a partial ready", async () => {
		const f = fixture();
		if (!f.relay.client) throw new Error("Missing fixture client");
		const put = spyOn(f.relay.client, "put").mockRejectedValue(new WebDavError("HTTP_STATUS", 503));
		try {
			const stage = new MirrorRelayStage(identity, f.relay, AbortSignal.timeout(1000));
			const bytes = Buffer.from("failure");
			await expect(
				stage.uploadObject({ name: "bad", size: bytes.length, sha256: sha(bytes) }, bytes),
			).rejects.toThrow();
			await expect(stage.preparePayload({}, 1024)).rejects.toThrow("settle");
			await expect(stage.publish(async () => {})).rejects.toThrow("failed");
			expect(readyObjects(f.dav)).toHaveLength(0);
		} finally {
			put.mockRestore();
		}
	});
	test("default direct, explicit webdav, invalid mode fails closed", () => {
		expect(resolveMirrorTransport({})).toBe("direct");
		expect(resolveMirrorTransport({ NF_MIRROR_TRANSPORT: "webdav" })).toBe("webdav");
		for (const mode of ["", "DAV", "automatic"])
			expect(() => resolveMirrorTransport({ NF_MIRROR_TRANSPORT: mode })).toThrow();
	});
	test("relay credentials are complete, exclusive and validated without any server config", () => {
		const env = {
			NF_MIRROR_WEBDAV_URL: "https://dav.example.test/private/",
			NF_MIRROR_WEBDAV_TOKEN: "fixture-token",
			NF_MIRROR_RELAY_SIGNING_KEY: signingKey,
		};
		expect(resolveMirrorRelayConfig(env).config.feed).toBe("default");
		for (const overrides of [
			{ NF_MIRROR_WEBDAV_USERNAME: "user" },
			{ NF_MIRROR_WEBDAV_PASSWORD: "password" },
			{ NF_MIRROR_WEBDAV_TOKEN: "" },
			{ NF_MIRROR_RELAY_SIGNING_KEY: "not-a-key" },
			{ NF_MIRROR_WEBDAV_URL: "http://dav.example.test/" },
			{ NF_MIRROR_WEBDAV_URL: "https://u:p@dav.example.test/" },
			{ NF_MIRROR_WEBDAV_FEED: "../escape" },
		])
			expect(() => resolveMirrorRelayConfig({ ...env, ...overrides })).toThrow();
	});
	test("explicit missing WebDAV config never silently skips or falls back to direct", async () => {
		const f = mirrorFixture();
		await expect(
			mirrorPublishedGitHubRelease({
				...identity,
				transport: "webdav",
				config,
				run: f.run,
				http: f.http,
			}),
		).rejects.toBeInstanceOf(IndependentMirrorError);
		expect(f.ghCalls).toHaveLength(0);
		expect(f.httpCalls).toHaveLength(0);
	});
	test("main source bytes precede ready, no update server or DAV asset GET, honest staging receipt", async () => {
		const f = fixture();
		const github = mirrorFixture();
		const result = await mirrorPublishedGitHubRelease({
			...identity,
			transport: "webdav",
			relay: f.relay,
			// Even supplied invalid direct config must never be validated or used in webdav mode.
			config: { serverUrl: "http://do-not-contact.invalid", token: "unused" },
			http: github.http,
			run: github.run,
			downloadAsset: github.downloadAsset,
		});
		expect(result.status).toBe("STAGED_FOR_PULL");
		expect(result.transport).toBe("webdav");
		expect(result.verification).toBe("pending-server-pull");
		expect(result.snapshotCommitted).toBe(false);
		expect(result.verified).toEqual([]);
		expect(result.uploaded).toHaveLength(5);
		expect(result.relay?.retention).toBe("COMPLETE");
		expect(result.relay?.expiresAt).toBe("2026-10-22T12:00:00.000Z");
		expect(github.httpCalls).toHaveLength(0);
		expect(github.downloaded).toHaveLength(2);
		expect(f.dav.requests.some((r) => r.method === "GET")).toBe(false);
		const puts = f.dav.requests.filter((r) => r.method === "PUT");
		expect(puts.at(-1)?.path).toContain("/ready/");
		expect(puts.slice(0, -1).every((r) => r.path.includes("/objects/"))).toBe(true);
		const manifest = ready(f.dav);
		expect(manifest.jobId).toMatch(/^[a-f0-9-]{36}$/);
		const payload = [...f.dav.objects].find(([path]) =>
			path.endsWith(manifest.payload.sha256),
		)?.[1];
		expect(payload?.length).toBe(manifest.payload.size);
		expect(sha(payload as Uint8Array)).toBe(manifest.payload.sha256);
		for (const bytes of github.raw.values())
			expect([...f.dav.objects.values()].some((actual) => Buffer.from(actual).equals(bytes))).toBe(
				true,
			);
	});
	test("payload is independent of signed ready bytes near the 1MiB limit", async () => {
		const f = fixture();
		const stage = new MirrorRelayStage(identity, f.relay, new AbortController().signal);
		let checked = false;
		await stage.preparePayload({ value: "x".repeat(1024 * 1024 - 100) }, 1024 * 1024);
		expect(readyObjects(f.dav)).toHaveLength(0);
		await stage.publish(async () => {
			checked = true;
			expect(readyObjects(f.dav)).toHaveLength(0);
		});
		expect(checked).toBe(true);
		const [, envelopeBytes] = readyObjects(f.dav)[0];
		expect(envelopeBytes.length).toBeLessThan(8192);
		const envelope = JSON.parse(Buffer.from(envelopeBytes).toString());
		const manifest = JSON.parse(Buffer.from(envelope.manifestBase64, "base64").toString());
		expect(manifest.payload.size).toBeGreaterThan(1024 * 1024 - 200);
		expect(manifest.value).toBeUndefined();
		expect(ready(f.dav).payload.size).toBe(manifest.payload.size);
	});
	test("oversized payload fails before network", async () => {
		const f = fixture();
		const stage = new MirrorRelayStage(identity, f.relay, new AbortController().signal);
		await expect(
			stage.preparePayload({ value: "x".repeat(1024 * 1024) }, 1024 * 1024),
		).rejects.toThrow();
		expect(f.dav.requests).toHaveLength(0);
	});
	for (const phase of ["objects", "authority"])
		test(`${phase} failure cannot publish ready`, async () => {
			const f = fixture({
				intercept: (r) =>
					phase === "objects" && r.method === "PUT" ? new Response(null, { status: 503 }) : null,
			});
			const stage = new MirrorRelayStage(identity, f.relay, new AbortController().signal);
			await expect(
				(async () => {
					await stage.preparePayload({ x: 1 }, 1024);
					await stage.publish(async () => {
						throw new Error("source identity changed");
					});
				})(),
			).rejects.toThrow();
			expect(readyObjects(f.dav)).toHaveLength(0);
		});
	test("main rechecks canonical GitHub after payload upload and rejects tag/assets/index changes", async () => {
		const github = mirrorFixture(false);
		const f = fixture({
			intercept: (r) => {
				if (r.method === "PUT" && new URL(r.url).pathname.includes("/objects/"))
					github.publicRelease.id++;
				return null;
			},
		});
		await expect(
			mirrorPublishedGitHubRelease({
				...identity,
				transport: "webdav",
				relay: f.relay,
				run: github.run,
			}),
		).rejects.toThrow();
		expect(readyObjects(f.dav)).toHaveLength(0);
	});
	test("conditional-create conflict is not verified success and no GET is attempted", async () => {
		const f = fixture({
			intercept: (r) => (r.method === "PUT" ? new Response(null, { status: 412 }) : null),
		});
		await expect(simpleStage(f)).rejects.toThrow("existence is not verification");
		expect(readyObjects(f.dav)).toHaveLength(0);
		expect(f.dav.requests.some((r) => r.method === "GET")).toBe(false);
	});
	test("ready condition-create conflict is failure, not staged or verified success", async () => {
		const f = fixture({
			intercept: (r) =>
				r.method === "PUT" && new URL(r.url).pathname.includes("/ready/")
					? new Response(null, { status: 412 })
					: null,
		});
		await expect(simpleStage(f)).rejects.toThrow("ready conditional-create conflict");
		expect(readyObjects(f.dav)).toHaveLength(0);
		expect(f.dav.requests.some((r) => r.method === "GET")).toBe(false);
	});
	test("expired staging cannot publish a newly valid ready in its old bucket", async () => {
		const f = fixture();
		const stage = new MirrorRelayStage(identity, f.relay, new AbortController().signal);
		await stage.preparePayload({ x: 1 }, 1024);
		f.relay.now = () => new Date("2026-10-22T12:00:00.000Z");
		await expect(stage.publish(async () => {})).rejects.toThrow("expired");
		expect(readyObjects(f.dav)).toHaveLength(0);
	});
	test("repeated staging uses independent random jobs rather than shared objects", async () => {
		const f = fixture();
		const a = await simpleStage(f);
		const b = await simpleStage(f);
		expect(a.manifestHash).not.toBe(b.manifestHash);
		expect(readyObjects(f.dav)).toHaveLength(2);
		const objects = f.dav.requests.filter(
			(r) => r.method === "PUT" && r.path.includes("/objects/"),
		);
		expect(objects[0].path).not.toBe(objects[1].path);
	});
	test("full date bucket rejects before any objects are uploaded", async () => {
		const f = fixture();
		const dir = "/private/narrafork-mirror-v1/default/ready/narrafork/main/2026-10-15/";
		for (let i = 0; i < 32; i++)
			f.dav.objects.set(`${dir}${sha(String(i))}.json`, new Uint8Array([1]));
		await expect(simpleStage(f)).rejects.toThrow("bucket is full");
		expect(f.dav.requests.some((r) => r.method === "PUT")).toBe(false);
	});
	test("cancelled staging publishes no ready", async () => {
		const f = fixture();
		const controller = new AbortController();
		const stage = new MirrorRelayStage(identity, f.relay, controller.signal);
		await stage.preparePayload({ x: 1 }, 1024);
		controller.abort();
		await expect(stage.publish(async () => {})).rejects.toThrow();
		expect(readyObjects(f.dav)).toHaveLength(0);
	});
});

describe("bounded producer retention", () => {
	function bucket(f: ReturnType<typeof fixture>, date: string, kind = "main", feed = "default") {
		for (const root of ["ready", "batches"]) {
			const parent = `/private/narrafork-mirror-v1/${feed}/${root}/narrafork/${kind}/`;
			f.dav.collections.add(parent);
			f.dav.collections.add(`${parent}${date}/`);
			f.dav.objects.set(`${parent}${date}/fixture-object`, new Uint8Array([1]));
		}
	}
	test("strict bucketEnd+TTL+24h+10min threshold, only self date roots are deleted", async () => {
		const boundary = Date.parse("2026-10-15T00:10:00.000Z");
		expect(relayBucketExpired("2026-10-06", boundary)).toBe(false);
		expect(relayBucketExpired("2026-10-06", boundary + 1)).toBe(true);
		const f = fixture();
		f.relay.now = () => new Date(boundary);
		bucket(f, "2026-10-06");
		bucket(f, "2026-10-05");
		bucket(f, "2026-10-05", "helpers");
		bucket(f, "2026-10-05", "main", "other-feed");
		f.dav.collections.add(
			"/private/narrafork-mirror-v1/default/ready/narrafork/main/user-directory/",
		);
		const result = await simpleStage(f);
		expect(result.retention).toBe("COMPLETE");
		const deletes = f.dav.requests.filter((r) => r.method === "DELETE");
		expect(deletes).toHaveLength(2);
		expect(
			deletes.every((r) => r.path.includes("/default/") && r.path.endsWith("/main/2026-10-05/")),
		).toBe(true);
		expect(
			f.dav.collections.has(
				"/private/narrafork-mirror-v1/default/ready/narrafork/main/2026-10-06/",
			),
		).toBe(true);
	});
	test("date-looking feed cannot trick cleanup into traversing protocol root", async () => {
		const f = fixture();
		f.relay.config.feed = "2026-10-15";
		f.relay.client = new WebDavClient(f.relay.config, { fetchImpl: f.dav.fetchImpl });
		bucket(f, "2026-09-01", "main", "2026-10-15");
		await simpleStage(f);
		const roots = f.dav.requests.filter((r) => r.method === "PROPFIND");
		expect(
			roots.every(
				(r) =>
					r.path.startsWith("/private/narrafork-mirror-v1/2026-10-15/") &&
					r.path.includes("/narrafork/main/"),
			),
		).toBe(true);
	});
	test("30-second cleanup deadline is bounded and honestly incomplete, not whole-stage failure", async () => {
		const timeout = AbortSignal.timeout.bind(AbortSignal);
		const deadline = spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
			timeout(ms === 30_000 ? 5 : ms),
		);
		try {
			const f = fixture({
				intercept: async (r) => {
					if (r.method !== "PROPFIND" || !new URL(r.url).pathname.endsWith("/main/")) return null;
					await new Promise((resolve) =>
						r.signal.addEventListener("abort", resolve, { once: true }),
					);
					throw new Error("retention timeout");
				},
			});
			const result = await simpleStage(f);
			expect(result.retention).toBe("RETENTION_INCOMPLETE");
			expect(readyObjects(f.dav)).toHaveLength(1);
		} finally {
			deadline.mockRestore();
		}
	});
	test("at most 12 old dates, backlog reports RETENTION_INCOMPLETE", async () => {
		const f = fixture();
		for (let i = 1; i <= 13; i++) bucket(f, `2026-09-${String(i).padStart(2, "0")}`);
		const result = await simpleStage(f);
		expect(result.retention).toBe("RETENTION_INCOMPLETE");
		expect(f.dav.requests.filter((r) => r.method === "DELETE")).toHaveLength(24);
		expect(
			f.dav.collections.has(
				"/private/narrafork-mirror-v1/default/ready/narrafork/main/2026-09-13/",
			),
		).toBe(true);
	});
	for (const method of ["DELETE", "PROPFIND"])
		test(`${method} cleanup failure is honest RETENTION_INCOMPLETE, staging may still finish`, async () => {
			const f = fixture({
				intercept: (r) => {
					const path = new URL(r.url).pathname;
					if (r.method === method && (method === "DELETE" || /\/main\/$/.test(path)))
						return new Response(null, { status: 403 });
					return null;
				},
			});
			bucket(f, "2026-09-01");
			const result = await simpleStage(f);
			expect(result.retention).toBe("RETENTION_INCOMPLETE");
			expect(readyObjects(f.dav).filter(([path]) => path.endsWith(".json"))).toHaveLength(1);
		});
});

describe("safe independent mirror transport diagnostics", () => {
	test("retains only known WebDAV codes and valid HTTP status, never raw errors", () => {
		const receipt = mirrorReceipt({ ...identity, transport: "webdav" });
		for (const [failure, expected] of [
			[new WebDavError("TIMEOUT"), { code: "TIMEOUT" }],
			[new WebDavError("HTTP_STATUS", 503), { code: "HTTP_STATUS", httpStatus: 503 }],
			[new WebDavError("HTTP_STATUS", 700), { code: "HTTP_STATUS" }],
			[
				new WebDavError("https://private.invalid/?token=PRIVATE_CREDENTIAL"),
				{ code: "OTHER_WEBDAV_ERROR" },
			],
			[new Error("PRIVATE_CREDENTIAL https://private.invalid/"), undefined],
		] as const) {
			const wrapped = new IndependentMirrorError(receipt, failure);
			expect(wrapped.transportDiagnostic).toEqual(expected);
			expect(wrapped.receipt).toBe(receipt);
			expect(JSON.stringify(wrapped)).not.toContain("PRIVATE_CREDENTIAL");
			expect(JSON.stringify(wrapped)).not.toContain("private.invalid");
		}
		const exotic = new WebDavError("TIMEOUT");
		Object.defineProperty(exotic, "code", {
			get() {
				throw new Error("diagnostic getter");
			},
		});
		expect(new IndependentMirrorError(receipt, exotic).transportDiagnostic).toBeUndefined();
	});

	for (const code of ["TIMEOUT", "HTTP_STATUS"] as const) {
		test(`${code} preserves partial upload evidence and bounded phase diagnostics without publishing ready`, async () => {
			const f = fixture();
			const github = mirrorFixture();
			const before = JSON.stringify(github.publicRelease);
			const client = f.relay.client;
			if (!client) throw new Error("Expected fixture transport");
			const originalPut = client.put.bind(client);
			let attempts = 0;
			const put = spyOn(client, "put").mockImplementation(async (...args) => {
				if (++attempts === 2) throw new WebDavError(code, code === "HTTP_STATUS" ? 503 : undefined);
				return originalPut(...args);
			});
			const events: Array<Record<string, unknown>> = [];
			const output = spyOn(console, "info").mockImplementation((line) => {
				if (typeof line === "string" && line.startsWith("{")) events.push(JSON.parse(line));
			});
			try {
				let failure: unknown;
				try {
					await mirrorPublishedGitHubRelease({
						...identity,
						transport: "webdav",
						uploadConcurrency: 1,
						relay: f.relay,
						run: github.run,
						downloadAsset: github.downloadAsset,
					});
				} catch (error) {
					failure = error;
				}
				expect(failure).toBeInstanceOf(IndependentMirrorError);
				const wrapped = failure as IndependentMirrorError;
				expect(wrapped.transportDiagnostic).toEqual({
					code,
					...(code === "HTTP_STATUS" ? { httpStatus: 503 } : {}),
				});
				expect(wrapped.receipt.status).toBe("FAILED");
				expect(wrapped.receipt.uploaded).toHaveLength(1);
				expect(wrapped.receipt.verified).toEqual([]);
				expect(wrapped.receipt.snapshotCommitted).toBe(false);
				expect(readyObjects(f.dav)).toHaveLength(0);
				expect(github.httpCalls).toHaveLength(0);
				expect(JSON.stringify(github.publicRelease)).toBe(before);
				const uploads = events.filter(
					(event) => event.phase === "mirror.webdav-upload" && event.state === "end",
				);
				expect(uploads.map((event) => event.status)).toEqual(["success", "error"]);
				for (const event of uploads) {
					expect(event.durationMs).toBeGreaterThanOrEqual(0);
					expect(event.inputBytes).toBeGreaterThan(0);
				}
			} finally {
				put.mockRestore();
				output.mockRestore();
			}
		});
	}
});
