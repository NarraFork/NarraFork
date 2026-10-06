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

import type { ParsedStreamEvent } from "./types";

/** Gateway event type names injected by the unified gateway. */
const QUEUE_EVENT = "queueEvent";
const QUOTA_BALANCE_EVENT = "quotaBalanceEvent";
const MODEL_CATALOG_EVENT = "modelCatalogEvent";
const IMAGE_CACHE_ACK_EVENT = "imageCacheAckEvent";
/**
 * Credit consumption and context-window occupancy.
 *
 * These are gateway events like the four above, not upstream protocol events: no
 * provider protocol has a field for either, so NUG reports them under its own
 * names and withholds them from non-NarraFork callers.
 *
 * They live here rather than in a provider-specific parser because some gateway channels
 * now speak Anthropic Messages, and the Anthropic SSE
 * parser has no branch for them. Nothing in this module is provider-aware — these are
 * two more names on a list — so handling them here keeps provider-specific
 * stream parsers deletable.
 */
const METERING_EVENT = "meteringEvent";
const CONTEXT_USAGE_EVENT = "contextUsageEvent";

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
		// An empty queue event explicitly ends queueing, before upstream emits text.
		return { queueStatus: { position: 0, queueDepth: 0 } };
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

	if (eventType === IMAGE_CACHE_ACK_EVENT) {
		if (!Array.isArray(data.refs)) {
			return null;
		}
		const refs = data.refs.filter((ref): ref is string => typeof ref === "string" && ref !== "");
		return { nugImageCacheAck: { refs } };
	}

	if (eventType === METERING_EVENT) {
		const usage = numberFrom(data.usage);
		// An ABSENT usage yields no event at all, rather than an event carrying 0: the
		// loop treats a metering value as a real measurement, so a defaulted zero would
		// be indistinguishable from the gateway genuinely reporting a free request. A
		// usage the gateway really did send as 0 IS such a measurement and passes.
		if (usage == null) return null;
		return {
			metering: {
				unit: typeof data.unit === "string" ? data.unit : "credit",
				unitPlural: typeof data.unitPlural === "string" ? data.unitPlural : "credits",
				usage,
			},
		};
	}

	if (eventType === CONTEXT_USAGE_EVENT) {
		// Both spellings are accepted because the gateway forwards whichever the
		// upstream sent; see the same tolerance in NUG's own parser.
		const percentage =
			numberFrom(data.contextUsagePercentage) ?? numberFrom(data.context_usage_percentage);
		if (percentage == null) return null;
		return { contextUsagePercentage: percentage };
	}

	return null;
}

/**
 * Coerce a numeric field, rejecting values that would poison a measurement.
 *
 * A non-finite number is dropped rather than passed through: the loop divides by
 * and compares against these, so a NaN silently disables the context-headroom
 * calculation instead of failing visibly.
 */
function numberFrom(value: unknown): number | undefined {
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
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
		eventType === MODEL_CATALOG_EVENT ||
		eventType === IMAGE_CACHE_ACK_EVENT ||
		eventType === METERING_EVENT ||
		eventType === CONTEXT_USAGE_EVENT
	);
}
