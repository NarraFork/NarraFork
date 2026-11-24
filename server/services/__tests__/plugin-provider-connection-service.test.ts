import { afterEach, describe, expect, mock, test } from "bun:test";
import type { outboundFetch } from "@server/lib/net/outbound-fetch";
import { ProviderQuotaError } from "@server/lib/provider-quota-async";
import type { CustomApiProviderConfig } from "@server/lib/settings";
import { type ProviderConnectionRequest, providerQuotaSourceSchema } from "@shared/provider-quota";
import {
	PluginProviderConnectionService,
	type QuotaConnectionPrincipal,
	quotaConnectionHeaders,
} from "../plugin-provider-connection-service";
import { CustomApiQuotaTargetDirectory } from "../provider-quota-targets";
import { deferred, quotaProvider, quotaSource, required, settle } from "./provider-quota-fixtures";

const owned: PluginProviderConnectionService[] = [];
afterEach(() => {
	for (const service of owned.splice(0)) service.dispose();
});
const principal: QuotaConnectionPrincipal = {
	pluginId: "third.party.quota",
	installationId: "installation-a",
	runtimeId: "runtime-a",
	runtimeGeneration: 1,
};

function fixture(
	options: {
		fetch?: typeof outboundFetch;
		timeoutMs?: number;
		config?: Partial<CustomApiProviderConfig>;
		maxBytes?: number;
	} = {},
) {
	let providers = [quotaProvider(options.config)];
	let now = Date.now();
	let current: () => boolean | Promise<boolean> = () => true;
	const directory = new CustomApiQuotaTargetDirectory({
		providers: () => providers,
		globalProxy: () => ({}),
		userAgent: () => "fixture",
	});
	const fetcher =
		options.fetch ??
		mock(
			async () =>
				new Response('{"remaining":10}', { headers: { "content-type": "application/json" } }),
		);
	const service = new PluginProviderConnectionService({
		directory,
		fetch: fetcher as typeof outboundFetch,
		now: () => now,
		requestTimeoutMs: options.timeoutMs,
	});
	owned.push(service);
	const controller = new AbortController();
	const source = providerQuotaSourceSchema.parse({
		...quotaSource().declaration,
		limits: { maxResponseBytes: options.maxBytes ?? 256 * 1024 },
	});
	const issue = () =>
		service.issue({
			principal,
			target: required(directory.list()[0]).target,
			source,
			deadlineAt: now + 30_000,
			signal: controller.signal,
			isCurrent: () => current(),
		});
	const lease = issue();
	const request = (
		extra: Partial<ProviderConnectionRequest> = {},
		caller = principal,
		signal?: AbortSignal,
	) =>
		service.request(
			{ reference: lease.reference, method: "GET", path: "/v1/usage", ...extra },
			caller,
			signal,
		);
	return {
		service,
		directory,
		fetcher,
		controller,
		source,
		lease,
		issue,
		request,
		providers,
		setProviders: (value: CustomApiProviderConfig[]) => {
			providers = value;
		},
		setCurrent: (value: typeof current) => {
			current = value;
		},
		advance: (ms: number) => {
			now += ms;
		},
	};
}

describe("backend-only provider connection references", () => {
	test("only host-resolved Custom API GET receives configured credential/proxy/TLS/headers", async () => {
		const calls: Array<{ url: string; init: RequestInit | undefined; policy: unknown }> = [];
		const fetcher: typeof outboundFetch = async (url, init, policy) => {
			calls.push({ url: String(url), init, policy });
			return new Response('{"remaining":10}');
		};
		const f = fixture({
			fetch: fetcher,
			config: {
				proxy: { mode: "direct" },
				tlsRejectUnauthorized: false,
				extraHeaders: {
					"x-account": "configured-account",
					Host: "evil.test",
					Connection: "x-hop",
					"x-hop": "discard",
					"Content-Length": "999",
				},
			},
		});
		const response = await f.request();
		expect(response).toMatchObject({ status: 200, body: '{"remaining":10}' });
		expect(calls[0]?.url).toBe("https://relay.test/v1/usage");
		expect(calls[0]?.init).toMatchObject({ method: "GET", redirect: "error" });
		expect(calls[0]?.policy).toMatchObject({ tlsRejectUnauthorized: false, retryPolicy: "never" });
		const headers = new Headers(calls[0]?.init?.headers);
		expect(headers.get("authorization")).toBe("Bearer test-secret-key");
		expect(headers.get("x-account")).toBe("configured-account");
		for (const key of ["host", "connection", "x-hop", "content-length"])
			expect(headers.has(key)).toBe(false);
		expect(JSON.stringify(f.lease)).not.toContain("test-secret-key");
	});

	test("public metadata drops every configured credential header; dual auth and UA are declared", async () => {
		const captured: Headers[] = [];
		const f = fixture({
			config: {
				extraHeaders: {
					Authorization: "custom-token",
					Cookie: "private-cookie",
					"x-api-key": "private-key",
				},
			},
			fetch: async (_url, init) => {
				captured.push(new Headers(init?.headers));
				return new Response("{}");
			},
		});
		await f.request({ path: "/api/status" });
		expect([...required(captured[0]).keys()]).toEqual(["accept"]);
		const config = quotaProvider();
		const dual = quotaConnectionHeaders(config, required(f.source.requests[2]), undefined);
		expect(dual.get("authorization")).toBe("Bearer test-secret-key");
		expect(dual.get("x-api-key")).toBe("test-secret-key");
		const declaredUa = quotaConnectionHeaders(config, required(f.source.requests[0]), {
			"user-agent": "FixtureCLI/1.0",
		});
		expect(declaredUa.get("user-agent")).toBe("FixtureCLI/1.0");
		await expect(
			f.request({ path: "/api/status", headers: { "user-agent": "not-declared" } }),
		).rejects.toMatchObject({ code: "permission_denied" });
	});

	test.each([
		"pluginId",
		"installationId",
		"runtimeId",
		"runtimeGeneration",
	] as const)("a different %s cannot use a reference", async (field) => {
		const f = fixture();
		const caller = {
			...principal,
			[field]: field === "runtimeGeneration" ? 2 : "other",
		} as QuotaConnectionPrincipal;
		await expect(f.request({}, caller)).rejects.toMatchObject({ code: "permission_denied" });
		expect(f.fetcher).not.toHaveBeenCalled();
	});

	test.each([
		"https://evil.test/v1/usage",
		"//evil.test/v1/usage",
		"/other",
		"/v1/usage?key=leak",
		"/v1/usage#fragment",
		"/v1/../secret",
		"/v1/%2e%2e/secret",
		"/%252e%252e/v1/usage",
		"/%2f/evil.test/v1/usage",
		"/\\evil.test/v1/usage",
		"/v1/usage%00",
	])("unsafe or undeclared path is refused before network: %s", async (path) => {
		const f = fixture();
		await expect(f.request({ path })).rejects.toMatchObject({ code: "permission_denied" });
		expect(f.fetcher).not.toHaveBeenCalled();
	});

	test("method, URL, credential headers, undeclared query and provider-id spoofing fail closed", async () => {
		const f = fixture();
		for (const extra of [
			{ method: "POST" },
			{ url: "https://evil.test" },
			{ providerId: "nug-provider" },
			{ target: { kind: "nug" } },
			{ headers: { authorization: "secret" } },
			{ query: { token: "anything" } },
		]) {
			await expect(f.request(extra as Partial<ProviderConnectionRequest>)).rejects.toMatchObject({
				code: "permission_denied",
			});
		}
		expect(f.fetcher).not.toHaveBeenCalled();
	});

	test("a reference cannot address any connection outside the Custom API directory", () => {
		const f = fixture();
		for (const kind of ["nug", "codex", "plugin", "tokendance", "commandcode"]) {
			expect(() =>
				f.service.issue({
					principal,
					target: { ...required(f.directory.list()[0]).target, kind } as never,
					source: f.source,
					deadlineAt: Date.now() + 30_000,
					signal: f.controller.signal,
					isCurrent: () => true,
				}),
			).toThrow("permission_denied");
		}
		expect(() =>
			f.service.issue({
				principal,
				target: {
					...required(f.directory.list()[0]).target,
					id: "custom-api/other",
					providerId: "other",
				},
				source: f.source,
				deadlineAt: Date.now() + 30_000,
				signal: f.controller.signal,
				isCurrent: () => true,
			}),
		).toThrow("permission_denied");
	});

	test.each([
		"key",
		"disable",
		"remove",
		"grant",
		"runtime",
		"expiry",
		"finish",
	])("%s invalidates a live reference", async (change) => {
		const f = fixture();
		switch (change) {
			case "key":
				required(f.providers[0]).apiKey = "new";
				break;
			case "disable":
				required(f.providers[0]).disabled = true;
				break;
			case "remove":
				f.setProviders([]);
				break;
			case "grant":
				f.setCurrent(() => false);
				break;
			case "runtime":
				f.service.revokePlugin(principal.pluginId);
				break;
			case "expiry":
				f.advance(30_001);
				break;
			case "finish":
				f.lease.release();
				break;
		}
		await expect(f.request()).rejects.toBeInstanceOf(Error);
		expect(f.fetcher).not.toHaveBeenCalled();
	});

	test("an authority check that cannot complete keeps its own code and never dispatches", async () => {
		const f = fixture();
		f.setCurrent(async () => {
			throw new ProviderQuotaError("request_failed");
		});
		await expect(f.request()).rejects.toMatchObject({ code: "request_failed" });
		expect(f.fetcher).not.toHaveBeenCalled();
	});

	test("credential rotation while an authority lookup waits prevents dispatch", async () => {
		const gate = deferred<boolean>();
		const f = fixture();
		f.setCurrent(() => gate.promise);
		const request = f.request();
		required(f.providers[0]).apiKey = "new-key";
		f.directory.sync();
		gate.resolve(true);
		await expect(request).rejects.toBeInstanceOf(Error);
		expect(f.fetcher).not.toHaveBeenCalled();
	});

	test("same-origin prefix path remains usable, per-query request and concurrency budgets are bounded", async () => {
		const held = deferred<Response>();
		const f = fixture({ fetch: mock(async () => held.promise) as typeof outboundFetch });
		const first = f.request({ path: "/tenant/v1/usage" });
		await expect(f.request()).rejects.toMatchObject({ code: "permission_denied" });
		held.resolve(new Response("{}"));
		await first;
		const other = fixture();
		for (let i = 0; i < other.source.limits.maxRequests; i++) await other.request();
		await expect(other.request()).rejects.toMatchObject({ code: "permission_denied" });
	});
});

describe("connection response liveness and byte budgets", () => {
	test("declared oversized body is rejected without reading; unknown length is incrementally capped", async () => {
		const declared = fixture({
			maxBytes: 1_024,
			fetch: async () => new Response("small", { headers: { "content-length": "1025" } }),
		});
		await expect(declared.request()).rejects.toMatchObject({ code: "invalid_response" });
		const streamed = fixture({
			maxBytes: 1_024,
			fetch: async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new Uint8Array(600));
							controller.enqueue(new Uint8Array(600));
							controller.close();
						},
					}),
				),
		});
		await expect(streamed.request()).rejects.toMatchObject({ code: "invalid_response" });
	});

	test("exact UTF-8 byte ceiling is accepted and a multibyte overflow is refused", async () => {
		const exact = fixture({ maxBytes: 1_024, fetch: async () => new Response("é".repeat(512)) });
		expect(await exact.request()).toMatchObject({ bytes: 1_024 });
		const excess = fixture({ maxBytes: 1_024, fetch: async () => new Response("é".repeat(513)) });
		await expect(excess.request()).rejects.toMatchObject({ code: "invalid_response" });
	});

	test("abort-ignoring fetch and stalled body both respect request timeout", async () => {
		const f = fixture({ timeoutMs: 5, fetch: () => new Promise(() => {}) });
		await expect(f.request()).rejects.toMatchObject({ code: "timeout" });
		let canceled = false;
		const body = fixture({
			timeoutMs: 5,
			fetch: async () =>
				new Response(
					new ReadableStream({
						pull: () => new Promise(() => {}),
						cancel() {
							canceled = true;
						},
					}),
				),
		});
		await expect(body.request()).rejects.toMatchObject({ code: "timeout" });
		expect(canceled).toBe(true);
	});

	test("cancellation settles immediately and consumes late transport failures without raw text", async () => {
		const held = deferred<Response>();
		const called = mock(async () => held.promise);
		const f = fixture({ fetch: called as typeof outboundFetch });
		const request = f.request();
		await settle(() => called.mock.calls.length === 1);
		f.controller.abort();
		await expect(request).rejects.toBeInstanceOf(Error);
		held.reject(new Error("UPSTREAM-CREDENTIAL-MUST-NOT-ESCAPE"));
		expect(f.service.activeReferences).toBe(0);
	});

	test("rotation/revocation cancels a body in progress and no late response can publish", async () => {
		let entered = false;
		let canceled = false;
		const f = fixture({
			fetch: async () =>
				new Response(
					new ReadableStream({
						pull() {
							entered = true;
							return new Promise(() => {});
						},
						cancel() {
							canceled = true;
						},
					}),
				),
		});
		const request = f.request();
		await settle(() => entered);
		required(f.providers[0]).apiKey = "new-key";
		f.directory.sync();
		await expect(request).rejects.toBeInstanceOf(Error);
		expect(canceled).toBe(true);
		expect(f.service.activeReferences).toBe(0);
	});
});

test("second authority await without a directory notification cannot dispatch an old credential", async () => {
	const f = fixture();
	const gate = deferred<boolean>();
	let checks = 0;
	f.setCurrent(() => {
		checks++;
		return checks === 2 ? gate.promise : true;
	});
	const request = f.request();
	await settle(() => checks === 2);
	required(f.providers[0]).apiKey = "new-key-without-sync";
	gate.resolve(true);
	await expect(request).rejects.toMatchObject({ code: "permission_denied" });
	expect(f.fetcher).not.toHaveBeenCalled();
	expect(f.service.activeReferences).toBe(0);
});
