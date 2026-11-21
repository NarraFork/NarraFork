import { ValidationError } from "../errors";
import { hotSafe } from "../hot-safe";
import type { ChatParams, ProviderAdapter } from "./provider";

export interface ModelTraceRequest {
	adapter: ProviderAdapter;
	/** Effective routing provider captured with the adapter, never re-resolved on retry. */
	provider: string;
	credentialId?: string;
	validateCredential?: () => boolean;
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
		| "media"
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
	params: ModelTraceRequest["params"],
	provider: string,
	credentialId?: string,
	validateCredential?: () => boolean,
): void {
	requests.delete(narratorId);
	requests.set(narratorId, {
		adapter,
		provider,
		credentialId,
		validateCredential,
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
			media: params.media?.slice(),
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

export function requireModelTraceAnchor(narratorId: string): ModelTraceRequest {
	const anchor = getModelTraceRequest(narratorId);
	if (!anchor?.params.conversationId) {
		throw new ValidationError("No recent upstream request to fork; send a message and try again");
	}
	if (!anchor.adapter.supportsDiagnosticFork?.(anchor.params.model, anchor.credentialId)) {
		throw new ValidationError("This provider cannot safely fork the diagnostic request prefix");
	}
	assertModelTraceCredential(anchor);
	return anchor;
}

function assertModelTraceCredential(anchor: ModelTraceRequest): void {
	if (
		anchor.adapter.isDiagnosticConnectionCurrent?.() === false ||
		anchor.validateCredential?.() === false
	) {
		throw new ValidationError(
			"The parent diagnostic connection or credential changed; send a message and try again",
		);
	}
}

export function buildModelTraceProbeParams(
	anchor: ModelTraceRequest,
	transportSessionKey: string,
	signal: AbortSignal,
	prompt: string,
): ChatParams {
	assertModelTraceCredential(anchor);
	const source = anchor.params;
	if (
		!transportSessionKey ||
		transportSessionKey === source.stickySessionKey ||
		transportSessionKey === source.conversationId
	) {
		throw new ValidationError("A diagnostic fork requires an independent transport session");
	}
	return {
		...source,
		history: source.history.slice(),
		tools: source.tools.slice(),
		toolResults: source.toolResults.slice(),
		images: source.images?.slice(),
		media: source.media?.slice(),
		metadata: source.metadata ? { ...source.metadata } : undefined,
		diagnostic: true,
		diagnosticFork: {
			suffix: prompt,
			credentialId: anchor.credentialId,
			validateCredential: () => {
				assertModelTraceCredential(anchor);
				return true;
			},
		},
		transportSessionKey,
		resetUpstreamSession: true,
		signal,
	};
}

export function forgetModelTraceRequest(narratorId: string): void {
	requests.delete(narratorId);
}
