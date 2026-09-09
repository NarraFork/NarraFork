import type { EventHandlerContext, TokenUsageSnapshot } from "../narrator-event-handler";
import type { narratorService } from "../narrator-service";

/** The profile changes subtree placement only, never origin, principal or receipt data. */
export function createRuntimeMessageWriters(parentToolUseId?: string) {
	return {
		persistUserMessage: async (...args: Parameters<typeof narratorService.persistUserMessage>) => {
			const { narratorService } = await import("../narrator-service");
			if (parentToolUseId) args[6] = { ...args[6], parentToolUseId };
			return narratorService.persistUserMessage(...args);
		},
		persistSystemMessage: async (
			...args: Parameters<typeof narratorService.persistSystemMessage>
		) => {
			const { narratorService } = await import("../narrator-service");
			if (parentToolUseId) args[5] = { ...args[5], parentToolUseId };
			return narratorService.persistSystemMessage(...args);
		},
	};
}

export type RuntimeEventContextOptions = Pick<
	EventHandlerContext,
	"narratorId" | "conversationId"
> & {
	provider: string;
	model: string;
	locale: string;
} & Partial<EventHandlerContext>;

/**
 * One pass context factory for both entry adapters. Default mutable state is pass-local;
 * primary sessions supply their existing accessors to retain cross-pass usage/TTFT.
 * This only initializes message metadata. API request accounting stays in processEvent.
 */
export function createRuntimeEventContext(
	options: RuntimeEventContextOptions,
): EventHandlerContext {
	let contextUsagePct: number | undefined;
	let meterUsage: number | undefined;
	let meterUnit: string | undefined;
	let partialMessageId: string | undefined;
	let tokenUsage: TokenUsageSnapshot | undefined;
	return {
		broadcastTargetId: options.narratorId,
		providerPrefix: options.provider,
		getContextUsagePct: () => contextUsagePct,
		getMeterUsage: () => meterUsage,
		getMeterUnit: () => meterUnit,
		getPartialMessageId: () => partialMessageId,
		getTokenUsage: () => tokenUsage,
		setPartialMessageId: (id) => {
			partialMessageId = id;
		},
		setContextUsagePct: (pct) => {
			contextUsagePct = pct;
		},
		setMeterData: (usage, unit) => {
			meterUsage = usage;
			meterUnit = unit;
		},
		setTokenUsage: (usage) => {
			tokenUsage = usage;
		},
		toolCallIdsMap: new Map(),
		...options,
	};
}
