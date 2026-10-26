import { afterEach, describe, expect, test } from "bun:test";
import { networkInterfaces } from "node:os";
import { requestManagedShutdown } from "../control-client";
import { managerFetch } from "../manager-fetch";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("managerFetch", () => {
	test("本机请求放行自签证书，并保留调用方的方法和请求头", async () => {
		let seen: { url: string; init?: RequestInit } | undefined;
		globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
			seen = { url: String(url), init };
			return new Response(null, { status: 204 });
		}) as unknown as typeof fetch;

		const response = await managerFetch("https://127.0.0.1:7779/api/health", {
			method: "GET",
			headers: { authorization: "Bearer token" },
		});

		expect(response.status).toBe(204);
		expect(seen?.url).toBe("https://127.0.0.1:7779/api/health");
		expect(seen?.init?.method).toBe("GET");
		expect(seen?.init?.headers).toEqual({ authorization: "Bearer token" });
		expect(seen?.init).toMatchObject({ tls: { rejectUnauthorized: false } });
	});
});

describe("manager credential transport", () => {
	test("credentialed requests reject LAN, wildcards and arbitrary DNS before fetch", async () => {
		let calls = 0;
		globalThis.fetch = (async () => {
			calls++;
			return new Response();
		}) as unknown as typeof fetch;
		for (const host of [
			"192.168.1.2",
			"0.0.0.0",
			"[::]",
			"server.example",
			"localhost.example",
			"127.0.0.1.example",
		]) {
			await expect(
				managerFetch(`http://${host}:7779/api/update/check`, {
					headers: new Headers({ Authorization: "Bearer secret" }),
				}),
			).rejects.toThrow("loopback destination");
		}
		await expect(managerFetch("http://user:secret@server.example:7779/")).rejects.toThrow(
			"loopback destination",
		);
		expect(calls).toBe(0);
		await managerFetch("http://192.168.1.2:7779/api/health");
		expect(calls).toBe(1);
	});

	test("credentials accept 127/8, IPv6 loopback, and exact localhost only", async () => {
		globalThis.fetch = (async () => new Response()) as unknown as typeof fetch;
		for (const host of ["127.0.0.1", "127.23.45.67", "[::1]", "localhost"]) {
			expect(
				(
					await managerFetch(`http://${host}:7779`, {
						headers: [["authorization", "Bearer secret"]],
					})
				).ok,
			).toBe(true);
		}
	});

	test("actual redirect never forwards the token, even to another loopback listener", async () => {
		let leaked = 0;
		const destination = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => {
				leaked++;
				return new Response("unexpected redirect");
			},
		});
		const source = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => Response.redirect(destination.url, 302),
		});
		try {
			const response = await managerFetch(source.url.href, {
				headers: { authorization: "Bearer secret" },
				redirect: "follow",
				signal: AbortSignal.timeout(1500),
			});
			expect(response.status).toBe(302);
			expect(leaked).toBe(0);
		} finally {
			void source.stop(true);
			void destination.stop(true);
		}
	});

	test("actual LAN health and authenticated requests bypass environment and caller proxies", async () => {
		let proxied = 0;
		const proxy = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => {
				proxied++;
				return new Response("proxy");
			},
		});
		const host =
			Object.values(networkInterfaces())
				.flat()
				.find((entry) => entry?.family === "IPv4" && !entry.internal)?.address ?? "127.0.0.1";
		const target = Bun.serve({ hostname: host, port: 0, fetch: () => new Response("direct") });
		const local = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("local") });
		const keys = [
			"HTTP_PROXY",
			"HTTPS_PROXY",
			"ALL_PROXY",
			"NO_PROXY",
			"http_proxy",
			"https_proxy",
			"all_proxy",
			"no_proxy",
		];
		const saved = keys.map((key) => [key, process.env[key]] as const);
		try {
			for (const key of keys)
				process.env[key] = key.toLowerCase() === "no_proxy" ? "" : proxy.url.href;
			expect(
				await (
					await managerFetch(target.url.href, {
						proxy: proxy.url.href,
						signal: AbortSignal.timeout(1500),
					})
				).text(),
			).toBe("direct");
			expect(
				await (
					await managerFetch(local.url.href, {
						headers: { authorization: "Bearer secret" },
						signal: AbortSignal.timeout(1500),
					})
				).text(),
			).toBe("local");
			expect(proxied).toBe(0);
		} finally {
			for (const [key, value] of saved) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			void proxy.stop(true);
			void target.stop(true);
			void local.stop(true);
		}
	});
});

describe("requestManagedShutdown", () => {
	test("退出请求打到 signal，并带上自签证书放行", async () => {
		let seen: { url: string; init?: RequestInit } | undefined;
		globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
			seen = { url: String(url), init };
			return new Response(null, { status: 202 });
		}) as unknown as typeof fetch;

		expect(await requestManagedShutdown("https://127.0.0.1:7779", "token")).toBe(true);
		expect(seen?.url).toBe("https://127.0.0.1:7779/api/system/lifecycle/signal");
		expect(seen?.init?.method).toBe("POST");
		expect(seen?.init?.headers).toEqual({ authorization: "Bearer token" });
		expect(seen?.init).toMatchObject({ tls: { rejectUnauthorized: false } });
	});
});
