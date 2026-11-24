import { describe, expect, test } from "bun:test";
import { isOpencodeGoBaseUrl } from "../opencode-go-endpoint";
import { identifyService } from "./identify";

/** The checks identify replaced, verbatim, as the reference for the equivalence test. */
function legacyIsKimi(baseUrl?: string): boolean {
	if (!baseUrl) return false;
	try {
		const host = new URL(baseUrl).hostname.toLowerCase();
		return (
			host === "kimi.com" ||
			host === "kimi.ai" ||
			host.endsWith(".kimi.com") ||
			host.endsWith(".kimi.ai")
		);
	} catch {
		return false;
	}
}

function legacyIsDeepSeek(baseUrl?: string): boolean {
	if (!baseUrl) return false;
	try {
		const url = new URL(baseUrl);
		return (
			url.protocol === "https:" &&
			url.hostname.toLowerCase() === "api.deepseek.com" &&
			!url.port &&
			!url.username &&
			!url.password &&
			!url.search &&
			!url.hash &&
			// Plus `/anthropic/v1`, the add page's Anthropic preset, which the old check missed.
			["/", "/v1", "/anthropic", "/anthropic/v1"].includes(url.pathname.replace(/\/$/, "") || "/")
		);
	} catch {
		return false;
	}
}

const CORPUS = [
	undefined,
	"",
	"not a url",
	"https://api.kimi.com/coding/",
	"https://api.kimi.com/coding/v1",
	"https://api.kimi.ai/coding/v1",
	"https://kimi.com",
	"https://KIMI.COM/x",
	"http://api.kimi.com:8443/coding/v1?x=1",
	"https://user:pass@api.kimi.ai/coding/v1",
	"foo://API.KIMI.COM/x",
	"https://kimi.com.evil.example",
	"https://evilkimi.com/v1",
	"https://api.moonshot.cn/v1",
	"https://api.moonshot.ai/anthropic/v1",
	"https://api.deepseek.com",
	"https://api.deepseek.com/",
	"https://api.deepseek.com//",
	"https://api.deepseek.com/v1",
	"https://api.deepseek.com/v1/",
	"https://api.deepseek.com/v1//",
	"https://api.deepseek.com/anthropic",
	"https://api.deepseek.com/anthropic/",
	"https://api.deepseek.com/anthropic/v1",
	"https://API.DEEPSEEK.COM/v1",
	"http://api.deepseek.com/v1",
	"https://api.deepseek.com:443/v1",
	"https://api.deepseek.com:8443/v1",
	"https://user@api.deepseek.com/v1",
	"https://api.deepseek.com/v1?x=1",
	"https://api.deepseek.com/v1#x",
	"https://api.deepseek.com.evil.example/v1",
	"https://deepseek.relay.example/v1",
	"https://opencode.ai/zen/go/v1",
	"https://opencode.ai/zen/go/v1/",
	"https://opencode.ai/zen/go/v1//",
	"https://opencode.ai/inference/go/v1",
	"https://opencode.ai/inference/go/openai/v1",
	"https://opencode.ai/inference/go/anthropic/v1",
	"https://opencode.ai/inference/go/google/v1beta",
	"https://api.opencode.ai/zen/go/v1",
	"https://opencode.ai/zen/v1",
	"https://opencode.ai:8443/zen/go/v1",
	"http://opencode.ai/zen/go/v1",
	"https://opencode.ai/zen/go/v1?x=1",
	"https://opencode.ai.evil.example/zen/go/v1",
	"https://api.openai.com/v1",
	"https://api.anthropic.com/v1",
	"https://generativelanguage.googleapis.com/v1beta",
];

describe("identifyService", () => {
	test("agrees with every check it replaced", () => {
		for (const baseUrl of CORPUS) {
			const { templateId } = identifyService({ baseUrl });
			expect([baseUrl, templateId === "kimi-code"]).toEqual([baseUrl, legacyIsKimi(baseUrl)]);
			expect([baseUrl, templateId === "deepseek"]).toEqual([baseUrl, legacyIsDeepSeek(baseUrl)]);
			expect([baseUrl, templateId === "opencode-go"]).toEqual([
				baseUrl,
				isOpencodeGoBaseUrl(baseUrl),
			]);
		}
	});

	test("DeepSeek's Anthropic preset is DeepSeek, under the same strict rules", () => {
		for (const baseUrl of [
			"https://api.deepseek.com/anthropic/v1",
			"https://api.deepseek.com/anthropic/v1/",
		]) {
			expect(identifyService({ baseUrl, protocol: "anthropic-messages" })).toEqual({
				templateId: "deepseek",
			});
		}
		for (const baseUrl of [
			"http://api.deepseek.com/anthropic/v1",
			"https://api.deepseek.com:8443/anthropic/v1",
			"https://api.deepseek.com/anthropic/v1?x=1",
			"https://api.deepseek.com/anthropic/v2",
			"https://relay.example/anthropic/v1",
		]) {
			expect(identifyService({ baseUrl, protocol: "anthropic-messages" })).toEqual({
				templateId: "anthropic-compatible",
			});
		}
	});

	test("Kimi Code carries its region; Moonshot's pay-as-you-go hosts are not the plan", () => {
		expect(identifyService({ baseUrl: "https://api.kimi.com/coding/v1" })).toEqual({
			templateId: "kimi-code",
			region: "china",
		});
		expect(identifyService({ baseUrl: "https://api.kimi.ai/coding/v1" })).toEqual({
			templateId: "kimi-code",
			region: "international",
		});
		for (const baseUrl of ["https://api.moonshot.cn/v1", "https://api.moonshot.ai/v1"]) {
			expect(identifyService({ baseUrl, protocol: "completions-compatible" })).toEqual({
				templateId: "openai-compatible",
			});
		}
		expect(
			identifyService({
				baseUrl: "https://api.moonshot.cn/anthropic/v1",
				protocol: "anthropic-messages",
			}),
		).toEqual({ templateId: "anthropic-compatible" });
	});

	test("official hosts on their exact roots", () => {
		const cases: Array<[string, string]> = [
			["https://opencode.ai/zen/go/v1", "opencode-go"],
			["https://api.deepseek.com/anthropic", "deepseek"],
			["https://api.openai.com", "openai"],
			["https://api.openai.com/v1/", "openai"],
			["https://api.anthropic.com/v1", "anthropic"],
			["https://generativelanguage.googleapis.com/v1beta", "gemini"],
			["https://generativelanguage.googleapis.com/v1", "gemini"],
		];
		for (const [baseUrl, templateId] of cases) {
			expect([baseUrl, identifyService({ baseUrl }).templateId]).toEqual([baseUrl, templateId]);
		}
	});

	test("mirrors, ports, credentials, queries and other paths fall back to the protocol", () => {
		const cases: Array<[string, Parameters<typeof identifyService>[0]["protocol"], string]> = [
			["https://relay.example/v1", "openai-responses", "openai-compatible"],
			["https://relay.example/v1", "completions-compatible", "openai-compatible"],
			["https://relay.example/v1", "anthropic-messages", "anthropic-compatible"],
			["https://relay.example/v1beta", "gemini-compatible", "gemini-compatible"],
			["https://api.openai.com:8443/v1", "openai-responses", "openai-compatible"],
			["http://api.openai.com/v1", "openai-responses", "openai-compatible"],
			["https://key@api.anthropic.com/v1", "anthropic-messages", "anthropic-compatible"],
			["https://api.anthropic.com/v1?beta=1", "anthropic-messages", "anthropic-compatible"],
			["https://api.anthropic.com/proxy/v1", "anthropic-messages", "anthropic-compatible"],
			["https://api.openai.com.evil.example/v1", "openai-responses", "openai-compatible"],
			["https://chatgpt.com/backend-api/codex", "openai-responses", "openai-compatible"],
			[
				"https://generativelanguage.googleapis.com/v1beta#x",
				"gemini-compatible",
				"gemini-compatible",
			],
			["not a url", "anthropic-messages", "anthropic-compatible"],
		];
		for (const [baseUrl, protocol, templateId] of cases) {
			expect([baseUrl, identifyService({ baseUrl, protocol }).templateId]).toEqual([
				baseUrl,
				templateId,
			]);
		}
		expect(identifyService({})).toEqual({ templateId: "openai-compatible" });
	});

	test("a NUG connection is always nug", () => {
		expect(identifyService({ baseUrl: "https://api.kimi.com/coding/v1", protocol: "nug" })).toEqual(
			{ templateId: "nug" },
		);
		expect(identifyService({ protocol: "nug" })).toEqual({ templateId: "nug" });
	});
});
