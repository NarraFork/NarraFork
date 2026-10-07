import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildLicenseManifestFromDisk } from "../../../server/lib/licenses/manifest";
import { PROVIDER_PRESETS, searchProviderPresets } from "./provider-presets";

const root = join(import.meta.dir, "../../..");
const commit = "4edb3b85630469e1a784577ec47540cb646d9781";

function endpoints(id: string) {
	const provider = PROVIDER_PRESETS.find((entry) => entry.id === id);
	expect(provider).toBeDefined();
	return provider?.endpoints;
}

describe("provider presets", () => {
	test("snapshot has unique ids and an available default for every provider", () => {
		expect(PROVIDER_PRESETS).toHaveLength(47);
		expect(new Set(PROVIDER_PRESETS.map((entry) => entry.id)).size).toBe(47);
		for (const entry of PROVIDER_PRESETS) {
			expect(entry.id).toBeTruthy();
			expect(entry.name).toBeTruthy();
			expect(entry.endpoints[entry.defaultProtocol]).toBeTruthy();
		}
	});

	test("includes only supported HTTP protocols and API URLs without referral metadata", () => {
		const supported = new Set([
			"anthropic-messages",
			"openai-responses",
			"completions-compatible",
			"gemini-compatible",
		]);
		for (const entry of PROVIDER_PRESETS) {
			for (const [protocol, value] of Object.entries(entry.endpoints)) {
				expect(supported.has(protocol)).toBe(true);
				const url = new URL(value);
				expect(["http:", "https:"]).toContain(url.protocol);
				expect(url.username + url.password + url.search + url.hash).toBe("");
				expect(value.endsWith("/")).toBe(false);
				expect(value).not.toMatch(/\/(messages|responses|chat\/completions|api\/chat)$/);
				if (protocol === "anthropic-messages") expect(url.pathname.endsWith("/v1")).toBe(true);
				if (protocol === "gemini-compatible") expect(url.pathname.endsWith("/v1beta")).toBe(true);
			}
		}
	});

	test("excludes special auth, native protocols and unsupported adapter families", () => {
		for (const id of [
			"azure-openai",
			"aws-bedrock",
			"vertexai",
			"copilot",
			"openai-codex",
			"claude-code",
			"grok-cli",
			"comfyui",
			"gateway",
			"voyageai",
			"mistral",
			"perplexity",
			"cherryin",
			"aihubmix",
			"dmxapi",
			"aionly",
			"new-api",
			"gpustack",
			"nug",
			"custom",
		]) {
			expect(PROVIDER_PRESETS.some((entry) => entry.id === id)).toBe(false);
		}
		expect(endpoints("ollama")).toEqual({
			"completions-compatible": "http://localhost:11434/v1",
		});
	});

	test("direct HTTP concatenation yields versioned official endpoints", () => {
		expect(`${endpoints("anthropic")?.["anthropic-messages"]}/messages`).toBe(
			"https://api.anthropic.com/v1/messages",
		);
		expect(`${endpoints("openai")?.["openai-responses"]}/responses`).toBe(
			"https://api.openai.com/v1/responses",
		);
		expect(
			`${endpoints("gemini")?.["gemini-compatible"]}/models/example:streamGenerateContent`,
		).toBe("https://generativelanguage.googleapis.com/v1beta/models/example:streamGenerateContent");
	});

	test("OpenAI local override includes both APIs and keeps the upstream Responses default", () => {
		expect(endpoints("openai")).toEqual({
			"openai-responses": "https://api.openai.com/v1",
			"completions-compatible": "https://api.openai.com/v1",
		});
		expect(PROVIDER_PRESETS.find((entry) => entry.id === "openai")?.defaultProtocol).toBe(
			"openai-responses",
		);
		expect(`${endpoints("openai")?.["completions-compatible"]}/chat/completions`).toBe(
			"https://api.openai.com/v1/chat/completions",
		);
	});

	test("preserves custom version prefixes and adds missing proxy versions only once", () => {
		expect(endpoints("doubao")?.["openai-responses"]).toBe(
			"https://ark.cn-beijing.volces.com/api/v3",
		);
		expect(endpoints("zhipu")?.["completions-compatible"]).toBe(
			"https://open.bigmodel.cn/api/paas/v4",
		);
		expect(endpoints("ppio")?.["completions-compatible"]).toBe("https://api.ppinfra.com/v3/openai");
		expect(endpoints("opencode")?.["anthropic-messages"]).toBe("https://opencode.ai/zen/go/v1");
		expect(endpoints("dashscope")?.["completions-compatible"]).toBe(
			"https://dashscope.aliyuncs.com/compatible-mode/v1",
		);
		expect(endpoints("openrouter")?.["anthropic-messages"]).toBe("https://openrouter.ai/api/v1");
		expect(endpoints("groq")?.["completions-compatible"]).toBe("https://api.groq.com/openai/v1");
		expect(endpoints("fireworks")?.["openai-responses"]).toBe(
			"https://api.fireworks.ai/inference/v1",
		);
		expect(endpoints("moonshot")?.["anthropic-messages"]).toBe(
			"https://api.moonshot.cn/anthropic/v1",
		);
	});
});

describe("preset search", () => {
	test("empty or whitespace returns the full list without sharing the array", () => {
		for (const query of ["", " \t\n "]) {
			expect(searchProviderPresets(query)).toEqual(PROVIDER_PRESETS);
			expect(searchProviderPresets(query)).not.toBe(PROVIDER_PRESETS);
		}
	});

	test("searches id, name, URL and protocol case-insensitively", () => {
		expect(searchProviderPresets("  OPENAI  ").map((entry) => entry.id)).toContain("openai");
		expect(searchProviderPresets("hugging face").map((entry) => entry.id)).toEqual(["huggingface"]);
		expect(searchProviderPresets("api.minimax.io").map((entry) => entry.id)).toEqual([
			"minimax-global",
		]);
		expect(searchProviderPresets("radeon-cloud").map((entry) => entry.id)).toEqual([
			"radeon-cloud",
		]);
		expect(searchProviderPresets("gemini-compatible").map((entry) => entry.id)).toEqual([
			"tokendance",
			"gemini",
		]);
	});

	test("Chinese and English local aliases match without changing original display names", () => {
		const examples: Array<[string, string]> = [
			["硅基流动", "silicon"],
			["SiliconFlow", "silicon"],
			["智谱", "zhipu"],
			["深度求索", "deepseek"],
			["通义", "dashscope"],
			["百炼", "dashscope"],
			["豆包", "doubao"],
			["月之暗面", "moonshot"],
			["阶跃", "stepfun"],
			["英伟达", "nvidia"],
			["魔搭", "modelscope"],
			["千帆", "baidu-cloud"],
		];
		for (const [query, id] of examples) {
			expect(searchProviderPresets(query).map((entry) => entry.id)).toContain(id);
		}
		expect(searchProviderPresets("月之暗面 .ai").map((entry) => entry.id)).toEqual([
			"moonshot-global",
		]);
		expect(searchProviderPresets("硅基流动")[0]?.name).toBe("Silicon");
	});

	test("all terms must match and search does not reorder or mutate the catalog", () => {
		const ids = PROVIDER_PRESETS.map((entry) => entry.id);
		expect(searchProviderPresets("moonshot .cn").map((entry) => entry.id)).toEqual(["moonshot"]);
		expect(searchProviderPresets("no-such-provider")).toEqual([]);
		expect(PROVIDER_PRESETS.map((entry) => entry.id)).toEqual(ids);
	});
});

describe("provider registry MIT disclosure", () => {
	test("bundled manifest exposes the fixed-commit attribution and retrievable full text", () => {
		const manifest = buildLicenseManifestFromDisk(root);
		const entry = manifest.entries.find(
			(item) => item.name === "@cherrystudio/provider-registry (provider preset data)",
		);
		expect(entry?.kind).toBe("bundled");
		expect(entry?.license).toBe("MIT");
		expect(entry?.author).toBe("Cherry Studio");
		expect(entry?.version).toContain(commit);
		expect(entry?.distributedVia).toContain("provider-presets.ts");
		const text = manifest.texts[entry?.textId ?? ""];
		expect(text).toContain(commit);
		expect(text).toContain("packages/provider-registry/data/providers.json");
		expect(text).toContain("packages/provider-registry/package.json");
		expect(text).toContain(
			"standard MIT template, NOT a verbatim license file supplied by Cherry Studio",
		);
		expect(text).toContain("Copyright (c) Cherry Studio");
		expect(text).toContain("upstream repository root uses AGPL");
		expect(text).toContain("local compatibility override adds OpenAI Chat Completions");
		expect(text).toContain("NarraFork-authored Chinese search aliases");
	});

	test("MIT permission and disclaimer are verbatim from the installed canonical license", () => {
		const canonical = readFileSync(join(root, "node_modules/normalize-path/LICENSE"), "utf8");
		const disclosure = readFileSync(
			join(root, "licenses/extra/cherry-studio-provider-registry.txt"),
			"utf8",
		);
		const body = canonical.slice(canonical.indexOf("Permission is hereby granted")).trim();
		expect(disclosure.slice(disclosure.indexOf("Permission is hereby granted")).trim()).toBe(body);
	});
});
