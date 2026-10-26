import { describe, expect, mock, test } from "bun:test";
import {
	createTokenRecalculationProtocolResolver,
	type TokenRecalculationProtocolDependencies,
} from "./token-recalculation-protocol";

function dependencies(
	overrides: Partial<TokenRecalculationProtocolDependencies> = {},
): TokenRecalculationProtocolDependencies {
	return {
		getSettings: () => ({}),
		resolveModelProtocol: () => undefined,
		resolveNugModelMeta: () => {
			throw new Error("No cached metadata");
		},
		getTokenDanceCatalogModels: () => [],
		getCachedCommandCodeModel: () => undefined,
		...overrides,
	};
}

function row(provider: string | null, model: string | null, credential_id: string | null = null) {
	return { provider, model, credential_id };
}

describe("historical token recalculation protocol", () => {
	test("credential wins over prefix across connection families, including disabled history", () => {
		const resolve = createTokenRecalculationProtocolResolver(
			dependencies({
				getSettings: () => ({
					customApiProviders: [
						{ id: "a", prefix: "proxy", protocol: "openai-responses" },
						{ id: "b", prefix: "old", protocol: "gemini-compatible", disabled: true },
					],
					anthropicProviders: [{ id: "legacy", prefix: "legacy", disabled: true }],
				}),
			}),
		);
		expect(resolve(row("proxy", "claude", "b"))).toEqual({ protocol: "gemini", fallback: false });
		expect(resolve(row("proxy", "gpt", "legacy"))).toEqual({
			protocol: "anthropic",
			fallback: false,
		});
		expect(resolve(row("proxy", "claude", "deleted"))).toEqual({
			protocol: "openai",
			fallback: false,
		});
	});

	test("canonical custom protocol wins over derived legacy copies and model names", () => {
		const resolve = createTokenRecalculationProtocolResolver(
			dependencies({
				getSettings: () => ({
					customApiProviders: [
						{ id: "a", prefix: "proxy", protocol: "anthropic-messages" },
						{ id: "b", prefix: "completion", protocol: "completions-compatible" },
					],
					openaiProviders: [{ id: "a", prefix: "proxy" }],
				}),
			}),
		);
		expect(resolve(row("proxy", "gpt", "a"))).toEqual({ protocol: "anthropic", fallback: false });
		expect(resolve(row("completion", "gemini"))).toEqual({ protocol: "openai", fallback: false });
	});

	test("model overrides use the matched connection prefix before its default protocol", () => {
		const resolveModelProtocol = mock((prefix: string, model: string) => {
			expect(prefix).toBe("actual");
			expect(model).toBe("unrelated-model");
			return "anthropic-messages";
		});
		const resolve = createTokenRecalculationProtocolResolver(
			dependencies({
				getSettings: () => ({
					customApiProviders: [{ id: "a", prefix: "actual", protocol: "gemini-compatible" }],
				}),
				resolveModelProtocol,
			}),
		);
		expect(resolve(row("old", "unrelated-model", "a"))).toEqual({
			protocol: "anthropic",
			fallback: false,
		});
	});

	test("legacy connection families and built-in identities retain their protocol", () => {
		const resolve = createTokenRecalculationProtocolResolver(
			dependencies({
				getSettings: () => ({
					anthropicProviders: [{ id: "a", prefix: "old-a" }],
					openaiProviders: [
						{ id: "o", prefix: "old-o", apiMode: "codex" },
						{ id: "c", prefix: "old-c", responsesApi: false },
					],
					geminiProviders: [{ id: "g", prefix: "old-g", disabled: true }],
				}),
			}),
		);
		for (const [provider, protocol] of [
			["old-a", "anthropic"],
			["old-o", "openai"],
			["old-c", "openai"],
			["old-g", "gemini"],
			["codex", "openai"],
			["anthropic", "anthropic"],
			["openai", "openai"],
			["gemini", "gemini"],
		] as const) {
			expect(resolve(row(provider, "misleading-name"))).toEqual({
				protocol,
				fallback: false,
			});
		}
	});

	test("NUG uses local channel types; overrides win and metadata misses are fallback", () => {
		const lookup = mock((id: string, prefix: string, model: string) => {
			expect(id).toBe("nug-id");
			expect(prefix).toBe("gateway");
			if (model === "missing") throw new Error("Missing cache");
			return { channelType: model };
		});
		const resolve = createTokenRecalculationProtocolResolver(
			dependencies({
				getSettings: () => ({
					nugProviders: [{ id: "nug-id", prefix: "gateway", disabled: true }],
				}),
				resolveNugModelMeta: lookup,
				resolveModelProtocol: (_, model) =>
					model === "override" ? "gemini-compatible" : undefined,
			}),
		);
		expect(resolve(row("gateway", "override"))).toEqual({ protocol: "gemini", fallback: false });
		expect(lookup).not.toHaveBeenCalled();
		for (const channel of ["anthropic", "openai", "codex", "responses"]) {
			expect(resolve(row("other", channel, "nug-id"))).toEqual({
				protocol: channel === "anthropic" ? "anthropic" : "openai",
				fallback: false,
			});
		}
		for (const model of ["missing", "unknown", "gemini"]) {
			expect(resolve(row("gateway", model))).toEqual({ protocol: "openai", fallback: true });
		}
	});

	test("CommandCode reuses explicit protocol, endpoint overrides, and cached endpoint ordering", () => {
		const resolve = createTokenRecalculationProtocolResolver(
			dependencies({
				getSettings: () => ({
					commandCode: { endpoints: { configured: "messages", explicit: "messages" } },
				}),
				resolveModelProtocol: (_, model) =>
					model === "explicit" ? "completions-compatible" : undefined,
				getCachedCommandCodeModel: (model) => ({
					endpoints: model === "catalog" ? ["/messages"] : ["/responses"],
				}),
			}),
		);
		for (const model of ["configured", "catalog", "CommandCode:catalog"]) {
			expect(resolve(row("CommandCode", model))).toEqual({
				protocol: "anthropic",
				fallback: false,
			});
		}
		for (const model of ["explicit", "claude-from-openai-channel"]) {
			expect(resolve(row("CommandCode", model))).toEqual({ protocol: "openai", fallback: false });
		}
		expect(resolve(row("commandcode", "claude"))).toEqual({ protocol: "openai", fallback: true });
	});

	test("TokenDance uses catalog protocol preference and model override, not the model name", () => {
		const resolve = createTokenRecalculationProtocolResolver(
			dependencies({
				getTokenDanceCatalogModels: () => [
					{ id: "gpt", supported_protocols: ["openai:responses", "anthropic:messages"] },
					{ id: "claude", supported_protocols: ["gemini:generate-content"] },
					{ id: "unsupported", supported_protocols: ["unknown"] },
				],
				resolveModelProtocol: (_, model) =>
					model === "override" ? "completions-compatible" : undefined,
			}),
		);
		expect(resolve(row("tokendance", "tokendance:gpt"))).toEqual({
			protocol: "anthropic",
			fallback: false,
		});
		expect(resolve(row("tokendance", "claude"))).toEqual({ protocol: "gemini", fallback: false });
		expect(resolve(row("tokendance", "override"))).toEqual({ protocol: "openai", fallback: false });
		for (const model of ["unknown", "unsupported"]) {
			expect(resolve(row("tokendance", model))).toEqual({ protocol: "openai", fallback: true });
		}
	});

	test("unknown or missing provider never infers a protocol from a model name", () => {
		const resolve = createTokenRecalculationProtocolResolver(dependencies());
		for (const provider of [null, "", "removed-provider"]) {
			for (const model of [null, "claude-opus", "gemini-pro", "anthropic:claude"]) {
				expect(resolve(row(provider, model))).toEqual({ protocol: "openai", fallback: true });
			}
		}
	});

	test("builtin Codex ignores fake Anthropic overrides and same-prefix API configs", () => {
		const resolveModelProtocol = mock(() => "anthropic-messages");
		const builtin = createTokenRecalculationProtocolResolver(
			dependencies({ resolveModelProtocol }),
		);
		expect(builtin(row("codex", "codex:gpt"))).toEqual({ protocol: "openai", fallback: false });
		const resolve = createTokenRecalculationProtocolResolver(
			dependencies({
				getSettings: () => ({
					customApiProviders: [
						{ id: "collision", prefix: "codex", protocol: "gemini-compatible" },
						{ id: "actual", prefix: "proxy", protocol: "openai-responses" },
					],
				}),
				resolveModelProtocol,
			}),
		);
		for (const credential of [null, "oauth-account", "collision"]) {
			expect(resolve(row("codex", "codex:gpt", credential))).toEqual({
				protocol: "openai",
				fallback: false,
			});
		}
		expect(resolveModelProtocol).not.toHaveBeenCalled();
		// A real credential identifying a different API connection remains authoritative;
		// only the builtin identity is fixed, not custom OpenAI/codex-mode connections.
		expect(resolve(row("codex", "gpt", "actual"))).toEqual({
			protocol: "anthropic",
			fallback: false,
		});
		expect(resolveModelProtocol).toHaveBeenLastCalledWith("proxy", "gpt");
	});

	test("CommandCode registry priority preserves selector handling of unsupported overrides", () => {
		const resolve = createTokenRecalculationProtocolResolver(
			dependencies({
				getSettings: () => ({
					customApiProviders: [
						{ id: "collision", prefix: "CommandCode", protocol: "gemini-compatible" },
					],
				}),
				resolveModelProtocol: () => "gemini-compatible",
				getCachedCommandCodeModel: () => ({ endpoints: ["/messages"] }),
			}),
		);
		expect(resolve(row("CommandCode", "gpt"))).toEqual({ protocol: "anthropic", fallback: false });
	});

	test("orphan model overrides cannot invent a protocol for unknown providers", () => {
		const resolveModelProtocol = mock(() => "anthropic-messages");
		const resolve = createTokenRecalculationProtocolResolver(
			dependencies({ resolveModelProtocol }),
		);
		expect(resolve(row("removed-provider", "claude"))).toEqual({
			protocol: "openai",
			fallback: true,
		});
		expect(resolveModelProtocol).not.toHaveBeenCalled();
	});

	test("cache includes credential, is per job, and clears at its bounded capacity", () => {
		const resolveModelProtocol = mock(() => "anthropic-messages");
		const deps = dependencies({
			resolveModelProtocol,
			getSettings: () => ({ anthropicProviders: [{ id: "configured", prefix: "p" }] }),
		});
		const resolve = createTokenRecalculationProtocolResolver(deps);
		resolve(row("p", "m", "a"));
		resolve(row("p", "m", "a"));
		expect(resolveModelProtocol).toHaveBeenCalledTimes(1);
		resolve(row("p", "m", "b"));
		expect(resolveModelProtocol).toHaveBeenCalledTimes(2);
		createTokenRecalculationProtocolResolver(deps)(row("p", "m", "a"));
		expect(resolveModelProtocol).toHaveBeenCalledTimes(3);
		for (let index = 0; index < 4095; index++) resolve(row("p", String(index)));
		const callsBefore = resolveModelProtocol.mock.calls.length;
		resolve(row("p", "m", "a"));
		expect(resolveModelProtocol).toHaveBeenCalledTimes(callsBefore + 1);
	});
});
