/**
 * The URL baked into a generated install command.
 *
 * The original defect: the endpoint accepted an optional `serverBaseUrl` but the UI
 * never sent it, so it always fell back to `new URL(c.req.url).origin` — the
 * socket-level origin, which behind a reverse proxy is the proxy's upstream target
 * (`http://127.0.0.1:7779`). Every generated script therefore told the target
 * machine to contact localhost, which fails on any machine but the server itself.
 *
 * It failed silently in the worst way: the script looked complete and correct, and
 * only the executor's connection attempt on a remote machine ever revealed it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EXECUTOR_MANIFEST_FILENAME, executorPublishedFilename } from "@shared/remote-executor";
import { inArray } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../db";
import { remoteDevices } from "../../db/schema";
import { buildAppErrorResponse } from "../../lib/app-error-response";
import { getExecutorManifest, resetExecutorManifestCache } from "../../lib/executor-binaries";
import { APP_VERSION } from "../../lib/version";

const originalFetch = globalThis.fetch;
const originalUpdate = settings.update ?? {
	serverUrl: "https://legacy.example",
	product: "narrafork",
	channel: "stable" as const,
	checkIntervalMinutes: 60,
	autoDownload: false,
};

import { resetExecutorTickets } from "../../lib/executor-bootstrap-ticket";
import { generateId } from "../../lib/id";
import { settings } from "../../lib/settings";
import { deviceRoutes } from "../devices";

const created: string[] = [];
let originalAllowPlaintext: boolean | undefined;

beforeEach(async () => {
	resetExecutorTickets();
	originalAllowPlaintext = settings.devices?.allowPlaintextEnrollmentOnPrivateNetwork;
	settings.update = {
		...originalUpdate,
		source: "update-server",
		serverUrl: "https://fixture.example",
		proxy: { mode: "direct" },
	};
	resetExecutorManifestCache();
	globalThis.fetch = (async (url: RequestInfo | URL) =>
		String(url).endsWith(EXECUTOR_MANIFEST_FILENAME)
			? Response.json({
					version: APP_VERSION,
					protocolVersion: 1,
					releasedAt: "2026-01-01T00:00:00Z",
					platforms: {
						"linux-amd64": {
							filename: executorPublishedFilename(APP_VERSION, "linux-amd64"),
							size: 256,
							sha256: "a".repeat(64),
						},
					},
				})
			: new Response(null, { status: 404 })) as typeof fetch;
	expect((await getExecutorManifest())?.platforms["linux-amd64"]).toBeTruthy();
});

afterEach(async () => {
	globalThis.fetch = originalFetch;
	settings.update = originalUpdate;
	resetExecutorManifestCache();
	if (settings.devices) {
		settings.devices.allowPlaintextEnrollmentOnPrivateNetwork = originalAllowPlaintext;
	}
	if (created.length) {
		await db.delete(remoteDevices).where(inArray(remoteDevices.id, created.splice(0)));
	}
	resetExecutorTickets();
});

function app(): Hono {
	const instance = new Hono();
	instance.use("*", async (c, next) => {
		c.set("user", { sub: "user-owner", role: "admin", iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	instance.route("/api/devices", deviceRoutes);
	instance.onError(
		(err, c) => buildAppErrorResponse(err, c) ?? c.json({ error: "Internal server error" }, 500),
	);
	return instance;
}

async function makeDevice(): Promise<string> {
	const now = new Date().toISOString();
	const id = generateId();
	await db.insert(remoteDevices).values({
		id,
		name: `Install ${id.slice(0, 6)}`,
		slug: `install-${id.slice(0, 8).toLowerCase()}`,
		tokenHash: "0".repeat(64),
		tokenPrefix: "rdev_test",
		connectionMode: "reverse",
		scope: "global",
		createdBy: "user-owner",
		createdAt: now,
		updatedAt: now,
	});
	created.push(id);
	return id;
}

interface GenerateOptions {
	body?: Record<string, unknown>;
	/** URL the request arrives on (the socket origin). */
	requestOrigin?: string;
	headers?: Record<string, string>;
	trustedProxy?: boolean;
}

async function generate(deviceId: string, options: GenerateOptions = {}) {
	const origin = options.requestOrigin ?? "http://127.0.0.1:7779";
	return app().request(
		`${origin}/api/devices/${deviceId}/install-script`,
		{
			method: "POST",
			headers: { "content-type": "application/json", ...(options.headers ?? {}) },
			body: JSON.stringify({
				platform: "linux-amd64",
				mode: "user",
				...(options.body ?? {}),
			}),
		},
		{ trustedProxy: options.trustedProxy ?? false },
	);
}

describe("server URL composition", () => {
	test("an unsupported release platform stays a client validation error", async () => {
		const id = await makeDevice();
		const response = await generate(id, { body: { platform: "windows-arm64" } });
		expect(response.status).toBe(400);
		expect((await response.json()).error).toContain("does not publish a build");
	});
	test("an explicit base URL is what lands in the command", async () => {
		const id = await makeDevice();
		const response = await generate(id, {
			body: { serverBaseUrl: "https://nf.example.com" },
			requestOrigin: "http://127.0.0.1:7779",
		});
		expect(response.status).toBe(200);
		const result = await response.json();

		// The operator's URL wins over the socket origin the request arrived on.
		expect(result.oneLiner).toContain("https://nf.example.com/api/executor/install/linux-amd64");
		expect(result.scriptUrl).toStartWith("https://nf.example.com/");
		expect(result.script).toContain("wss://nf.example.com/ws/device");
		expect(result.script).not.toContain("127.0.0.1");
		expect(result.oneLiner).not.toContain("localhost");
	});

	test("the forwarded public origin is used behind a trusted proxy", async () => {
		const id = await makeDevice();
		const response = await generate(id, {
			// Exactly the deployment that produced the original bug: nginx forwards to
			// 127.0.0.1 and the script must still name the public host.
			requestOrigin: "http://127.0.0.1:7779",
			headers: { "X-Forwarded-Proto": "https", "X-Forwarded-Host": "nf.example.com" },
			trustedProxy: true,
		});
		expect(response.status).toBe(200);
		const result = await response.json();
		expect(result.scriptUrl).toStartWith("https://nf.example.com/");
		expect(result.script).toContain("wss://nf.example.com/ws/device");
		expect(result.script).not.toContain("127.0.0.1:7779");
	});

	test("a trailing slash does not produce a doubled path separator", async () => {
		const id = await makeDevice();
		const result = await (
			await generate(id, { body: { serverBaseUrl: "https://nf.example.com/" } })
		).json();
		expect(result.scriptUrl).not.toContain("//api/executor");
	});
});

describe("the one-liner shape", () => {
	test("unix commands use command substitution, not a pipe into sh", async () => {
		/*
		 * A pipe puts the script on stdin; system-mode installs run sudo, which then
		 * falls back to /dev/tty and fails wherever there is no controlling terminal.
		 * Pinned at the endpoint too, since this is the string operators actually copy.
		 */
		const id = await makeDevice();
		const result = await (
			await generate(id, { body: { serverBaseUrl: "https://nf.example.com", mode: "system" } })
		).json();
		expect(result.oneLiner).toStartWith('sh -c "$(curl -fsSL ');
		expect(result.oneLiner).not.toContain("| sh");
	});
});

describe("token delivery gating", () => {
	test("enroll is the default", async () => {
		const id = await makeDevice();
		const result = await (
			await generate(id, { body: { serverBaseUrl: "https://nf.example.com" } })
		).json();
		expect(result.tokenDelivery).toBe("enroll");
		expect(result.script).toContain("/api/executor/enroll/");
	});

	test("enroll over plaintext http on a public host is refused with a remedy", async () => {
		// Refused while the operator is still in the UI, where https, the setting, or
		// manual entry are all actionable — rather than mid-install on the target.
		const id = await makeDevice();
		const response = await generate(id, {
			body: { serverBaseUrl: "http://nf.example.com", tokenDelivery: "enroll" },
		});
		expect(response.status).toBe(400);
		expect((await response.json()).error).toContain("manual key entry");
	});

	test("prompt delivery works over plaintext http, since it carries no key", async () => {
		const id = await makeDevice();
		const response = await generate(id, {
			body: { serverBaseUrl: "http://nf.example.com", tokenDelivery: "prompt" },
		});
		expect(response.status).toBe(200);
		const result = await response.json();
		expect(result.tokenDelivery).toBe("prompt");
		expect(result.script).not.toContain("/api/executor/enroll/");
		expect(result.script).toContain("Paste the device registration key");
	});

	test("enroll over plaintext http on a private network follows the setting", async () => {
		const id = await makeDevice();
		if (settings.devices) {
			settings.devices.allowPlaintextEnrollmentOnPrivateNetwork = false;
		}
		expect(
			(
				await generate(id, {
					body: { serverBaseUrl: "http://192.168.1.20:7779", tokenDelivery: "enroll" },
				})
			).status,
		).toBe(400);

		if (settings.devices) {
			settings.devices.allowPlaintextEnrollmentOnPrivateNetwork = true;
		}
		expect(
			(
				await generate(id, {
					body: { serverBaseUrl: "http://192.168.1.20:7779", tokenDelivery: "enroll" },
				})
			).status,
		).toBe(200);
	});
});

describe("the generated command is self-serving", () => {
	test("the script URL it advertises actually returns the script", async () => {
		// The endpoint mints a ticket and attaches the rendered body to it. If that
		// attachment were missed, the command would 403 on the target machine while the
		// UI looked perfectly fine.
		const id = await makeDevice();
		const result = await (
			await generate(id, { body: { serverBaseUrl: "https://nf.example.com" } })
		).json();

		const { executorBootstrapRoutes, resetExecutorBootstrapRateLimit } = await import(
			"../executor-bootstrap"
		);
		resetExecutorBootstrapRateLimit();
		const bootstrap = new Hono();
		bootstrap.route("/api/executor", executorBootstrapRoutes);
		const fetched = await bootstrap.request(result.scriptUrl);
		expect(fetched.status).toBe(200);
		expect(await fetched.text()).toBe(result.script);
	});
});
