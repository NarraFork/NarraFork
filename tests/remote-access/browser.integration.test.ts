import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import type { PrototypeClient } from "../../remote-prototype/client";
import { startPrototype } from "../../scripts/webrtc-prototype";

interface PageState {
	rtc: PrototypeClient;
	signalMessages: string[];
	jwt: string;
	grantId: string;
	temporaryPeer?: PrototypeClient;
}

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
	if (!executable)
		throw new Error("CHROMIUM_REQUIRED: this acceptance test must not silently skip");
	return executable;
}

describe("M1 real Chromium / Pion / isolated Bun bridge", () => {
	let runtime: Awaited<ReturnType<typeof startPrototype>>;
	let browser: Browser;
	let page: Page;
	const network: string[] = [];
	beforeAll(async () => {
		runtime = await startPrototype({ leaseSeconds: 2 });
		browser = await puppeteer.launch({
			executablePath: browserExecutable(),
			headless: true,
			args: ["--no-sandbox", "--disable-dev-shm-usage"],
		});
		page = await browser.newPage();
		page.on("request", (request) => {
			network.push(request.url());
		});
		await page.goto(runtime.origin, { waitUntil: "networkidle0" });
		await page.evaluate(async (invitation) => {
			const path = "/client.js";
			const module = (await import(path)) as typeof import("../../remote-prototype/client");
			const state = window as unknown as PageState;
			state.signalMessages = [];
			state.rtc = await module.PrototypeClient.connect(invitation, {
				allowLocalhost: true,
				mode: "prototype",
				expectedInstanceId: invitation.instanceId,
				persistGrant: true,
				onGrant: (grant) => {
					state.grantId = grant.grantId;
				},
				signalFactory(url) {
					const socket = new WebSocket(url);
					const send = socket.send.bind(socket);
					socket.send = (data) => {
						state.signalMessages.push(String(data));
						send(data);
					};
					return socket;
				},
			});
			const login = await state.rtc.request("/api/auth/login", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ username: "admin", password: "prototype-admin" }),
			});
			const body = (await login.json()) as { token: string };
			state.jwt = body.token;
			await state.rtc.authenticate(body.token);
		}, runtime.invitation);
	}, 90000);
	afterAll(async () => {
		await browser?.close();
		await runtime?.stop();
	});

	test("identity, direct candidates, JSON, response headers and HEAD", async () => {
		const result = await page.evaluate(async () => {
			const state = window as unknown as PageState;
			const response = await state.rtc.request("/api/projects");
			const projects = await response.json();
			const echo = await state.rtc.request("/api/echo");
			const header = echo.headers.get("X-Fixture-Response");
			const renewalPreserved = echo.headers.get("X-NarraFork-Session-Token") === state.jwt;
			await echo.text();
			const head = await state.rtc.request("/api/echo", { method: "HEAD" });
			const stats = await state.rtc.candidateStats();
			return {
				projects,
				header,
				renewalPreserved,
				headStatus: head.status,
				headNull: head.body === null,
				stats,
				ready: state.rtc.state,
			};
		});
		expect(result.ready).toBe("ready");
		expect(result.projects).toEqual([{ id: "demo", name: "Isolated prototype" }]);
		expect(result.header).toBe("preserved");
		expect(result.renewalPreserved).toBe(true);
		expect(result.headStatus).toBe(204);
		expect(result.headNull).toBe(true);
		expect(["host", "srflx", "prflx"]).toContain(result.stats.localType);
		expect(["host", "srflx", "prflx"]).toContain(result.stats.remoteType);
	}, 20000);

	test("SSE returns at headers and preserves Chinese byte fragments", async () => {
		const result = await page.evaluate(async () => {
			const client = (window as unknown as PageState).rtc;
			const start = performance.now();
			const response = await client.request("/api/events");
			const headAt = performance.now() - start;
			const text = await response.text();
			return {
				headAt,
				endAt: performance.now() - start,
				text,
				type: response.headers.get("content-type"),
			};
		});
		expect(result.type).toBe("text/event-stream");
		expect(result.text).toContain("中文分片");
		expect(result.text).toContain("event: complete");
		expect(result.endAt).toBeGreaterThan(result.headAt + 20);
	}, 20000);

	test("multi-window binary upload/download and multipart have no A business payload", async () => {
		const before = runtime.coordinator.stats();
		const result = await page.evaluate(async () => {
			const client = (window as unknown as PageState).rtc;
			const bytes = new Uint8Array(512 * 1024).fill(0x61);
			const upload = await client.request("/api/upload", { method: "POST", body: bytes });
			const uploaded = (await upload.json()) as { bytes: number; sha256: string };
			const response = await client.request("/api/download?size=524288");
			const downloaded = new Uint8Array(await response.arrayBuffer());
			const digest = Array.from(
				new Uint8Array(await crypto.subtle.digest("SHA-256", downloaded)),
				(byte) => byte.toString(16).padStart(2, "0"),
			).join("");
			const form = new FormData();
			form.append("file", new Blob([new Uint8Array(8192)]), "fixture.bin");
			const multipart = (await (
				await client.request("/api/upload", { method: "POST", body: form })
			).json()) as { bytes: number; contentType: string };
			return {
				uploaded,
				digest,
				downloadBytes: downloaded.length,
				multipart,
				queued: client.queueBytes,
			};
		});
		expect(result.uploaded.bytes).toBe(524288);
		expect(result.downloadBytes).toBe(524288);
		expect(result.uploaded.sha256).toBe(result.digest);
		expect(result.multipart.bytes).toBeGreaterThan(8192);
		expect(result.multipart.contentType).toContain("multipart/form-data; boundary=");
		expect(result.queued.incoming).toBe(0);
		const after = runtime.coordinator.stats();
		expect(after.signalBytesIn - before.signalBytesIn).toBeLessThan(4096);
		expect(after.signalBytesOut - before.signalBytesOut).toBeLessThan(4096);
	}, 30000);

	test("real logical WebSocket upgrade and existing subscribe message semantics", async () => {
		const received = await page.evaluate(async () => {
			const state = window as unknown as PageState;
			return await new Promise<string[]>((resolve, reject) => {
				const socket = state.rtc.openSocket("/ws/narrator", state.jwt);
				const messages: string[] = [];
				const timer = setTimeout(() => {
					socket.close();
					reject(new Error("socket_timeout"));
				}, 10000);
				socket.onopen = () =>
					socket.send(JSON.stringify({ type: "subscribe", narratorIds: ["demo"] }));
				socket.onmessage = (event) => {
					messages.push(String(event.data));
					if (messages.length === 2) {
						clearTimeout(timer);
						socket.close();
						resolve(messages);
					}
				};
				socket.onerror = () => {
					clearTimeout(timer);
					reject(new Error("socket_failed"));
				};
			});
		});
		expect(JSON.parse(received[0] ?? "{}").type).toBe("subscribed");
		expect(JSON.parse(received[1] ?? "{}").text).toBe("实时中文");
	}, 15000);

	test("redirect stays manual; reader.cancel releases body; private data never enters signaling", async () => {
		const result = await page.evaluate(async () => {
			const state = window as unknown as PageState;
			const redirect = await state.rtc.request("/api/redirect");
			await redirect.body?.cancel();
			const abort = new AbortController();
			const stream = await state.rtc.request("/api/download?size=8388608", {
				signal: abort.signal,
			});
			const reader = stream.body?.getReader();
			if (!reader) throw new Error("missing_body");
			await reader.read();
			await reader.cancel();
			return {
				redirectStatus: redirect.status,
				location: redirect.headers.get("location"),
				messages: state.signalMessages,
				jwt: state.jwt,
			};
		});
		await runtime.fixture.waitForIdle();
		expect(runtime.fixture.stats().activeStreams).toBe(0);
		expect(result.redirectStatus).toBe(302);
		expect(result.location).toBe("http://192.0.2.1/private");
		const controlPlane = result.messages.join("\n");
		expect(controlPlane).not.toContain(result.jwt);
		expect(controlPlane).not.toContain(runtime.invitation.pairingSecret);
		expect(controlPlane).not.toContain("prototype-admin");
		expect(network.filter((url) => /\/api\/|\/ws\/narrator/.test(url))).toEqual([]);
	}, 20000);

	test("slow bulk consumer stays within credit while realtime traffic remains usable", async () => {
		const result = await page.evaluate(async () => {
			const state = window as unknown as PageState;
			const response = await state.rtc.request("/api/download?size=8388608");
			const message = await new Promise<string>((resolve, reject) => {
				const socket = state.rtc.openSocket("/ws/narrator", state.jwt);
				const timer = setTimeout(() => {
					socket.close();
					reject(new Error("interactive_starved"));
				}, 2000);
				socket.onopen = () => socket.send(JSON.stringify({ type: "ping" }));
				socket.onmessage = (event) => {
					clearTimeout(timer);
					socket.close();
					resolve(String(event.data));
				};
				socket.onerror = () => {
					clearTimeout(timer);
					reject(new Error("socket_failed"));
				};
			});
			const queued = state.rtc.queueBytes.incoming;
			await response.body?.cancel();
			return { message, queued };
		});
		expect(JSON.parse(result.message).type).toBe("pong");
		expect(result.queued).toBeLessThanOrEqual(65536);
		await runtime.fixture.waitForIdle();
	}, 15000);

	test("paired browser reconnects with its key but ordinary B users cannot become administrators", async () => {
		const denied = await page.evaluate(async (original) => {
			const path = "/client.js";
			const module = (await import(path)) as typeof import("../../remote-prototype/client");
			const grant = await module.loadGrant(original.instanceId);
			if (!grant) throw new Error("grant_not_persisted");
			const peer = await module.PrototypeClient.connect(
				{ ...original, discoveryCapability: grant.discoveryCapability },
				{
					grant,
					allowLocalhost: true,
					mode: "prototype",
					expectedInstanceId: original.instanceId,
					persistGrant: false,
				},
			);
			try {
				const result = (await (
					await peer.request("/api/auth/login", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ username: "user", password: "user-password" }),
					})
				).json()) as { token: string };
				try {
					await peer.authenticate(result.token);
					return false;
				} catch {
					return true;
				}
			} finally {
				peer.close();
			}
		}, runtime.invitation);
		expect(denied).toBe(true);
		expect(await page.evaluate(() => (window as unknown as PageState).rtc.state)).toBe("ready");
	}, 30000);

	test("B private session invalidation closes only matching peers without revoking the browser grant", async () => {
		const token = await page.evaluate(async (original) => {
			const path = "/client.js";
			const module = (await import(path)) as typeof import("../../remote-prototype/client");
			const grant = await module.loadGrant(original.instanceId);
			if (!grant) throw new Error("grant_not_persisted");
			const state = window as unknown as PageState;
			const peer = await module.PrototypeClient.connect(
				{ ...original, discoveryCapability: grant.discoveryCapability },
				{
					grant,
					allowLocalhost: true,
					mode: "prototype",
					expectedInstanceId: original.instanceId,
					persistGrant: false,
				},
			);
			const result = (await (
				await peer.request("/api/auth/login", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ username: "admin", password: "prototype-admin" }),
				})
			).json()) as { token: string };
			await peer.authenticate(result.token);
			state.temporaryPeer = peer;
			return result.token;
		}, runtime.invitation);
		runtime.fixture.revoke(token);
		await page.waitForFunction(
			() => (window as unknown as PageState).temporaryPeer?.state === "closed",
			{ timeout: 2000 },
		);
		const stillReady = await page.evaluate(async () => {
			const client = (window as unknown as PageState).rtc;
			await (await client.request("/api/projects")).json();
			return client.state;
		});
		expect(stillReady).toBe("ready");
	}, 30000);

	test("A signaling outage and lease expiry preserve existing authorization; B revocation closes it", async () => {
		runtime.coordinator.expireLeases();
		expect(runtime.coordinator.stats().instances).toBe(0);
		const beforeOutage = await page.evaluate(
			async () =>
				await (await (window as unknown as PageState).rtc.request("/api/projects")).json(),
		);
		expect(beforeOutage).toEqual([{ id: "demo", name: "Isolated prototype" }]);
		await runtime.coordinator.stop();
		const result = await page.evaluate(async () => {
			const client = (window as unknown as PageState).rtc;
			const response = await client.request("/api/events?repeat=16");
			const reader = response.body?.getReader();
			if (!reader) throw new Error("missing_body");
			const deadline = performance.now() + 2200;
			let bytes = 0;
			while (performance.now() < deadline) {
				const chunk = await reader.read();
				if (chunk.done) throw new Error("flow_ended_before_lease_expiry");
				bytes += chunk.value.length;
			}
			await reader.cancel();
			const projects = await (await client.request("/api/projects")).json();
			return { bytes, projects, state: client.state };
		});
		expect(result.bytes).toBeGreaterThan(0);
		expect(result.state).toBe("ready");
		expect(result.projects).toEqual([{ id: "demo", name: "Isolated prototype" }]);
		runtime.revoke();
		await page.waitForFunction(() => (window as unknown as PageState).rtc.state === "closed", {
			timeout: 5000,
		});
		const rejected = await page.evaluate(async () => {
			try {
				await (window as unknown as PageState).rtc.request("/api/projects");
				return false;
			} catch {
				return true;
			}
		});
		expect(rejected).toBe(true);
	}, 20000);
});
