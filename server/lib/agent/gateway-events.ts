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
 *    data: {"position": 3, "queueDepth": 10, "queueMessage": "Waiting for capacity"}
 *    ```
 *
 * 2. Data-embedded format (for non-streaming / WS / fallback):
 *    ```json
 *    {"type": "queueEvent", "position": 3, "queueDepth": 10, "queueMessage": "Waiting"}
 *    ```
 */

import type { ParsedStreamEvent } from "./provider";

/** Gateway event type names injected by the unified gateway. */
const QUEUE_EVENT = "queueEvent";
const QUOTA_BALANCE_EVENT = "quotaBalanceEvent";
const MODEL_CATALOG_EVENT = "modelCatalogEvent";

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value);
}

function formatExtraDetails(value: unknown): string | null {
	if (value == null) return null;
	if (typeof value === "string") return value.trim() || null;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (isRecord(value)) {
		const lines = Object.entries(value)
			.filter(([, entryValue]) => entryValue != null)
			.map(([key, entryValue]) => {
				const formatted =
					typeof entryValue === "string" ||
					typeof entryValue === "number" ||
					typeof entryValue === "boolean"
						? String(entryValue)
						: JSON.stringify(entryValue);
				return `${key}: ${formatted}`;
			});
		return lines.length > 0 ? lines.join("\n") : null;
	}
	try {
		return JSON.stringify(value);
	} catch {
		return null;
	}
}

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
		const queueMessage = data.queueMessage;
		if (position != null || queueMessage != null) {
			return {
				queueStatus: {
					position: position != null ? Number(position) : undefined,
					queueDepth: queueDepth != null ? Number(queueDepth) : undefined,
					queueMessage: queueMessage != null ? String(queueMessage) : undefined,
				},
			};
		}
		return null;
	}

	if (eventType === QUOTA_BALANCE_EVENT) {
		const balance = data.quotaBalance;
		const detailedBalance = data.detailedQuotaBalance;
		return {
			quotaBalance: balance != null ? String(balance) : null,
			detailedQuotaBalance: formatExtraDetails(detailedBalance) ?? formatExtraDetails(data.extra),
		};
	}

	if (eventType === MODEL_CATALOG_EVENT) {
		if (!Array.isArray(data.models)) {
			return null;
		}
		const modelHash =
			typeof data.modelHash === "string"
				? data.modelHash
				: typeof data.hash === "string"
					? data.hash
					: undefined;
		const models = data.models.filter(isRecord);
		return { nugModelCatalog: { modelHash, models } };
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
	return (
		eventType === QUEUE_EVENT ||
		eventType === QUOTA_BALANCE_EVENT ||
		eventType === MODEL_CATALOG_EVENT
	);
}
