import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildLicenseManifestFromDisk } from "../licenses/manifest";
import { getSourcingCatalog } from "./presets";
import { getServiceTemplate } from "./templates";

const PROVIDER_PRESETS = getSourcingCatalog().presets;

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
			if (entry.category === "platform-login") {
				expect(entry.defaultProtocol).toBeUndefined();
				expect(entry.endpoints).toEqual({});
			} else {
				expect(entry.defaultProtocol).toBeDefined();
				if (entry.defaultProtocol) expect(entry.endpoints[entry.defaultProtocol]).toBeTruthy();
			}
		}
	});

	test("includes only supported HTTP protocols and API URLs without referral metadata", () => {
		const supported = new Set([
			"anthropic-messages",
			"openai-responses",
			"completions-compatible",
			"gemini-compatible",
		]);
		for (const set of PROVIDER_PRESETS.flatMap((entry) => [
			entry.endpoints,
			...(entry.connections ?? []).map((connection) => connection.endpoints),
		])) {
			for (const [protocol, value] of Object.entries(set)) {
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

	test("known services take their endpoints from the service template", () => {
		for (const [id, templateId] of [
			["deepseek", "deepseek"],
			["openai", "openai"],
			["anthropic", "anthropic"],
			["gemini", "gemini"],
			["opencode", "opencode-go"],
		] as const) {
			expect(endpoints(id)).toEqual({ ...getServiceTemplate(templateId).endpoints });
		}
		const kimi = PROVIDER_PRESETS.find((entry) => entry.id === "moonshot")?.connections;
		for (const region of ["china", "international"] as const) {
			expect(
				kimi?.find((entry) => entry.region === region && entry.billing === "token-plan")?.endpoints,
			).toEqual({ ...getServiceTemplate("kimi-code").regions?.[region] });
		}
	});

	test("every variant is a valid creation target", () => {
		for (const entry of PROVIDER_PRESETS) {
			for (const connection of entry.connections ?? []) {
				expect(connection.endpoints[connection.defaultProtocol]).toBeTruthy();
				expect(connection.userAgentMode).toBe(
					connection.billing === "token-plan" ? "narrafork" : undefined,
				);
			}
		}
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
		expect(entry?.distributedVia).toContain("server/lib/sourcing/presets.ts");
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
