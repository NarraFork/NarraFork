import { afterEach, describe, expect, test } from "bun:test";
import { settings } from "../../settings";
import { suggestToolAppendingProtocols } from "../index";
import { switchableModelProtocols } from "../switchable-protocols";

const saved = {
	openaiProviders: settings.openaiProviders,
	nugProviders: settings.nugProviders,
	modelProtocols: settings.agent.modelProtocols,
};
afterEach(() => {
	settings.openaiProviders = saved.openaiProviders;
	settings.nugProviders = saved.nugProviders;
	settings.agent.modelProtocols = saved.modelProtocols;
});

function useOpenAI(prefix: string) {
	settings.openaiProviders = [
		...(saved.openaiProviders ?? []),
		{
			id: `${prefix}-id`,
			name: prefix,
			prefix,
			apiKey: "isolated-no-network",
			baseUrl: "https://example.invalid/v1",
			defaultModel: "deepseek-v4.1-flash",
			apiMode: "completions",
		},
	];
}

describe("switchableModelProtocols", () => {
	test("API connections offer every per-model protocol", () => {
		useOpenAI("suggest-openai");
		expect(switchableModelProtocols("suggest-openai", "suggest-openai:any")).toEqual([
			"anthropic-messages",
			"openai-responses",
			"completions-compatible",
			"gemini-compatible",
		]);
	});
	test("NUG routes by gateway channel and offers no per-model protocol", () => {
		settings.nugProviders = [
			...(saved.nugProviders ?? []),
			{
				id: "suggest-nug-id",
				name: "nug",
				prefix: "suggest-nug",
				apiKey: "isolated-no-network",
				baseUrl: "https://example.invalid",
				defaultModel: "any",
			},
		];
		expect(switchableModelProtocols("suggest-nug", "suggest-nug:any")).toEqual([]);
	});
	test("CommandCode has no Gemini endpoint; unknown providers offer nothing", () => {
		expect(switchableModelProtocols("CommandCode", "CommandCode:any")).not.toContain(
			"gemini-compatible",
		);
		expect(switchableModelProtocols("codex", "codex:gpt-6")).toEqual([]);
		expect(switchableModelProtocols("no-such-provider", "no-such-provider:any")).toEqual([]);
	});
});

describe("suggestToolAppendingProtocols", () => {
	test("DeepSeek on a completions connection is pointed at Anthropic Messages", () => {
		useOpenAI("suggest-ds");
		expect(suggestToolAppendingProtocols("suggest-ds:deepseek-v4.1-flash", "suggest-ds")).toEqual([
			"anthropic-messages",
		]);
	});
	test("no suggestion once the current protocol keeps the cache", () => {
		useOpenAI("suggest-ds2");
		settings.agent.modelProtocols = {
			...saved.modelProtocols,
			"suggest-ds2:deepseek-v4.1-flash": "anthropic-messages",
		};
		expect(suggestToolAppendingProtocols("suggest-ds2:deepseek-v4.1-flash", "suggest-ds2")).toEqual(
			[],
		);
	});
});
