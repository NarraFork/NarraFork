import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import type { SavedGrant } from "../../shared/remote-access/browser-client";
import vectors from "../../shared/remote-access/vectors.json";

function browserExecutable(): string {
	const homes = [process.env.NARRAFORK_ORIGINAL_HOME, homedir()].filter(
		(value): value is string => !!value,
	);
	const cached = homes.flatMap((home) => {
		const root = join(home, ".cache/puppeteer");
		return existsSync(root)
			? Array.from(new Bun.Glob("chrome/*/chrome-linux64/chrome").scanSync({ cwd: root }), (path) =>
					join(root, path),
				)
			: [];
	});
	const executable = [
		process.env.NF_TEST_CHROMIUM_PATH,
		process.env.PUPPETEER_EXECUTABLE_PATH,
		"/usr/bin/chromium",
		"/usr/bin/google-chrome",
		...cached,
	].find((path): path is string => !!path && existsSync(path));
	if (!executable) throw new Error("CHROMIUM_REQUIRED: origin isolation must not silently skip");
	return executable;
}

interface PageState {
	popup?: Window | null;
	received?: SavedGrant;
}

async function staticModules(): Promise<Map<string, string>> {
	const modules = new Map<string, string>();
	for (const [url, entrypoint] of [
		["/client.js", "shared/remote-access/browser-client.ts"],
		["/identity.js", "shared/remote-access/identity.ts"],
	] as const) {
		const build = await Bun.build({ entrypoints: [entrypoint], target: "browser", format: "esm" });
		if (!build.success || build.outputs.length !== 1)
			throw new Error(`BROWSER_BUNDLE_FAILED: ${build.logs.join("\n")}`);
		modules.set(url, await build.outputs[0].text());
	}
	return modules;
}

/** Static-only loopback origin. No fixture, API, signal server, peer or invitation endpoint. */
function staticOrigin(modules: Map<string, string>) {
	return Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const path = new URL(request.url).pathname;
			if (request.method !== "GET") return new Response(null, { status: 405 });
			if (path === "/")
				return new Response(
					"<!doctype html><meta charset=utf-8><title>M1 isolated origin</title>",
					{
						headers: { "Content-Type": "text/html", "Cache-Control": "no-store" },
					},
				);
			const module = modules.get(path);
			if (module !== undefined)
				return new Response(module, {
					headers: { "Content-Type": "text/javascript", "Cache-Control": "no-store" },
				});
			return new Response(null, { status: 404 });
		},
	});
}

/**
 * M1 evidence only: distinct loopback ports are distinct origins in one browser context.
 * Does not validate production wildcard DNS/TLS, installed PWA/manifest/SW or real RTC.
 * Public golden scalar=1 is used only to VERIFY; runtime browser private keys are random.
 */
describe("M1 real Chromium WebCrypto and independent origin storage", () => {
	let browser: Browser;
	let pageA: Page;
	let pageB: Page;
	let originA: string;
	let originB: string;
	const servers: ReturnType<typeof staticOrigin>[] = [];
	const token = "same-test-business-token";
	const grantId = "same-test-grant-id";
	const originalCapability = "same-test-discovery-capability";
	const requests: string[] = [];

	beforeAll(async () => {
		const modules = await staticModules();
		const first = staticOrigin(modules);
		servers.push(first);
		const second = staticOrigin(modules);
		servers.push(second);
		originA = `http://127.0.0.1:${first.port}`;
		originB = `http://127.0.0.1:${second.port}`;
		browser = await puppeteer.launch({
			executablePath: browserExecutable(),
			headless: true,
			args: ["--no-sandbox", "--disable-dev-shm-usage"],
		});
		// Default fresh Puppeteer profile; both pages intentionally share its browser context.
		pageA = await browser.newPage();
		pageA.on("request", (request) => requests.push(request.url()));
		await pageA.goto(originA, { waitUntil: "domcontentloaded" });
		const secondTarget = browser.waitForTarget((target) => target.url() === `${originB}/`, {
			timeout: 10000,
		});
		await pageA.evaluate((url) => {
			(window as unknown as PageState).popup = window.open(url, "m1-storage-isolation");
		}, originB);
		const target = await secondTarget;
		const popup = await target.page();
		if (!popup) throw new Error("SECOND_ORIGIN_PAGE_REQUIRED");
		pageB = popup;
		pageB.on("request", (request) => requests.push(request.url()));
		await pageB.waitForFunction(() => document.readyState === "complete");
		await pageB.evaluate((expectedOrigin) => {
			window.addEventListener("message", (event: MessageEvent<SavedGrant>) => {
				if (event.origin !== expectedOrigin || event.source !== window.opener) return;
				(window as unknown as PageState).received = event.data;
			});
		}, originA);
		// Structured clone a RANDOM, NON-EXPORTABLE key to make actual key equality intentional.
		// This fixture message stays in the browser, is origin-bound and never goes to either server.
		await pageA.evaluate(
			async (data) => {
				const identityPath = "/identity.js";
				const clientPath = "/client.js";
				const identity = (await import(
					identityPath
				)) as typeof import("../../shared/remote-access/identity");
				const client = (await import(
					clientPath
				)) as typeof import("../../shared/remote-access/browser-client");
				const pair = await identity.generateIdentity();
				const grant: SavedGrant = {
					instanceId: data.instanceId,
					publicKey: data.publicKey,
					signalUrl: `${data.originA.replace("http:", "ws:")}/signal/browser`,
					grantId: data.grantId,
					clientPublicKey: pair.publicKey,
					privateKey: pair.privateKey,
					discoveryCapability: data.capability,
					expiresAt: Math.floor(Date.now() / 1000) + 3600,
				};
				localStorage.setItem("business-token", data.token);
				await client.saveGrant(grant);
				const other = (window as unknown as PageState).popup;
				if (!other) throw new Error("POPUP_REQUIRED");
				other.postMessage(grant, data.originB);
			},
			{
				instanceId: vectors.instanceId,
				publicKey: vectors.publicKey,
				originA,
				originB,
				grantId,
				capability: originalCapability,
				token,
			},
		);
		await pageB.waitForFunction(() => !!(window as unknown as PageState).received);
		await pageB.evaluate(async (businessToken) => {
			const path = "/client.js";
			const client = (await import(
				path
			)) as typeof import("../../shared/remote-access/browser-client");
			const state = window as unknown as PageState;
			if (!state.received) throw new Error("GRANT_REQUIRED");
			await client.saveGrant(state.received);
			localStorage.setItem("business-token", businessToken);
			delete state.received;
		}, token);
	}, 30000);

	afterAll(async () => {
		try {
			await browser?.close();
		} finally {
			for (const server of servers) server.stop(true);
		}
	});

	test("golden SEC1 fingerprint, actual NUL transcript and 64-byte P1363 signature verify in Chromium", async () => {
		const result = await pageA.evaluate(async (golden) => {
			const path = "/identity.js";
			const identity = (await import(path)) as typeof import("../../shared/remote-access/identity");
			const raw = identity.unhex(golden.publicKey);
			const key = await crypto.subtle.importKey(
				"raw",
				raw,
				{ name: "ECDSA", namedCurve: "P-256" },
				true,
				["verify"],
			);
			const transcript = identity.transcript(golden.label, golden.fields);
			const signature = identity.unhex(golden.signature);
			return {
				instanceId: await identity.instanceId(golden.publicKey),
				publicKey: identity.hex(new Uint8Array(await crypto.subtle.exportKey("raw", key))),
				publicBytes: raw.byteLength,
				sec1Prefix: raw[0],
				transcript: identity.hex(transcript),
				actualNul: transcript[new TextEncoder().encode("narrafork-remote-v1").byteLength] === 0,
				hash: await identity.sha256Hex(golden.hashInput),
				signatureBytes: signature.byteLength,
				nativeVerify: await crypto.subtle.verify(
					{ name: "ECDSA", hash: "SHA-256" },
					key,
					signature,
					transcript,
				),
				helperVerify: await identity.verify(
					golden.publicKey,
					golden.signature,
					golden.label,
					golden.fields,
				),
				modifiedRejects: !(await identity.verify(golden.publicKey, golden.signature, golden.label, [
					"other-challenge",
					golden.publicKey,
				])),
				wrongLabelRejects: !(await identity.verify(
					golden.publicKey,
					golden.signature,
					"offer",
					golden.fields,
				)),
			};
		}, vectors);
		expect(result.instanceId).toBe(vectors.instanceId);
		expect(result.publicKey).toBe(vectors.publicKey);
		expect(result.publicBytes).toBe(65);
		expect(result.sec1Prefix).toBe(4);
		expect(result.transcript).toBe(vectors.transcriptHex);
		expect(result.actualNul).toBe(true);
		expect(result.hash).toBe(vectors.hash);
		expect(result.signatureBytes).toBe(64);
		expect(result.nativeVerify).toBe(true);
		expect(result.helperVerify).toBe(true);
		expect(result.modifiedRejects).toBe(true);
		expect(result.wrongLabelRejects).toBe(true);
	});

	test("same token and grant key stay independent after writes, reload and CryptoKey structured clone", async () => {
		expect(originA).not.toBe(originB);
		expect(pageA.browserContext()).toBe(pageB.browserContext());
		await pageA.evaluate(async (id) => {
			const path = "/client.js";
			const client = (await import(
				path
			)) as typeof import("../../shared/remote-access/browser-client");
			const grant = await client.loadGrant(id);
			if (!grant) throw new Error("GRANT_REQUIRED");
			localStorage.setItem("origin-marker", "only-origin-A");
			await client.saveGrant({ ...grant, discoveryCapability: "only-origin-A" });
		}, vectors.instanceId);
		// Reload both to discard in-memory key objects: all signatures below use IndexedDB copies.
		await Promise.all([
			pageA.reload({ waitUntil: "domcontentloaded" }),
			pageB.reload({ waitUntil: "domcontentloaded" }),
		]);
		const read = async (page: Page) =>
			page.evaluate(async (id) => {
				const clientPath = "/client.js";
				const identityPath = "/identity.js";
				const client = (await import(
					clientPath
				)) as typeof import("../../shared/remote-access/browser-client");
				const identity = (await import(
					identityPath
				)) as typeof import("../../shared/remote-access/identity");
				const grant = await client.loadGrant(id);
				if (!grant) throw new Error("GRANT_REQUIRED");
				const fields = [
					id,
					"storage-session",
					"a".repeat(64),
					"b".repeat(64),
					"storage-nonce",
					grant.clientPublicKey,
				];
				const signature = await identity.sign(grant.privateKey, "hello", fields);
				let exportRejected = false;
				try {
					await crypto.subtle.exportKey("pkcs8", grant.privateKey);
				} catch {
					exportRejected = true;
				}
				return {
					origin: location.origin,
					secureContext: isSecureContext,
					token: localStorage.getItem("business-token"),
					marker: localStorage.getItem("origin-marker"),
					grantId: grant.grantId,
					capability: grant.discoveryCapability,
					publicKey: grant.clientPublicKey,
					nativeCryptoKey: grant.privateKey instanceof CryptoKey,
					extractable: grant.privateKey.extractable,
					privateType: grant.privateKey.type,
					exportRejected,
					signatureBytes: identity.unhex(signature).byteLength,
					verified: await identity.verify(grant.clientPublicKey, signature, "hello", fields),
					signature,
					fields,
				};
			}, vectors.instanceId);
		const [first, second] = await Promise.all([read(pageA), read(pageB)]);
		expect(first.origin).toBe(originA);
		expect(second.origin).toBe(originB);
		expect(first.token).toBe(token);
		expect(second.token).toBe(token);
		expect(first.grantId).toBe(grantId);
		expect(second.grantId).toBe(grantId);
		expect(first.publicKey).toBe(second.publicKey);
		expect(first.marker).toBe("only-origin-A");
		expect(second.marker).toBeNull();
		expect(first.capability).toBe("only-origin-A");
		expect(second.capability).toBe(originalCapability);
		for (const result of [first, second]) {
			expect(result.secureContext).toBe(true);
			expect(result.nativeCryptoKey).toBe(true);
			expect(result.extractable).toBe(false);
			expect(result.privateType).toBe("private");
			expect(result.exportRejected).toBe(true);
			expect(result.signatureBytes).toBe(64);
			expect(result.verified).toBe(true);
		}
		const crossVerified = await pageB.evaluate(async (proof) => {
			const path = "/identity.js";
			const identity = (await import(path)) as typeof import("../../shared/remote-access/identity");
			return identity.verify(proof.publicKey, proof.signature, "hello", proof.fields);
		}, first);
		expect(crossVerified).toBe(true);
	});

	test("clearing A localStorage and saved grant leaves identical B credentials and key usable", async () => {
		await pageA.evaluate(async (id) => {
			const path = "/client.js";
			const client = (await import(
				path
			)) as typeof import("../../shared/remote-access/browser-client");
			localStorage.clear();
			await client.forgetGrant(id);
		}, vectors.instanceId);
		await pageA.reload({ waitUntil: "domcontentloaded" });
		const first = await pageA.evaluate(async (id) => {
			const path = "/client.js";
			const client = (await import(
				path
			)) as typeof import("../../shared/remote-access/browser-client");
			return {
				token: localStorage.getItem("business-token"),
				grantMissing: (await client.loadGrant(id)) === undefined,
			};
		}, vectors.instanceId);
		const second = await pageB.evaluate(async (id) => {
			const clientPath = "/client.js";
			const identityPath = "/identity.js";
			const client = (await import(
				clientPath
			)) as typeof import("../../shared/remote-access/browser-client");
			const identity = (await import(
				identityPath
			)) as typeof import("../../shared/remote-access/identity");
			const grant = await client.loadGrant(id);
			if (!grant) throw new Error("GRANT_REQUIRED");
			const fields = [
				id,
				"after-clear",
				"a".repeat(64),
				"b".repeat(64),
				"nonce",
				grant.clientPublicKey,
			];
			const signature = await identity.sign(grant.privateKey, "hello", fields);
			return {
				token: localStorage.getItem("business-token"),
				grantId: grant.grantId,
				capability: grant.discoveryCapability,
				extractable: grant.privateKey.extractable,
				verified: await identity.verify(grant.clientPublicKey, signature, "hello", fields),
			};
		}, vectors.instanceId);
		expect(first.token).toBeNull();
		expect(first.grantMissing).toBe(true);
		expect(second.token).toBe(token);
		expect(second.grantId).toBe(grantId);
		expect(second.capability).toBe(originalCapability);
		expect(second.extractable).toBe(false);
		expect(second.verified).toBe(true);
		// Static test origins never receive JWT, grant capability or private key via HTTP.
		for (const request of requests) {
			const url = new URL(request);
			expect([originA, originB]).toContain(url.origin);
			expect(["/", "/client.js", "/identity.js", "/favicon.ico"]).toContain(url.pathname);
			expect(url.search).toBe("");
			expect(request).not.toContain(token);
			expect(request).not.toContain(originalCapability);
		}
	});
});
