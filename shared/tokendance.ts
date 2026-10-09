/** TokenDance's fixed identity is attribution, not this installation's callback origin. */
export const TOKENDANCE_APP_URL = "https://tokendanceconnect.narrafork.dev/";
export const TOKENDANCE_ORIGIN = "https://tokendance.space";
export const TOKENDANCE_PREFIX = "tokendance";

export type TokenDanceRecoveryAction = "top_up_balance" | "reauthorize_api_key" | "api_key_quota";

export function parseTokenDanceRecoveryAction(
	value: unknown,
): TokenDanceRecoveryAction | undefined {
	return value === "top_up_balance" || value === "reauthorize_api_key" || value === "api_key_quota"
		? value
		: undefined;
}

export type TokenDanceProtocol =
	| "openai-responses"
	| "anthropic-messages"
	| "completions-compatible"
	| "gemini-compatible";

export interface TokenDanceCatalogModel {
	id: string;
	name: string;
	context_length: number;
	supported_protocols: string[];
}

export function selectTokenDanceProtocol(
	protocols: readonly string[],
): TokenDanceProtocol | undefined {
	if (protocols.includes("openai:responses")) return "openai-responses";
	if (protocols.includes("anthropic:messages")) return "anthropic-messages";
	if (protocols.includes("openai:chat-completions")) return "completions-compatible";
	if (protocols.includes("gemini:generate-content")) return "gemini-compatible";
	return undefined;
}

/** Never include an API Key in this public connection DTO. */
export interface TokenDancePublicConnection {
	connected: boolean;
	name: string;
	disabled: boolean;
	generation: number;
	models: TokenDanceCatalogModel[];
	recoveryAction?: TokenDanceRecoveryAction;
}

/** User-authored unsaved fields only; TokenDance credentials must be excluded. */
export interface TokenDanceDraftSnapshot {
	draft: Record<string, unknown>;
	baseline: Record<string, unknown>;
	addPage?: Record<string, unknown>;
}

export interface TokenDanceOAuthStart {
	authorizeUrl: string;
	flowId: string;
	expiresAt: number;
}

export interface TokenDanceOAuthComplete {
	connected: true;
	modelsRefreshed: boolean;
	refreshError?: string;
	recoveryAction?: TokenDanceRecoveryAction;
}

export interface TokenDanceDraftRestore {
	draftSnapshot?: TokenDanceDraftSnapshot;
	status: "pending" | "completed" | "failed" | "cancelled";
}
