import { hotSafe } from "../hot-safe";
import type { ChatParams, ProviderAdapter } from "./provider";

export interface ModelTraceRequest {
	adapter: ProviderAdapter;
	params: Pick<
		ChatParams,
		| "conversationId"
		| "stickySessionKey"
		| "content"
		| "model"
		| "cwd"
		| "history"
		| "tools"
		| "toolResults"
		| "toolLoadingStrategy"
		| "images"
		| "reasoningEffort"
		| "maxOutputTokens"
		| "serviceTier"
		| "metadata"
	>;
}

// Retain only recent requests, not another copy of each conversation's large payload.
const requests = hotSafe("modeltrace.requests", () => new Map<string, ModelTraceRequest>());
const MAX_REQUESTS = 64;

export function rememberModelTraceRequest(
	narratorId: string,
	adapter: ProviderAdapter,
	params: ChatParams,
): void {
	requests.delete(narratorId);
	requests.set(narratorId, {
		adapter,
		params: {
			conversationId: params.conversationId,
			stickySessionKey: params.stickySessionKey,
			content: params.content,
			model: params.model,
			cwd: params.cwd,
			// Protocol turns are append-only. Copy the arrays so subsequent turns don't
			// extend the prefix; share existing blocks rather than cloning a large history.
			history: params.history.slice(),
			tools: params.tools.slice(),
			toolResults: params.toolResults.slice(),
			toolLoadingStrategy: params.toolLoadingStrategy,
			images: params.images?.slice(),
			reasoningEffort: params.reasoningEffort,
			maxOutputTokens: params.maxOutputTokens,
			serviceTier: params.serviceTier,
			metadata: params.metadata ? { ...params.metadata } : undefined,
		},
	});
	if (requests.size > MAX_REQUESTS) {
		const oldest = requests.keys().next().value;
		if (oldest !== undefined) requests.delete(oldest);
	}
}

export function getModelTraceRequest(narratorId: string): ModelTraceRequest | undefined {
	return requests.get(narratorId);
}

export function forgetModelTraceRequest(narratorId: string): void {
	requests.delete(narratorId);
}
