/**
 * End-to-end check of the executor distribution path.
 *
 * Publishes a real binary to a scratch update server, then exercises the
 * NarraFork side: manifest fetch, proxied download with a one-time ticket, and
 * install-script generation. Verifies the script's own integrity checks against
 * the bytes actually served.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXECUTOR_MANIFEST_FILENAME } from "@shared/remote-executor";
import { Hono } from "hono";
import { buildExecutorManifest, formatExecutorManifest } from "../scripts/lib/executor-manifest";
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
import { APP_VERSION } from "../server/lib/version";
import {
	executorBootstrapRoutes,
	resetExecutorBootstrapRateLimit,
} from "../server/routes/executor-bootstrap";
import { createApp } from "../update-server/app";
import { addToken, initConfig } from "../update-server/lib/config";
import { LocalStorage } from "../update-server/storage/local";

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
	await initConfig(join(scratchDir, "config.json"));
	const { token } = await addToken("e2e-uploader", "upload");
	const storage = new LocalStorage(join(scratchDir, "data"));
	const app = createApp(storage);
	updateServer = Bun.serve({ port: 0, fetch: app.fetch });
	const baseUrl = `http://localhost:${updateServer.port}`;

	// Publish through the real HTTP upload path, not by writing files directly.
	const manifest = buildExecutorManifest({
		version: APP_VERSION,
		protocolVersion: 1,
		releasedAt: new Date().toISOString(),
		artifacts: [{ platform: "linux-amd64", bytes: new Uint8Array(BINARY) }],
	});
	const put = async (filename: string, body: Uint8Array, contentType: string) => {
		const response = await fetch(`${baseUrl}/api/v2/tools/${filename}`, {
			method: "PUT",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": contentType },
			body: new Blob([Uint8Array.from(body)]),
		});
		expect(response.status).toBe(200);
	};
	await put(
		`narrafork-executor-${APP_VERSION}-linux-amd64`,
		new Uint8Array(BINARY),
		"application/octet-stream",
	);
	await put(
		EXECUTOR_MANIFEST_FILENAME,
		new Uint8Array(Buffer.from(formatExecutorManifest(manifest))),
		"application/json",
	);

	// Point this NarraFork instance at the scratch update server.
	settings.update = {
		...originalUpdate,
		source: "update-server",
		serverUrl: baseUrl,
		proxy: { mode: "direct" },
	};
	resetExecutorManifestCache();
	resetExecutorTickets();
	resetExecutorBootstrapRateLimit();
	rmSync(HELPER_BIN_DIR, { recursive: true, force: true });
	mkdirSync(HELPER_BIN_DIR, { recursive: true });
});

beforeEach(() => {
	if (!updateServer) throw new Error("Missing scratch server");
	settings.update = {
		...originalUpdate,
		source: "update-server",
		serverUrl: `http://localhost:${updateServer.port}`,
		proxy: { mode: "direct" },
	};
});
afterAll(() => {
	updateServer?.stop(true);
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

test("NarraFork mirrors the published release and serves it against a ticket", async () => {
	const manifest = await getExecutorManifest({ forceRefresh: true });
	expect(manifest?.version).toBe(APP_VERSION);
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

	// A retry is allowed (a dropped download must not force a new install command),
	// but the budget is finite.
	for (let attempt = 0; attempt < 4; attempt++) {
		expect(
			(await app.request(`/api/executor/download/linux-amd64?ticket=${ticket.ticket}`)).status,
		).toBe(200);
	}
	expect(
		(await app.request(`/api/executor/download/linux-amd64?ticket=${ticket.ticket}`)).status,
	).toBe(403);
});

test("the install endpoint serves the exact script attached to the ticket", async () => {
	// This is what the one-liner fetches, so it has to be the same bytes the operator
	// reviewed in the UI — not a regenerated script that could drift from it.
	const app = bootstrapApp();
	const manifest = await getExecutorManifest();
	const entry = manifest?.platforms["linux-amd64"];
	expect(entry).toBeTruthy();
	if (!entry || !manifest) return;

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
	if (!entry || !manifest) return;

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

	// The digest baked into the script is the digest of the real published bytes.
	expect(generated.script).toContain(SHA256);
	expect(generated.script).toContain(
		`https://nf.example.com/api/executor/download/linux-amd64?ticket=${ticket.ticket}`,
	);
	expect(generated.script).not.toContain("rdev_");
});
