/**
 * End-to-end check of the executor distribution path.
 *
 * Publishes a real binary to a scratch update server, then exercises the
 * NarraFork side: manifest fetch, proxied download with a one-time ticket, and
 * install-script generation. Verifies the script's own integrity checks against
 * the bytes actually served.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
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
	getExecutorManifest,
	resetExecutorManifestCache,
} from "../server/lib/executor-binaries";
import { issueExecutorTicket, resetExecutorTickets } from "../server/lib/executor-bootstrap-ticket";
import { buildExecutorInstallScript } from "../server/lib/executor-install-script";
import { HELPER_BIN_DIR } from "../server/lib/helper-binaries";
import { settings } from "../server/lib/settings";
import {
	executorBootstrapRoutes,
	resetExecutorBootstrapRateLimit,
} from "../server/routes/executor-bootstrap";
import { createApp } from "../update-server/app";
import { addToken, initConfig } from "../update-server/lib/config";
import { LocalStorage } from "../update-server/storage/local";

const BINARY = Buffer.from(`#!/bin/sh\necho fake-executor\n`.repeat(64));
const SHA256 = createHash("sha256").update(BINARY).digest("hex");

let updateServer: ReturnType<typeof Bun.serve> | null = null;
let scratchDir = "";
let originalUpdateServerUrl: string | undefined;

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
		version: "0.5.24",
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
		"narrafork-executor-0.5.24-linux-amd64",
		new Uint8Array(BINARY),
		"application/octet-stream",
	);
	await put(
		EXECUTOR_MANIFEST_FILENAME,
		new Uint8Array(Buffer.from(formatExecutorManifest(manifest))),
		"application/json",
	);

	// Point this NarraFork instance at the scratch update server.
	originalUpdateServerUrl = settings.update?.serverUrl;
	settings.update = { ...(settings.update ?? {}), serverUrl: baseUrl } as typeof settings.update;
	resetExecutorManifestCache();
	resetExecutorTickets();
	resetExecutorBootstrapRateLimit();
	rmSync(HELPER_BIN_DIR, { recursive: true, force: true });
	mkdirSync(HELPER_BIN_DIR, { recursive: true });
});

afterAll(() => {
	updateServer?.stop(true);
	if (settings.update && originalUpdateServerUrl !== undefined) {
		settings.update = {
			...settings.update,
			serverUrl: originalUpdateServerUrl,
		} as typeof settings.update;
	}
	resetExecutorManifestCache();
	resetExecutorTickets();
	resetExecutorBootstrapRateLimit();
	rmSync(HELPER_BIN_DIR, { recursive: true, force: true });
	if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
});

test("NarraFork mirrors the published release and serves it via a one-time ticket", async () => {
	const manifest = await getExecutorManifest({ forceRefresh: true });
	expect(manifest?.version).toBe("0.5.24");
	expect(manifest?.platforms["linux-amd64"]?.sha256).toBe(SHA256);

	// Mirrors into the local cache with digest verification.
	const artifact = await ensureExecutorBinary("linux-amd64");
	expect(artifact.sha256).toBe(SHA256);

	const app = new Hono();
	app.route("/api/executor", executorBootstrapRoutes);
	app.onError(
		(err, c) => buildAppErrorResponse(err, c) ?? c.json({ error: "Internal server error" }, 500),
	);

	const ticket = issueExecutorTicket("linux-amd64", { deviceId: "e2e-device" });
	const download = await app.request(`/api/executor/download/linux-amd64?ticket=${ticket.ticket}`);
	expect(download.status).toBe(200);
	const served = Buffer.from(await download.arrayBuffer());
	// The bytes a target machine receives must match the published digest exactly.
	expect(createHash("sha256").update(served).digest("hex")).toBe(SHA256);
	expect(download.headers.get("x-executor-sha256")).toBe(SHA256);

	// The ticket is spent.
	expect(
		(await app.request(`/api/executor/download/linux-amd64?ticket=${ticket.ticket}`)).status,
	).toBe(403);
});

test("the generated install script verifies the digest of what is actually served", async () => {
	const manifest = await getExecutorManifest();
	const entry = manifest?.platforms["linux-amd64"];
	expect(entry).toBeTruthy();
	if (!entry || !manifest) return;

	const ticket = issueExecutorTicket("linux-amd64", { deviceId: "e2e-device" });
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
