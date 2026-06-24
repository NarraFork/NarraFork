import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { settings } from "../../settings";

class MockProvider {}

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


		);
	});
});
