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
import {
	EXECUTOR_MANIFEST_FILENAME,
	EXECUTOR_PLATFORMS,
	executorPublishedFilename,
} from "@shared/remote-executor";
import { inArray } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../db";
import { remoteDevices } from "../../db/schema";
import { buildAppErrorResponse } from "../../lib/app-error-response";
import { getExecutorManifest, resetExecutorManifestCache } from "../../lib/executor-binaries";
import { BUILD_EXECUTOR_DISTRIBUTION } from "../../lib/version";

type ExecutorPlatform = (typeof EXECUTOR_PLATFORMS)[number];
const platformSha256 = (platform: ExecutorPlatform) =>
	(EXECUTOR_PLATFORMS.indexOf(platform) + 1).toString(16).repeat(64);
const EXECUTOR_VERSION = BUILD_EXECUTOR_DISTRIBUTION.version;
const repository = "fixture/install-script-url";
const tag = `executor-v${EXECUTOR_VERSION}`;
const manifestUrl = `https://github.com/${repository}/releases/download/${tag}/${EXECUTOR_MANIFEST_FILENAME}`;

function canonicalManifest() {
	return {
		schemaVersion: 1,
		repository,
		tag,
		commit: "a".repeat(40),
		manifest: {
			version: EXECUTOR_VERSION,
			protocolVersion: BUILD_EXECUTOR_DISTRIBUTION.protocolVersion,
			releasedAt: "2026-01-01T00:00:00Z",
			platforms: Object.fromEntries(
				EXECUTOR_PLATFORMS.map((platform) => [
					platform,
					{
						filename: executorPublishedFilename(EXECUTOR_VERSION, platform),
						size: 256,
						sha256: platformSha256(platform),
					},
				]),
			),
		},
		licenses: [{ name: "LICENSE.txt", size: 10, sha256: "b".repeat(64) }],
	};
}

const originalFetch = globalThis.fetch;
const originalUpdate = settings.update ?? {
	serverUrl: "https://legacy.example",
	product: "narrafork",
	channel: "stable" as const,
	checkIntervalMinutes: 60,
	autoDownload: false,
};

import {
	countLiveExecutorTickets,
	redeemExecutorTicket,
	resetExecutorTickets,
} from "../../lib/executor-bootstrap-ticket";
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
		githubRepository: repository,
		serverUrl: "https://fixture.example",
		proxy: { mode: "direct" },
	};
	resetExecutorManifestCache();
	globalThis.fetch = Object.assign(
		async (url: RequestInfo | URL) => {
			expect(String(url)).toBe(manifestUrl);
			return Response.json(canonicalManifest());
		},
		{ preconnect: originalFetch.preconnect },
	);
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
				target: "unix",
				mode: "user",
				...(options.body ?? {}),
			}),
		},
		{ trustedProxy: options.trustedProxy ?? false },
	);
}

function installUrls(script: string): Map<ExecutorPlatform, string> {
	const matches = [
		...script.matchAll(
			/(https?:\/\/[^\s"'`<>]+\/api\/executor\/install\/(linux-amd64|linux-arm64|darwin-amd64|darwin-arm64|windows-amd64|windows-arm64)\?ticket=[a-f0-9]{16,256})/g,
		),
	];
	expect(matches.length).toBeGreaterThan(0);
	return new Map(matches.map((match) => [match[2] as ExecutorPlatform, match[1]]));
}

async function fetchFinalScript(script: string, platform: ExecutorPlatform = "linux-amd64") {
	const url = installUrls(script).get(platform);
	expect(url).toBeDefined();
	if (!url) throw new Error(`Bootstrap is missing ${platform}`);
	const { executorBootstrapRoutes, resetExecutorBootstrapRateLimit } = await import(
		"../executor-bootstrap"
	);
	resetExecutorBootstrapRateLimit();
	const bootstrap = new Hono();
	bootstrap.route("/api/executor", executorBootstrapRoutes);
	const fetched = await bootstrap.request(url);
	expect(fetched.status).toBe(200);
	return fetched.text();
}

describe("server URL composition", () => {
	test.each([
		"freebsd",
		"linux-amd64",
		"macos",
	])("unsupported target %s stays a client validation error", async (target) => {
		const id = await makeDevice();
		const response = await generate(id, { body: { target } });
		expect(response.status).toBe(400);
		expect((await response.json()).error).toContain("target");
		expect(countLiveExecutorTickets()).toBe(0);
	});
	test.each([
		"repository",
		"tag",
	] as const)("canonical %s mismatch cannot mint an install ticket", async (change) => {
		const id = await makeDevice();
		if (!settings.update) throw new Error("Missing update settings");
		const expectedRepository = `fixture/install-${change}-change`;
		settings.update.githubRepository = expectedRepository;
		const metadata = canonicalManifest();
		if (change === "tag") {
			metadata.repository = expectedRepository;
			metadata.tag = "executor-v99.0.0";
		}
		const calls: string[] = [];
		globalThis.fetch = Object.assign(
			async (input: RequestInfo | URL) => {
				calls.push(String(input));
				return Response.json(metadata);
			},
			{ preconnect: originalFetch.preconnect },
		);
		const response = await generate(id, { body: { serverBaseUrl: "https://nf.example.com" } });
		expect(response.status).toBe(400);
		expect((await response.json()).error).toContain("No compatible executor release");
		expect(calls).toEqual([
			`https://github.com/${expectedRepository}/releases/download/${tag}/${EXECUTOR_MANIFEST_FILENAME}`,
		]);
		expect(countLiveExecutorTickets()).toBe(0);
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
		expect(result).not.toHaveProperty("scriptUrl");
		for (const url of installUrls(result.script).values()) {
			expect(url).toStartWith("https://nf.example.com/");
		}
		const finalScript = await fetchFinalScript(result.script);
		expect(finalScript).toContain("wss://nf.example.com/ws/device");
		expect(finalScript).not.toContain("127.0.0.1");
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
		for (const url of installUrls(result.script).values()) {
			expect(url).toStartWith("https://nf.example.com/");
		}
		const finalScript = await fetchFinalScript(result.script);
		expect(finalScript).toContain("wss://nf.example.com/ws/device");
		expect(finalScript).not.toContain("127.0.0.1:7779");
		expect(result.script).not.toContain("127.0.0.1:7779");
	});

	test("a trailing slash does not produce a doubled path separator", async () => {
		const id = await makeDevice();
		const result = await (
			await generate(id, { body: { serverBaseUrl: "https://nf.example.com/" } })
		).json();
		for (const url of installUrls(result.script).values()) {
			expect(url).toStartWith("https://nf.example.com/api/executor/install/");
			expect(url).not.toContain("//api/executor");
		}
	});
});

describe("the one-liner shape", () => {
	test("unix commands preserve stdin instead of piping the script into sh", async () => {
		// The bootstrap downloads a bounded temporary file and executes it by path.
		// Never occupy stdin: system-mode sudo and manual key entry need it.
		const id = await makeDevice();
		const result = await (
			await generate(id, { body: { serverBaseUrl: "https://nf.example.com", mode: "system" } })
		).json();
		expect(result.oneLiner).toStartWith("sh -c ");
		for (const command of [result.oneLiner, result.script]) {
			expect(command).toContain('"$NF_INSTALL_SCRIPT_URL" -o "$d/install.sh"');
			expect(command).toContain('sh "$d/install.sh"');
			expect(command).not.toContain("| sh");
			expect(command).not.toContain("|sh");
		}
	});
});

describe("token delivery gating", () => {
	test("enroll is the default", async () => {
		const id = await makeDevice();
		const result = await (
			await generate(id, { body: { serverBaseUrl: "https://nf.example.com" } })
		).json();
		expect(result.tokenDelivery).toBe("enroll");
		expect(await fetchFinalScript(result.script)).toContain("/api/executor/enroll/");
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
		const finalScript = await fetchFinalScript(result.script);
		expect(finalScript).not.toContain("/api/executor/enroll/");
		expect(finalScript).toContain("Paste the device registration key");
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
	test.each([
		"unix",
		"windows",
	] as const)("%s bootstrap serves every matching platform under one ticket", async (target) => {
		const id = await makeDevice();
		const response = await generate(id, {
			body: { target, serverBaseUrl: "https://nf.example.com" },
		});
		expect(response.status).toBe(200);
		const result = await response.json();
		const expected = EXECUTOR_PLATFORMS.filter(
			(platform) => platform.startsWith("windows-") === (target === "windows"),
		);
		expect(result.target).toBe(target);
		expect(result.platforms).toEqual(expected);
		expect(result.shell).toBe(target === "unix" ? "sh" : "powershell");
		expect(result.filename).toBe(
			`install-narrafork-executor-${target}.${target === "unix" ? "sh" : "ps1"}`,
		);
		expect(result.executorVersion).toBe(EXECUTOR_VERSION);
		expect(Date.parse(result.expiresAt)).toBeGreaterThan(Date.now());
		expect(result).not.toHaveProperty("scriptUrl");
		const urls = installUrls(result.script);
		expect([...urls.keys()]).toEqual(expected);
		expect(
			new Set([...urls.values()].map((url) => new URL(url).searchParams.get("ticket"))).size,
		).toBe(1);
		expect(countLiveExecutorTickets()).toBe(1);
		for (const platform of expected) {
			const url = urls.get(platform);
			expect(url).toStartWith(`https://nf.example.com/api/executor/install/${platform}?ticket=`);
			expect(result.oneLiner).toContain(url);
			const finalScript = await fetchFinalScript(result.script, platform);
			expect(finalScript).not.toBe(result.script);
			if (!url) throw new Error(`Missing ${platform} URL`);
			const ticket = new URL(url).searchParams.get("ticket");
			const binary = redeemExecutorTicket(ticket, platform, "binary");
			expect(binary.ok).toBe(true);
			expect(binary.artifact?.filename).toBe(executorPublishedFilename(EXECUTOR_VERSION, platform));
			expect(binary.artifact?.sha256).toBe(platformSha256(platform));
			expect(finalScript).toContain(
				target === "unix"
					? `EXPECTED_SHA256='${platformSha256(platform)}'`
					: `$expectedSha256 = '${platformSha256(platform)}'`,
			);
			expect(finalScript).toContain(
				`https://nf.example.com/api/executor/download/${platform}?ticket=${ticket}`,
			);
			expect(finalScript).toContain("wss://nf.example.com/ws/device");
			expect(finalScript).toContain(`/api/executor/enroll/${platform}?ticket=${ticket}`);
			const outsideGroup = target === "unix" ? "windows-amd64" : "linux-amd64";
			expect(redeemExecutorTicket(ticket, outsideGroup, "script").ok).toBe(false);
		}
	});

	test("regenerating after an address change updates every platform's final configuration", async () => {
		const id = await makeDevice();
		for (const target of ["unix", "windows"] as const) {
			for (const address of ["172.30.8.150", "172.30.23.61"]) {
				const response = await generate(id, {
					body: { target, serverBaseUrl: `https://${address}:7779` },
				});
				expect(response.status).toBe(200);
				const result = await response.json();
				for (const [platform, url] of installUrls(result.script)) {
					expect(url).toStartWith(`https://${address}:7779/api/executor/install/${platform}`);
					const finalScript = await fetchFinalScript(result.script, platform);
					expect(finalScript).toContain(`wss://${address}:7779/ws/device`);
					expect(finalScript).toContain(
						`https://${address}:7779/api/executor/download/${platform}`,
					);
					if (address === "172.30.23.61") {
						expect(finalScript).not.toContain("172.30.8.150");
						expect(result.script).not.toContain("172.30.8.150");
						expect(result.oneLiner).not.toContain("172.30.8.150");
					}
				}
			}
		}
	});
});
