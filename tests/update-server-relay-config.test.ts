import { describe, expect, test } from "bun:test";
import { resolveMirrorRelaySettings } from "../update-server/lib/mirror-relay-config";
import type { MirrorRelayConfig } from "../update-server/types";

const key = Buffer.alloc(32, 7).toString("base64");
const env = { DAV_USER: "relay-reader", DAV_PASSWORD: "private-pass", RELAY_KEY: key };
const relay = {
	enabled: true,
	url: "https://webdav.fixture.invalid/private/",
	feed: "production",
	usernameEnv: "DAV_USER",
	passwordEnv: "DAV_PASSWORD",
	signingKeyEnv: "RELAY_KEY",
} satisfies MirrorRelayConfig;
const config = { mirrorRepositories: { narrafork: "Fixture/Fork" }, mirrorRelay: relay };

describe("optional update server WebDAV configuration", () => {
	test("default and explicitly disabled modes never read credentials", () => {
		const forbidden = new Proxy(
			{},
			{
				get: () => {
					throw new Error("Credential access forbidden");
				},
			},
		);
		expect(resolveMirrorRelaySettings({}, forbidden)).toBeUndefined();
		expect(
			resolveMirrorRelaySettings({ mirrorRelay: { enabled: false } }, forbidden),
		).toBeUndefined();
	});

	test("operator establishes repository, credentials come only from referenced environment", () => {
		const settings = resolveMirrorRelaySettings(config, env);
		expect(settings?.products).toEqual([{ product: "narrafork", repository: "fixture/fork" }]);
		expect(settings?.webdav).toEqual({
			url: relay.url,
			feed: "production",
			auth: {
				username: "relay-reader",
				password: "private-pass",
			},
		});
		expect(settings?.signingKey).toBe(key);
		expect(settings?.pollIntervalMs).toBe(60_000);
		expect(Object.isFrozen(settings)).toBe(true);
		const printed = JSON.stringify(settings);
		for (const secret of [env.DAV_USER, env.DAV_PASSWORD, key, relay.url])
			expect(printed).not.toContain(secret as string);
		expect(JSON.stringify(config)).not.toContain(env.DAV_PASSWORD);
	});

	test("download concurrency defaults to 8 and accepts only numeric integers from 1 to 8", () => {
		expect(resolveMirrorRelaySettings(config, env)?.downloadConcurrency).toBe(8);
		for (const value of [1, 3, 8])
			expect(
				resolveMirrorRelaySettings(
					{ ...config, mirrorRelay: { ...relay, downloadConcurrency: value } },
					env,
				)?.downloadConcurrency,
			).toBe(value);
		for (const value of [0, 9, -1, 1.5, NaN, Infinity, null, "", "3", true]) {
			const mirrorRelay = { ...relay, downloadConcurrency: value } as unknown as MirrorRelayConfig;
			expect(() => resolveMirrorRelaySettings({ ...config, mirrorRelay }, env)).toThrow();
			expect(
				resolveMirrorRelaySettings({ mirrorRelay: { ...mirrorRelay, enabled: false } }, {}),
			).toBeUndefined();
		}
	});

	test("download redirects stay disabled unless the operator explicitly configures CDN hosts", () => {
		expect(resolveMirrorRelaySettings(config, env)?.webdav.downloadRedirectHosts).toBeUndefined();
		const settings = resolveMirrorRelaySettings(
			{
				...config,
				mirrorRelay: { ...relay, downloadRedirectHosts: ["*.PD1.CJJD19.COM"] },
			},
			env,
		);
		expect(settings?.webdav.downloadRedirectHosts).toEqual(["*.pd1.cjjd19.com"]);
		for (const host of [
			"*.com",
			"*.co.uk",
			"*.s3.amazonaws.com",
			"127.0.0.1",
			"https://cdn.example.com/",
		])
			expect(() =>
				resolveMirrorRelaySettings(
					{
						...config,
						mirrorRelay: { ...relay, downloadRedirectHosts: [host] },
					},
					env,
				),
			).toThrow();
	});

	test("supports separate read-only Bearer credentials and a bounded custom interval", () => {
		const settings = resolveMirrorRelaySettings(
			{
				...config,
				mirrorRelay: {
					enabled: true,
					url: relay.url,
					bearerTokenEnv: "DAV_TOKEN",
					signingKeyEnv: "RELAY_KEY",
					pollIntervalSeconds: 120,
				},
			},
			{ DAV_TOKEN: "only-reader-token", RELAY_KEY: key },
		);
		expect(settings?.webdav.feed).toBe("default");
		expect(settings?.webdav.auth).toEqual({ bearerToken: "only-reader-token" });
		expect(settings?.pollIntervalMs).toBe(120_000);
	});

	test("server timeout JSON fields reject strings rather than treating them like runner environment values", () => {
		for (const value of ["", "30", null, true])
			for (const field of ["totalTimeoutMinutes", "transferTimeoutMinutes"])
				expect(() =>
					resolveMirrorRelaySettings(
						{
							...config,
							mirrorRelay: { ...relay, [field]: value } as unknown as MirrorRelayConfig,
						},
						env,
					),
				).toThrow();
	});
	test("explicit job and stream budgets share bounded producer limits", () => {
		const selected = resolveMirrorRelaySettings(
			{
				...config,
				mirrorRelay: { ...relay, totalTimeoutMinutes: 300, transferTimeoutMinutes: 100 },
			},
			env,
		);
		expect(selected?.totalTimeoutMs).toBe(300 * 60_000);
		expect(selected?.webdav.transferTimeoutMs).toBe(100 * 60_000);
		for (const patch of [
			{ totalTimeoutMinutes: 301 },
			{ totalTimeoutMinutes: -1 },
			{ totalTimeoutMinutes: Number.NaN },
			{ totalTimeoutMinutes: 1.5 },
			{ transferTimeoutMinutes: 101 },
			{ transferTimeoutMinutes: 0 },
		])
			expect(() =>
				resolveMirrorRelaySettings({ ...config, mirrorRelay: { ...relay, ...patch } }, env),
			).toThrow();
	});
	for (const [label, patch] of [
		["invalid URL", { url: "http://webdav.fixture.invalid/private" }],
		["inline credentials", { url: "https://user:pass@webdav.fixture.invalid/" }],
		["query credentials", { url: "https://webdav.fixture.invalid/?token=private" }],
		["path escape feed", { feed: "../outside" }],
		["ambiguous authentication", { bearerTokenEnv: "DAV_TOKEN" }],
		["missing username", { usernameEnv: undefined }],
		["missing key", { signingKeyEnv: undefined }],
		["invalid key reference", { signingKeyEnv: "key\nprivate" }],
		["too frequent poll", { pollIntervalSeconds: 1 }],
		["noninteger poll", { pollIntervalSeconds: 10.5 }],
		["unbounded poll", { pollIntervalSeconds: 3601 }],
		["unknown option", { callbackUrl: "https://untrusted.invalid" }],
	] as const) {
		test(`fails closed without fallback for ${label}`, () => {
			expect(() =>
				resolveMirrorRelaySettings(
					{
						...config,
						mirrorRelay: { ...relay, ...patch },
					},
					{ ...env, DAV_TOKEN: "bearer" },
				),
			).toThrow();
		});
	}

	test("never derives product authority from relay config or permits unbounded products", () => {
		expect(() => resolveMirrorRelaySettings({ mirrorRelay: relay }, env)).toThrow();
		expect(() =>
			resolveMirrorRelaySettings(
				{ ...config, mirrorRepositories: { "../../outside": "fixture/fork" } },
				env,
			),
		).toThrow();
		expect(() =>
			resolveMirrorRelaySettings(
				{ ...config, mirrorRepositories: { narrafork: "not-a-repository" } },
				env,
			),
		).toThrow();
		expect(() =>
			resolveMirrorRelaySettings(
				{
					...config,
					mirrorRepositories: Object.fromEntries(
						Array.from({ length: 17 }, (_, i) => [`p${i}`, "fixture/fork"]),
					),
				},
				env,
			),
		).toThrow();
	});

	for (const invalid of ["", "a".repeat(44), Buffer.alloc(31).toString("base64"), `${key}\n`]) {
		test("rejects a missing or noncanonical signing key without printing its value", () => {
			try {
				resolveMirrorRelaySettings(config, { ...env, RELAY_KEY: invalid });
				throw new Error("Expected rejection");
			} catch (error) {
				expect(String(error)).not.toContain("Expected rejection");
				if (invalid) expect(String(error)).not.toContain(invalid);
			}
		});
	}
});
