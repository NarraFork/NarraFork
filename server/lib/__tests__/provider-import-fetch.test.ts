import { describe, expect, test } from "bun:test";
import { fetchRemoteImportConfig } from "../provider-import-fetch";

const CONFIG = {
	v: 1,
	providers: [
		{
			name: "Geek2API Claude",
			protocol: "anthropic-messages",
			baseUrl: "https://api.geek2api.com",
			apiKey: "sk-should-not-be-here",
		},
	],
};

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

type Route = (url: string) => Response | Error;

function fakeFetch(route: Route) {
	const calls: string[] = [];
	const fetchImpl = async (input: string, _init: RequestInit) => {
		calls.push(input);
		const outcome = route(input);
		if (outcome instanceof Error) throw outcome;
		return outcome;
	};
	return { calls, fetchImpl };
}

const json = (value: unknown) =>
	new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

describe("fetchRemoteImportConfig", () => {
	test("falls back from the apex to www and drops keys from the public file", async () => {
		const { calls, fetchImpl } = fakeFetch((url) =>
			url.startsWith("https://geek2api.com/")
				? new Response("nope", { status: 404 })
				: json(CONFIG),
		);
		const result = await fetchRemoteImportConfig("geek2api.com", {
			exact: false,
			fetchImpl,
			lookupImpl: publicLookup,
		});
		expect(calls).toEqual([
			"https://geek2api.com/.well-known/narrafork-provider.json",
			"https://www.geek2api.com/.well-known/narrafork-provider.json",
		]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.host).toBe("www.geek2api.com");
		expect(result.droppedApiKey).toBe(true);
		expect(result.payload.providers[0]?.apiKey).toBeUndefined();
		expect(result.attempts.map((a) => a.outcome)).toEqual(["not-found", "ok"]);
	});

	test("treats an HTML page as no config and keeps looking", async () => {
		const { fetchImpl } = fakeFetch((url) =>
			url.startsWith("https://geek2api.com/")
				? new Response("<!doctype html>", { headers: { "content-type": "text/html" } })
				: json(CONFIG),
		);
		const result = await fetchRemoteImportConfig("geek2api", {
			exact: false,
			fetchImpl,
			lookupImpl: publicLookup,
		});
		expect(result.ok && result.attempts[0]?.outcome).toBe("html");
	});

	test("stops at a config that exists but is invalid", async () => {
		const { calls, fetchImpl } = fakeFetch(() => json({ v: 1, providers: [] }));
		const result = await fetchRemoteImportConfig("geek2api.com", {
			exact: false,
			fetchImpl,
			lookupImpl: publicLookup,
		});
		expect(result).toMatchObject({ ok: false, error: "invalid" });
		expect(calls).toHaveLength(1);
	});

	test("follows same-site redirects only", async () => {
		const same = fakeFetch((url) =>
			url.startsWith("https://geek2api.com/")
				? new Response(null, {
						status: 301,
						headers: { location: "https://www.geek2api.com/.well-known/narrafork-provider.json" },
					})
				: json(CONFIG),
		);
		const ok = await fetchRemoteImportConfig("geek2api.com", {
			exact: true,
			fetchImpl: same.fetchImpl,
			lookupImpl: publicLookup,
		});
		expect(ok.ok && ok.sourceUrl).toBe(
			"https://www.geek2api.com/.well-known/narrafork-provider.json",
		);

		const cross = fakeFetch(
			() =>
				new Response(null, {
					status: 302,
					headers: { location: "https://evil.example.com/x.json" },
				}),
		);
		const blocked = await fetchRemoteImportConfig("www.geek2api.com", {
			exact: true,
			fetchImpl: cross.fetchImpl,
			lookupImpl: publicLookup,
		});
		expect(blocked).toMatchObject({ ok: false, error: "not-found" });
		expect(blocked.attempts[0]).toMatchObject({
			outcome: "redirect-blocked",
			detail: "evil.example.com",
		});
		expect(cross.calls).toHaveLength(1);
	});

	test("a malformed Location is a failed attempt, not a crash", async () => {
		const { calls, fetchImpl } = fakeFetch((url) =>
			url.startsWith("https://geek2api.com/")
				? new Response(null, { status: 302, headers: { location: "http://[bad" } })
				: json(CONFIG),
		);
		const result = await fetchRemoteImportConfig("geek2api.com", {
			exact: false,
			fetchImpl,
			lookupImpl: publicLookup,
		});
		expect(result.ok).toBe(true);
		expect(result.attempts[0]).toMatchObject({
			outcome: "redirect-blocked",
			detail: "invalid Location",
		});
		expect(calls).toHaveLength(2);
	});

	test("refuses hosts that resolve to private addresses", async () => {
		const { calls, fetchImpl } = fakeFetch(() => json(CONFIG));
		const result = await fetchRemoteImportConfig("internal.example.com", {
			exact: true,
			fetchImpl,
			lookupImpl: async () => [{ address: "10.0.0.5", family: 4 }],
		});
		expect(result.attempts[0]?.outcome).toBe("blocked");
		expect(calls).toHaveLength(0);
	});

	test("oversized bodies stop the search", async () => {
		const { fetchImpl } = fakeFetch(
			() =>
				new Response("x".repeat(70 * 1024), { headers: { "content-type": "application/json" } }),
		);
		const result = await fetchRemoteImportConfig("www.geek2api.com", {
			exact: true,
			fetchImpl,
			lookupImpl: publicLookup,
		});
		expect(result).toMatchObject({ ok: false, error: "invalid" });
		expect(result.attempts[0]?.outcome).toBe("too-large");
	});

	test("reports every attempt when nothing is reachable", async () => {
		const { fetchImpl } = fakeFetch(() => new Error("ENOTFOUND"));
		const result = await fetchRemoteImportConfig("geek2api", {
			exact: false,
			fetchImpl,
			lookupImpl: publicLookup,
		});
		expect(result).toMatchObject({ ok: false, error: "not-found" });
		expect(result.attempts.map((a) => a.outcome)).toEqual(["network", "network"]);
	});

	test("invalid input never fetches", async () => {
		const { calls, fetchImpl } = fakeFetch(() => json(CONFIG));
		const result = await fetchRemoteImportConfig("127.0.0.1", { exact: false, fetchImpl });
		expect(result).toEqual({ ok: false, error: "bad-domain", attempts: [] });
		expect(calls).toHaveLength(0);
	});
});
