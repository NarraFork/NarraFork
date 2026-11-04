import { parseModelId } from "@shared/model-id";
import { tokenDanceProtocols } from "@shared/tokendance";
import { COMMAND_CODE_PREFIX } from "../commandcode-protocol";
import {
	getAnthropicProviderConfig,
	getGeminiProviderConfig,
	getOpenaiProviderConfig,
	MODEL_PROTOCOLS,
	type ModelProtocol,
} from "../settings";
import { getTokenDanceCatalogModels } from "../tokendance-runtime";

/**
 * Protocols the per-model protocol setting (`agent.modelProtocols`) can select for
 * `model` on this connection. Empty for connections whose protocol is not a per-model
 * choice (NUG routes by gateway channel; Codex and plugin providers have one wire).
 */
export function switchableModelProtocols(provider: string, model: string): ModelProtocol[] {
	if (provider === "tokendance") {
		const bare = parseModelId(model).model;
		const entry = getTokenDanceCatalogModels().find((candidate) => candidate.id === bare);
		return tokenDanceProtocols(entry?.supported_protocols ?? []);
	}
	if (provider === COMMAND_CODE_PREFIX)
		return MODEL_PROTOCOLS.filter((protocol) => protocol !== "gemini-compatible");
	if (
		getAnthropicProviderConfig(provider) ||
		getOpenaiProviderConfig(provider) ||
		getGeminiProviderConfig(provider)
	)
		return [...MODEL_PROTOCOLS];
	return [];
}
