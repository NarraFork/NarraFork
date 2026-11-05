import { describe, expect, test } from "bun:test";
import {
	applyLinkCredentials,
	buildSelfTestLink,
	crc32,
	decodeImportCode,
	encodeImportCode,
	importInputFromPageLocation,
	type ProviderImportPayload,
	parseImportInput,
	resolveRemoteCandidates,
	selfTestNonceFromPageLocation,
	validateImportPayload,
} from "../provider-import";

const PAYLOAD: ProviderImportPayload = {
	v: 1,
	issuer: { name: "Geek2API", url: "https://www.geek2api.com" },
	providers: [
		{
			id: "claude",
			name: "Geek2API Claude",
			protocol: "anthropic-messages",
			baseUrl: "https://api.geek2api.com",
			baseUrls: ["https://hk.geek2api.com"],
			apiKey: "sk-test+key/123",
		},
	],
};

/** The generator documented for gateway maintainers (docs/PROVIDER_IMPORT.md §7.1). */
function documentedCrc32(text: string): number {
	let crc = -1;
	for (let i = 0; i < text.length; i++) {
		crc ^= text.charCodeAt(i);
		for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
	}
	return (crc ^ -1) >>> 0;
}

describe("import code", () => {
	test("crc32 matches the zlib check value and the documented snippet", () => {
		expect(crc32("123456789")).toBe(0xcbf43926);
		expect(documentedCrc32("123456789")).toBe(0xcbf43926);
		expect(documentedCrc32("NFP1-payload_abc")).toBe(crc32("NFP1-payload_abc"));
	});

	test("round-trips UTF-8 payloads", () => {
		const payload = { ...PAYLOAD, issuer: { name: "极客 API" } };
		const code = encodeImportCode(payload);
		expect(code).toMatch(/^NFP1\.[A-Za-z0-9_-]+\.[0-9a-z]{7}$/);
		const decoded = decodeImportCode(code);
		expect(decoded).toEqual({ ok: true, raw: payload });
	});

	test("tolerates line breaks from chat apps", () => {
		const code = encodeImportCode(PAYLOAD);
		const wrapped = `${code.slice(0, 20)}\n  ${code.slice(20, 40)}\r\n${code.slice(40)}`;
		expect(decodeImportCode(wrapped).ok).toBe(true);
	});

	test("detects truncation and tampering", () => {
		const code = encodeImportCode(PAYLOAD);
		const [prefix, payload, check] = code.split(".");
		expect(decodeImportCode(`${prefix}.${payload.slice(0, -2)}.${check}`)).toEqual({
			ok: false,
			error: "bad-checksum",
		});
		expect(decodeImportCode("NFP1.abc")).toEqual({ ok: false, error: "bad-code" });
	});
});

describe("validateImportPayload", () => {
	test("drops unknown and forbidden fields and reports them", () => {
		const raw = {
			...PAYLOAD,
			extra: 1,
			issuer: { name: "x", logo: "y" },
			providers: [
				{ ...PAYLOAD.providers[0], tlsRejectUnauthorized: false, proxy: { mode: "custom" } },
			],
		};
		const result = validateImportPayload(raw, { allowApiKey: true });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.ignoredFields.sort()).toEqual(
			["extra", "issuer.logo", "providers[0].proxy", "providers[0].tlsRejectUnauthorized"].sort(),
		);
		expect(result.payload.providers[0]).not.toHaveProperty("tlsRejectUnauthorized");
		expect(result.payload.providers[0]).not.toHaveProperty("proxy");
	});

	test("drops apiKey from sources that must not carry one", () => {
		const result = validateImportPayload(PAYLOAD, { allowApiKey: false });
		expect(result.ok && result.droppedApiKey).toBe(true);
		expect(result.ok && result.payload.providers[0]?.apiKey).toBeUndefined();
	});

	test("rejects credentials in URLs, bad protocols and too many providers", () => {
		const withCredentials = {
			...PAYLOAD,
			providers: [{ ...PAYLOAD.providers[0], baseUrl: "https://u:p@api.example.com" }],
		};
		expect(validateImportPayload(withCredentials, { allowApiKey: true }).ok).toBe(false);
		const badProtocol = { ...PAYLOAD, providers: [{ ...PAYLOAD.providers[0], protocol: "nug" }] };
		expect(validateImportPayload(badProtocol, { allowApiKey: true }).ok).toBe(false);
		const many = { ...PAYLOAD, providers: Array.from({ length: 11 }, () => PAYLOAD.providers[0]) };
		expect(validateImportPayload(many, { allowApiKey: true }).ok).toBe(false);
		expect(validateImportPayload({ ...PAYLOAD, v: 2 }, { allowApiKey: true }).ok).toBe(false);
	});
});

describe("parseImportInput", () => {
	const code = encodeImportCode(PAYLOAD);

	test("recognizes codes, full links and JSON", () => {
		expect(parseImportInput(code)).toMatchObject({ kind: "payload", via: "code" });
		expect(parseImportInput(`web+narrafork://import#${code}`)).toMatchObject({
			kind: "payload",
			via: "link",
		});
		expect(parseImportInput(JSON.stringify(PAYLOAD))).toMatchObject({
			kind: "payload",
			via: "json",
		});
	});

	test("short links keep `+` in keys and carry selectors", () => {
		const parsed = parseImportInput(
			"web+narrafork://import?domain=www.geek2api.com#key=sk-a+b%2Fc&provider=claude&label=%E5%B7%A5%E4%BD%9C",
		);
		expect(parsed).toEqual({
			kind: "remote",
			input: "www.geek2api.com",
			exact: true,
			via: "link",
			key: "sk-a+b/c",
			provider: "claude",
			label: "工作",
		});
	});

	test("an NF import-page URL is unwrapped", () => {
		const link = encodeURIComponent(`web+narrafork://import#${code}`);
		expect(
			parseImportInput(`https://nf.local:7779/settings/providers/import#link=${link}`),
		).toMatchObject({ kind: "payload", via: "link" });
	});

	test("other text is a website to fetch", () => {
		expect(parseImportInput("geek2api")).toMatchObject({
			kind: "remote",
			exact: false,
			via: "input",
		});
		expect(parseImportInput("https://www.geek2api.com/pricing")).toMatchObject({ kind: "remote" });
		expect(parseImportInput("")).toEqual({ kind: "error", error: "empty" });
		expect(parseImportInput("web+narrafork://other")).toEqual({ kind: "error", error: "bad-link" });
	});
});

describe("importInputFromPageLocation", () => {
	test("reads the protocol handler fragment and the query fallback", () => {
		const link = encodeURIComponent("web+narrafork://import?domain=api.example.com#key=sk-1");
		expect(importInputFromPageLocation("", `#link=${link}`)).toMatchObject({
			kind: "remote",
			input: "api.example.com",
			key: "sk-1",
		});
		expect(importInputFromPageLocation(`?link=${link}`, "")).toMatchObject({ kind: "remote" });
		expect(importInputFromPageLocation("?domain=api.example.com", "#key=sk-2")).toMatchObject({
			kind: "remote",
			key: "sk-2",
		});
		expect(importInputFromPageLocation("", "")).toBeNull();
	});
});

describe("resolveRemoteCandidates", () => {
	const wk = (host: string) => `https://${host}/.well-known/narrafork-provider.json`;

	test("a full non-apex host is probed alone", () => {
		expect(resolveRemoteCandidates("www.geek2api.com", { exact: false })).toEqual({
			ok: true,
			kind: "host",
			urls: [wk("www.geek2api.com")],
		});
		expect(resolveRemoteCandidates("api.geek2api.com", { exact: false })).toMatchObject({
			urls: [wk("api.geek2api.com")],
		});
	});

	test("a registrable domain falls back to www, including multi-label suffixes", () => {
		expect(resolveRemoteCandidates("Geek2API.com.", { exact: false })).toMatchObject({
			urls: [wk("geek2api.com"), wk("www.geek2api.com")],
		});
		expect(resolveRemoteCandidates("geek2api.com.cn", { exact: false })).toMatchObject({
			urls: [wk("geek2api.com.cn"), wk("www.geek2api.com.cn")],
		});
	});

	test("a shorthand only expands to .com", () => {
		expect(resolveRemoteCandidates("geek2api", { exact: false })).toMatchObject({
			urls: [wk("geek2api.com"), wk("www.geek2api.com")],
		});
		expect(resolveRemoteCandidates("geek2api", { exact: true }).ok).toBe(false);
	});

	test("page URLs lose their path; .json URLs are fetched directly", () => {
		expect(
			resolveRemoteCandidates("https://www.geek2api.com/pricing", { exact: false }),
		).toMatchObject({ urls: [wk("www.geek2api.com")] });
		expect(
			resolveRemoteCandidates("https://cdn.example.com/nf/conf.json", { exact: false }),
		).toEqual({
			ok: true,
			kind: "direct",
			urls: ["https://cdn.example.com/nf/conf.json"],
		});
	});

	test("short links never guess", () => {
		expect(resolveRemoteCandidates("geek2api.com", { exact: true })).toMatchObject({
			urls: [wk("geek2api.com")],
		});
	});

	test("rejects IPs, ports, http, credentials and reserved names", () => {
		for (const input of [
			"127.0.0.1",
			"[::1]",
			"example.com:8443",
			"http://example.com",
			"https://u:p@example.com",
			"localhost",
			"bad_name!",
			"",
		]) {
			expect(resolveRemoteCandidates(input, { exact: false }).ok).toBe(false);
		}
	});

	test("IDN hosts are converted to punycode", () => {
		const result = resolveRemoteCandidates("www.例子.com", { exact: false });
		expect(result.ok && result.urls[0]).toBe(wk("www.xn--fsqu00a.com"));
	});
});

describe("applyLinkCredentials", () => {
	const two: ProviderImportPayload = {
		v: 1,
		providers: [
			{ id: "claude", name: "C", protocol: "anthropic-messages", baseUrl: "https://a.example.com" },
			{ id: "gpt", name: "G", protocol: "openai-responses", baseUrl: "https://a.example.com/v1" },
		],
	};

	test("targets one provider when `provider` is given", () => {
		const out = applyLinkCredentials(two, { key: "sk-1", provider: "gpt", label: "work" });
		expect(out.providers[0]).toEqual(two.providers[0]);
		expect(out.providers[1]).toMatchObject({ apiKey: "sk-1", name: "G · work" });
	});

	test("applies to all providers otherwise", () => {
		const out = applyLinkCredentials(two, { key: "sk-1" });
		expect(out.providers.map((p) => p.apiKey)).toEqual(["sk-1", "sk-1"]);
	});
});

describe("protocol handler self-test", () => {
	const nonce = "3f2b8c1e-9a4d-4c3b-8e7f-1a2b3c4d5e6f";

	test("the nonce survives the handler's escaping into the page fragment or query", () => {
		const escaped = encodeURIComponent(buildSelfTestLink(nonce));
		expect(selfTestNonceFromPageLocation("", `#link=${escaped}`)).toBe(nonce);
		expect(selfTestNonceFromPageLocation(`?link=${escaped}`, "")).toBe(nonce);
	});

	test("ordinary visits and import links are not self-tests", () => {
		expect(selfTestNonceFromPageLocation("", "")).toBeNull();
		expect(selfTestNonceFromPageLocation("", "#link=")).toBeNull();
		const importLink = encodeURIComponent("web+narrafork://import#NFP1.abc.0000000");
		expect(selfTestNonceFromPageLocation("", `#link=${importLink}`)).toBeNull();
		const bad = encodeURIComponent("web+narrafork://import#selftest=<script>");
		expect(selfTestNonceFromPageLocation("", `#link=${bad}`)).toBeNull();
	});
});

describe("provider-only import", () => {
	test("group declarations are ignored as unknown provider fields", () => {
		const raw = {
			...PAYLOAD,
			providers: [
				{
					...PAYLOAD.providers[0],
					groups: [{ id: "vip", name: "VIP" }],
				},
			],
		};
		const result = validateImportPayload(raw, { allowApiKey: true });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.ignoredFields).toEqual(["providers[0].groups"]);
		expect(result.payload.providers[0]).not.toHaveProperty("groups");
	});

	test("short links ignore group selectors and apply keys to provider entries", () => {
		const parsed = parseImportInput(
			"web+narrafork://import?domain=www.geek2api.com#key=sk-1&provider=claude&group=vip&label=work",
		);
		expect(parsed.kind).toBe("remote");
		if (parsed.kind !== "remote") return;
		expect(parsed).not.toHaveProperty("group");
		expect(applyLinkCredentials(PAYLOAD, parsed).providers[0]).toMatchObject({
			apiKey: "sk-1",
			name: "Geek2API Claude · work",
		});
	});
});
