import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { settings } from "../../settings";

class MockProvider {}

// Snapshot the real provider modules before mocking. Bun's mock.module is
// process-wide and mock.restore() does NOT undo it, so afterAll re-points each
// specifier back — otherwise these MockProvider stubs leak into later suites
// that need the real provider classes (e.g. anthropic-v1-fallback).
const realProviderModules: Record<string, () => unknown> = {
	"../anthropic-provider": () => realAnthropic,
	"../cline-provider": () => realCline,
	"../codex-provider": () => realCodex,
	"../nug-provider": () => realNug,
	"../openai-provider": () => realOpenai,
};
const realAnthropic = { ...(await import("../anthropic-provider")) };
const realCline = { ...(await import("../cline-provider")) };
const realCodex = { ...(await import("../codex-provider")) };
const realNug = { ...(await import("../nug-provider")) };
const realOpenai = { ...(await import("../openai-provider")) };

mock.module("../anthropic-provider", () => ({ AnthropicProvider: MockProvider }));
mock.module("../cline-provider", () => ({ ClineProvider: MockProvider }));
mock.module("../codex-provider", () => ({ CodexProvider: MockProvider }));
mock.module("../nug-provider", () => ({ NugProvider: MockProvider }));
mock.module("../openai-provider", () => ({ OpenAIProvider: MockProvider }));

const { resolveProviderAndModel } = await import("../provider");

describe("resolveProviderAndModel", () => {
	let originalDisabledProviders: string[] | undefined;

	beforeEach(() => {
		originalDisabledProviders = settings.agent?.disabledProviders;
		if (settings.agent) settings.agent.disabledProviders = [];
	});

	afterEach(() => {
		if (settings.agent) settings.agent.disabledProviders = originalDisabledProviders;
	});

	afterAll(() => {
		for (const [specifier, factory] of Object.entries(realProviderModules)) {
			mock.module(specifier, factory);
		}
		mock.restore();
	});


		);
	});
});
