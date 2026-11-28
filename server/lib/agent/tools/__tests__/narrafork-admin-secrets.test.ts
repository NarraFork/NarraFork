import { afterEach, describe, expect, test } from "bun:test";
import { saveSettings, settings } from "../../../settings";
import {
	MASK,
	maskSettingsSecrets,
	narraforkAdminTool,
	restoreMaskedSecrets,
} from "../narrafork-admin";

const ctx = {
	narratorId: "admin-agent",
	cwd: "/tmp",
	signal: new AbortController().signal,
	requestPermission: async () => ({ behavior: "allow" as const }),
} as unknown as Parameters<typeof narraforkAdminTool.execute>[1];

const run = (args: Record<string, unknown>) => narraforkAdminTool.execute(args, ctx);

const SECRETS = [
	"sk-custom-secret",
	"site-token-secret",
	"oauth-client-secret",
	"td-secret",
	"cc-secret",
	"Bearer header-secret",
	"proxy-password",
	"tavily-secret",
];

let saved: typeof settings;
afterEach(() => saveSettings(saved));

function seed() {
	saved = structuredClone(settings);
	saveSettings({
		...settings,
		customApiProviders: [
			{
				id: "relay",
				name: "Relay",
				prefix: "relay",
				apiKey: "sk-custom-secret",
				quotaAccessToken: "site-token-secret",
				baseUrl: "https://relay.example/v1",
				defaultModel: "m",
				protocol: "completions-compatible",
				extraHeaders: { Authorization: "Bearer header-secret", "X-Trace": "visible" },
				proxy: { mode: "custom", url: "http://user:proxy-password@proxy.example:8080" },
			},
		],
		nugProviders: [
			{
				id: "nug",
				name: "NUG",
				prefix: "nug",
				apiKey: "nug-key",
				baseUrl: "https://nug.example",
				defaultModel: "",
				oauthClientSecret: "oauth-client-secret",
			},
		],
		tokendance: { ...settings.tokendance, apiKey: "td-secret" } as typeof settings.tokendance,
		commandCode: { ...settings.commandCode, apiKey: "cc-secret" },
		search: {
			channels: [],
			...settings.search,
			customProviders: [
				{
					id: "tavily",
					name: "Tavily",
					protocol: "tavily-mcp",
					baseUrl: "https://mcp.tavily.com/mcp/?tavilyApiKey=tavily-secret",
				},
			],
		},
	} as typeof settings);
}

describe("NarraForkAdmin secret masking", () => {
	test("get_settings returns no credential of any provider kind", async () => {
		seed();
		const result = await run({ action: "get_settings" });
		expect(result.isError).toBeFalsy();
		for (const secret of SECRETS) expect(result.output).not.toContain(secret);
		expect(result.output).toContain("X-Trace");
		expect(result.output).toContain("visible");
		expect(result.output).toContain("proxy.example");
	});

	test("get_setting masks a credential nested under the requested path", async () => {
		seed();
		const result = await run({ action: "get_setting", path: "customApiProviders" });
		for (const secret of SECRETS) expect(result.output).not.toContain(secret);
		expect(result.output).toContain("relay.example");
	});

	test("writing masked values back keeps the stored secrets", async () => {
		seed();
		const output = JSON.parse(
			(await run({ action: "get_setting", path: "customApiProviders" })).output,
		) as { value?: unknown } | unknown[];
		// Documented settings come back as { value, default, desc }.
		const read = (Array.isArray(output) ? output : output.value) as Array<Record<string, unknown>>;
		const [relay] = read;
		if (!relay) throw new Error("expected the relay provider");
		relay.name = "Renamed";
		const write = await run({ action: "update_settings", value: { customApiProviders: read } });
		expect(write.isError).toBeFalsy();
		const stored = settings.customApiProviders?.[0];
		expect(stored?.name).toBe("Renamed");
		expect(stored?.apiKey).toBe("sk-custom-secret");
		expect(stored?.quotaAccessToken).toBe("site-token-secret");
		expect(stored?.extraHeaders?.Authorization).toBe("Bearer header-secret");
		expect(stored?.proxy?.url).toBe("http://user:proxy-password@proxy.example:8080");
	});

	test("a masked value with nothing to restore is rejected without writing", async () => {
		seed();
		const before = structuredClone(settings.customApiProviders);
		const write = await run({
			action: "update_settings",
			value: { customApiProviders: [{ id: "new", name: "New", prefix: "new", apiKey: MASK }] },
		});
		expect(write.isError).toBe(true);
		expect(settings.customApiProviders).toEqual(before);
	});
});

describe("mask helpers", () => {
	test("numbers and ordinary strings pass through; only credential keys are masked", () => {
		expect(
			maskSettingsSecrets({ maxTokens: 10, defaultModel: "codex:gpt", relayToken: "t", x: "" }),
		).toEqual({ maxTokens: 10, defaultModel: "codex:gpt", relayToken: MASK, x: "" });
		expect(
			maskSettingsSecrets({ env: { OPENAI_API_KEY: "k", GITHUB_TOKEN: "t", LOG_LEVEL: "debug" } }),
		).toEqual({ env: { OPENAI_API_KEY: MASK, GITHUB_TOKEN: MASK, LOG_LEVEL: "debug" } });
	});

	test("array entries are paired by id, so reordering does not swap secrets", () => {
		const current = [
			{ id: "a", apiKey: "key-a" },
			{ id: "b", apiKey: "key-b" },
		];
		const patch = [
			{ id: "b", apiKey: MASK },
			{ id: "a", apiKey: MASK },
		];
		expect(restoreMaskedSecrets(patch, current)).toEqual([
			{ id: "b", apiKey: "key-b" },
			{ id: "a", apiKey: "key-a" },
		]);
	});
});
