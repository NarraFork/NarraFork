/**
 * Shared helpers for parsing gateway-injected events (queue status, quota balance)
 * from SSE streams and WebSocket messages.
 *
 * The narrafork-unified-gateway injects these events into OpenAI/Anthropic SSE
 * streams using two formats:
 *
 * 1. SSE `event:` line format:
 *    ```
 *    event: queueEvent
 *    data: {"position": 3, "queueDepth": 10}
 *    ```
 *
 * 2. Data-embedded format (for non-streaming / WS / fallback):
 *    ```json
 *    {"type": "queueEvent", "position": 3, "queueDepth": 10}
 *    ```
 */

import type { ParsedStreamEvent } from "./provider";

/** Gateway event type names injected by the unified gateway. */
const QUEUE_EVENT = "queueEvent";
const QUOTA_BALANCE_EVENT = "quotaBalanceEvent";

/**
 * Try to parse a gateway-injected event from an SSE `event:` type + `data:` JSON pair.
 * Returns a ParsedStreamEvent if the event type matches, or null otherwise.
 */
export function parseGatewaySSEEvent(
	eventType: string,
	data: Record<string, unknown>,
): ParsedStreamEvent | null {
	if (eventType === QUEUE_EVENT) {
		const position = data.position;
		const queueDepth = data.queueDepth;
		if (position != null) {
			return {
				queueStatus: {
					position: Number(position),
					queueDepth: Number(queueDepth ?? 0),
				},
			};
		}
		return null;
	}

	if (eventType === QUOTA_BALANCE_EVENT) {
		const balance = data.quotaBalance;
		return { quotaBalance: balance != null ? String(balance) : null };
	}

	return null;
}

/**
 * Try to parse a gateway-injected event from a data JSON object that embeds
 * the event type in a `type` field. Used for non-streaming completions API
 * responses and WebSocket messages.
 * Returns a ParsedStreamEvent if the type matches, or null otherwise.
 */
export function parseGatewayDataEvent(data: Record<string, unknown>): ParsedStreamEvent | null {
	const type = data.type;
	if (typeof type !== "string") return null;
	return parseGatewaySSEEvent(type, data);
}

/**
 * Check if an SSE event type is a known gateway-injected event.
 * Used by SSE parsers to skip normal parsing for gateway events.
 */
export function isGatewayEventType(eventType: string): boolean {
	return eventType === QUEUE_EVENT || eventType === QUOTA_BALANCE_EVENT;
}
