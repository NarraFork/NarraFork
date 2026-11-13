/**
 * End-to-end check of the executor distribution path.
 *
 * Serves the selected mirror's exact pinned manifest and binary endpoints over
 * scratch HTTP, then exercises the real bootstrap routes, bound tickets and
 * install-script integrity. Mirror mode must never contact GitHub; an explicit
 * GitHub-mode regression separately covers the unchanged canonical URLs.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXECUTOR_MANIFEST_FILENAME, EXECUTOR_PLATFORMS } from "@shared/remote-executor";
import { Hono } from "hono";
import { buildExecutorManifest } from "../scripts/lib/executor-manifest";
import { buildAppErrorResponse } from "../server/lib/app-error-response";
import {
	ensureExecutorBinary,
	freezeExecutorArtifact,
	getExecutorManifest,
	resetExecutorManifestCache,
} from "../server/lib/executor-binaries";
import {
	attachExecutorTicketScript,
	issueExecutorTicket,
	resetExecutorTickets,
} from "../server/lib/executor-bootstrap-ticket";
import { buildExecutorInstallScript } from "../server/lib/executor-install-script";
import { HELPER_BIN_DIR } from "../server/lib/helper-binaries";
import { settings } from "../server/lib/settings";
import { BUILD_EXECUTOR_DISTRIBUTION } from "../server/lib/version";

const EXECUTOR_VERSION = BUILD_EXECUTOR_DISTRIBUTION.version;
const EXECUTOR_TAG = BUILD_EXECUTOR_DISTRIBUTION.tag;
const REPOSITORY = "fixture/bootstrap";
const PRODUCT = "bootstrap-e2e";
const BINARY_FILENAME = `narrafork-executor-${EXECUTOR_VERSION}-linux-amd64`;
const GITHUB_PREFIX = `https://github.com/${REPOSITORY}/releases/download/${EXECUTOR_TAG}/`;
const outboundRequests: string[] = [];
const servedPaths: string[] = [];
let expectedRequestSource: "github" | "update-server" = "update-server";
let unavailableAsset: "manifest" | "binary" | null = null;
function mirrorAssetPath(filename: string): string {
	return `/api/v3/products/${encodeURIComponent(PRODUCT)}/mirror/tools/executor/${encodeURIComponent(EXECUTOR_TAG)}/assets/${encodeURIComponent(filename)}`;
}

import { setOutboundFetchOverrideForTest } from "../server/lib/net/outbound-fetch";
import {
	executorBootstrapRoutes,
	resetExecutorBootstrapRateLimit,
} from "../server/routes/executor-bootstrap";

// A structural ELF fixture, never executed by this suite.
const BINARY = Buffer.alloc(256);
BINARY.writeUInt32BE(0x7f454c46, 0);
BINARY[4] = 2;
BINARY[5] = 1;
BINARY.writeUInt16LE(62, 18);
const SHA256 = createHash("sha256").update(BINARY).digest("hex");

let updateServer: ReturnType<typeof Bun.serve> | null = null;
let scratchDir = "";
const originalUpdate = settings.update ?? {
	serverUrl: "https://legacy.example",
	product: "narrafork",
	channel: "stable" as const,
	checkIntervalMinutes: 60,
	autoDownload: false,
};

beforeAll(async () => {
	scratchDir = mkdtempSync(join(tmpdir(), "nf-executor-e2e-"));
	const manifest = buildExecutorManifest({
		version: EXECUTOR_VERSION,
		protocolVersion: BUILD_EXECUTOR_DISTRIBUTION.protocolVersion,
		releasedAt: new Date().toISOString(),
		artifacts: EXECUTOR_PLATFORMS.map((platform) => ({ platform, bytes: new Uint8Array(BINARY) })),
	});
	const envelope = {
		schemaVersion: 1,
		repository: REPOSITORY,
		tag: EXECUTOR_TAG,
		commit: "a".repeat(40),
		manifest,
		licenses: [{ name: "LICENSE.txt", size: 10, sha256: "a".repeat(64) }],
	};
	updateServer = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (request) => {
			const path = new URL(request.url).pathname;
			servedPaths.push(path);
			if (path === mirrorAssetPath(EXECUTOR_MANIFEST_FILENAME))
				return unavailableAsset === "manifest"
					? new Response(null, { status: 404 })
					: Response.json(envelope);
			if (path === mirrorAssetPath(BINARY_FILENAME))
				return unavailableAsset === "binary"
					? new Response(null, { status: 404 })
					: new Response(BINARY);
			return new Response(null, { status: 404 });
		},
	});
	const baseUrl = `http://localhost:${updateServer.port}`;
	setOutboundFetchOverrideForTest(async (input, init) => {
		const url = String(input);
		outboundRequests.push(url);
		const filename = new URL(url).pathname.split("/").at(-1);
		if (filename !== EXECUTOR_MANIFEST_FILENAME && filename !== BINARY_FILENAME)
			throw new Error(`Unexpected executor asset request: ${url}`);
		const expected =
			expectedRequestSource === "github"
				? `${GITHUB_PREFIX}${filename}`
				: `${baseUrl}${mirrorAssetPath(filename)}`;
		expect(url).toBe(expected);
		const response = await fetch(`${baseUrl}${mirrorAssetPath(filename)}`, init);
		return new Response(response.body, { status: response.status, headers: response.headers });
	});
});

beforeEach(() => {
	if (!updateServer) throw new Error("Missing scratch server");
	expectedRequestSource = "update-server";
	unavailableAsset = null;
	outboundRequests.length = 0;
	servedPaths.length = 0;
	resetExecutorManifestCache();
	resetExecutorTickets();
	resetExecutorBootstrapRateLimit();
	// Each case starts cold, so a verified cache cannot hide an incorrect source/endpoint.
	rmSync(HELPER_BIN_DIR, { recursive: true, force: true });
	mkdirSync(HELPER_BIN_DIR, { recursive: true });
	settings.update = {
		...originalUpdate,
		source: "update-server",
		githubRepository: REPOSITORY,
		product: PRODUCT,
		serverUrl: `http://localhost:${updateServer.port}`,
		proxy: { mode: "direct" },
	};
});
afterEach(() => {
	if (expectedRequestSource === "update-server") {
		if (!updateServer) throw new Error("Missing scratch server");
		const baseUrl = `http://localhost:${updateServer.port}`;
		expect(
			outboundRequests.some(
				(url) =>
					new URL(url).hostname === "github.com" ||
					new URL(url).hostname.endsWith(".githubusercontent.com"),
			),
		).toBe(false);
		expect(
			outboundRequests.every(
				(url) =>
					url === `${baseUrl}${mirrorAssetPath(EXECUTOR_MANIFEST_FILENAME)}` ||
					url === `${baseUrl}${mirrorAssetPath(BINARY_FILENAME)}`,
			),
		).toBe(true);
	}
});
afterAll(() => {
	updateServer?.stop(true);
	setOutboundFetchOverrideForTest(null);
	settings.update = originalUpdate;
	resetExecutorManifestCache();
	resetExecutorTickets();
	resetExecutorBootstrapRateLimit();
	rmSync(HELPER_BIN_DIR, { recursive: true, force: true });
	if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
});

async function issueBoundTicket() {
	const manifest = await getExecutorManifest();
	if (!manifest) throw new Error("Missing compatible executor manifest");
	return issueExecutorTicket("linux-amd64", {
		deviceId: "e2e-device",
		artifact: freezeExecutorArtifact(manifest, "linux-amd64"),
	});
}
function bootstrapApp() {
	const app = new Hono();
	app.route("/api/executor", executorBootstrapRoutes);
	app.onError(
		(err, c) => buildAppErrorResponse(err, c) ?? c.json({ error: "Internal server error" }, 500),
	);
	return app;
}

test("mirror mode fetches the pinned manifest and binary without GitHub and serves the bound ticket", async () => {
	const manifest = await getExecutorManifest({ forceRefresh: true });
	expect(manifest?.version).toBe(EXECUTOR_VERSION);
	expect(manifest?.platforms["linux-amd64"]?.sha256).toBe(SHA256);

	// Mirrors into the local cache with digest verification.
	const artifact = await ensureExecutorBinary("linux-amd64");
	expect(artifact.sha256).toBe(SHA256);

	const app = bootstrapApp();

	const ticket = await issueBoundTicket();
	const download = await app.request(`/api/executor/download/linux-amd64?ticket=${ticket.ticket}`);
	expect(download.status).toBe(200);
	const served = Buffer.from(await download.arrayBuffer());
	// The bytes a target machine receives must match the published digest exactly.
	expect(createHash("sha256").update(served).digest("hex")).toBe(SHA256);
	expect(download.headers.get("x-executor-sha256")).toBe(SHA256);
	expect(download.headers.get("x-executor-version")).toBe(EXECUTOR_VERSION);
	expect(download.headers.get("content-length")).toBe(String(BINARY.length));
	if (!updateServer) throw new Error("Missing scratch server");
	expect(outboundRequests).toEqual([
		`http://localhost:${updateServer.port}${mirrorAssetPath(EXECUTOR_MANIFEST_FILENAME)}`,
		`http://localhost:${updateServer.port}${mirrorAssetPath(BINARY_FILENAME)}`,
	]);
	expect(servedPaths).toEqual([
		mirrorAssetPath(EXECUTOR_MANIFEST_FILENAME),
		mirrorAssetPath(BINARY_FILENAME),
	]);

	// A retry is allowed (a dropped download must not force a new install command),
	// but the budget is finite.
	for (let attempt = 0; attempt < 4; attempt++) {
		const retry = await app.request(`/api/executor/download/linux-amd64?ticket=${ticket.ticket}`);
		expect(retry.status).toBe(200);
		expect(Buffer.from(await retry.arrayBuffer())).toEqual(BINARY);
	}
	expect(
		(await app.request(`/api/executor/download/linux-amd64?ticket=${ticket.ticket}`)).status,
	).toBe(403);
});

test("an unavailable mirror manifest fails without a GitHub fallback", async () => {
	unavailableAsset = "manifest";
	expect(await getExecutorManifest({ forceRefresh: true })).toBeNull();
	if (!updateServer) throw new Error("Missing scratch server");
	expect(outboundRequests).toEqual([
		`http://localhost:${updateServer.port}${mirrorAssetPath(EXECUTOR_MANIFEST_FILENAME)}`,
	]);
});

test("an unavailable mirror binary makes the real bootstrap route fail without GitHub", async () => {
	unavailableAsset = "binary";
	const ticket = await issueBoundTicket();
	const response = await bootstrapApp().request(
		`/api/executor/download/linux-amd64?ticket=${ticket.ticket}`,
	);
	expect(response.status).toBe(503);
	expect((await response.json()).error).toContain("selected source");
	if (!updateServer) throw new Error("Missing scratch server");
	expect(outboundRequests).toEqual([
		`http://localhost:${updateServer.port}${mirrorAssetPath(EXECUTOR_MANIFEST_FILENAME)}`,
		`http://localhost:${updateServer.port}${mirrorAssetPath(BINARY_FILENAME)}`,
	]);
});

test("a ticket remains bound to the mirror artifact when current update settings switch to GitHub", async () => {
	const ticket = await issueBoundTicket();
	const current = settings.update;
	if (!current) throw new Error("Missing update settings");
	settings.update = { ...current, source: "github" };
	const response = await bootstrapApp().request(
		`/api/executor/download/linux-amd64?ticket=${ticket.ticket}`,
	);
	expect(response.status).toBe(200);
	expect(Buffer.from(await response.arrayBuffer())).toEqual(BINARY);
	expect(response.headers.get("x-executor-sha256")).toBe(SHA256);
	// The transport expectation remains the original mirror; a ticket cannot silently repin.
	if (!updateServer) throw new Error("Missing scratch server");
	expect(outboundRequests).toEqual([
		`http://localhost:${updateServer.port}${mirrorAssetPath(EXECUTOR_MANIFEST_FILENAME)}`,
		`http://localhost:${updateServer.port}${mirrorAssetPath(BINARY_FILENAME)}`,
	]);
});

test("the default GitHub source still fetches its canonical pinned manifest and binary", async () => {
	const current = settings.update;
	if (!current) throw new Error("Missing update settings");
	settings.update = { ...current };
	delete settings.update.source;
	expectedRequestSource = "github";
	const ticket = await issueBoundTicket();
	const response = await bootstrapApp().request(
		`/api/executor/download/linux-amd64?ticket=${ticket.ticket}`,
	);
	expect(response.status).toBe(200);
	expect(Buffer.from(await response.arrayBuffer())).toEqual(BINARY);
	expect(response.headers.get("x-executor-sha256")).toBe(SHA256);
	expect(outboundRequests).toEqual([
		`${GITHUB_PREFIX}${EXECUTOR_MANIFEST_FILENAME}`,
		`${GITHUB_PREFIX}${BINARY_FILENAME}`,
	]);
});

test("the install endpoint serves the exact script attached to the ticket", async () => {
	// This is what the one-liner fetches, so it has to be the same bytes the operator
	// reviewed in the UI — not a regenerated script that could drift from it.
	const app = bootstrapApp();
	const manifest = await getExecutorManifest();
	const entry = manifest?.platforms["linux-amd64"];
	expect(entry).toBeTruthy();
	if (!entry || !manifest) throw new Error("Missing compatible executor manifest entry");

	const ticket = await issueBoundTicket();
	const generated = buildExecutorInstallScript({
		platform: "linux-amd64",
		mode: "user",
		serverBaseUrl: "https://nf.example.com",
		deviceWsUrl: "wss://nf.example.com/ws/device",
		deviceSlug: "e2e-device",
		deviceName: "E2E Device",
		connectionMode: "reverse",
		disableShell: false,
		artifactFilename: entry.filename,
		expectedSha256: entry.sha256,
		executorVersion: manifest.version,
		ticket: ticket.ticket,
		tokenDelivery: "enroll",
	});
	attachExecutorTicketScript(ticket.ticket, {
		body: generated.script,
		filename: generated.filename,
		shell: generated.shell,
	});

	const response = await app.request(`/api/executor/install/linux-amd64?ticket=${ticket.ticket}`);
	expect(response.status).toBe(200);
	expect(await response.text()).toBe(generated.script);
	// Never cached, and never sniffed into something a browser would run.
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect(response.headers.get("x-content-type-options")).toBe("nosniff");
});

test("a ticket carrying no script cannot be used to fetch one", async () => {
	const app = bootstrapApp();
	const ticket = await issueBoundTicket();
	expect(
		(await app.request(`/api/executor/install/linux-amd64?ticket=${ticket.ticket}`)).status,
	).toBe(403);
});

test("the generated install script verifies the digest of what is actually served", async () => {
	const manifest = await getExecutorManifest();
	const entry = manifest?.platforms["linux-amd64"];
	expect(entry).toBeTruthy();
	if (!entry || !manifest) throw new Error("Missing compatible executor manifest entry");

	const ticket = await issueBoundTicket();
	const generated = buildExecutorInstallScript({
		platform: "linux-amd64",
		mode: "user",
		serverBaseUrl: "https://nf.example.com",
		deviceWsUrl: "wss://nf.example.com/ws/device",
		deviceSlug: "e2e-device",
		deviceName: "E2E Device",
		connectionMode: "reverse",
		disableShell: false,
		artifactFilename: entry.filename,
		expectedSha256: entry.sha256,
		executorVersion: manifest.version,
		ticket: ticket.ticket,
	});

	// Compare the generated check against the bytes served by this exact bound ticket,
	// not merely a second copy of the manifest fixture's expected digest.
	const download = await bootstrapApp().request(
		`/api/executor/download/linux-amd64?ticket=${ticket.ticket}`,
	);
	expect(download.status).toBe(200);
	const served = Buffer.from(await download.arrayBuffer());
	expect(served).toEqual(BINARY);
	const servedSha256 = createHash("sha256").update(served).digest("hex");
	expect(servedSha256).toBe(SHA256);
	expect(generated.script).toContain(servedSha256);
	expect(generated.script).toContain(
		`https://nf.example.com/api/executor/download/linux-amd64?ticket=${ticket.ticket}`,
	);
	expect(generated.script).not.toContain("rdev_");
});
