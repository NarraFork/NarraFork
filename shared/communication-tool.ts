/**
 * Reserved selectors a subagent can use to address the narrator that launched
 * it (its parent). Matched case-insensitively before sibling alias resolution.
 */
export const PARENT_SELECTORS = new Set(["parent", "main", "@parent", "@main"]);

export function isParentSelector(selector: string): boolean {
	return PARENT_SELECTORS.has(selector.trim().toLowerCase());
}

/** Communication is conversation content, never a foldable activity/tool row. */
export function isCommunicationTool(tool: { toolName: string; inputJson?: unknown }): boolean {
	if (tool.toolName === "Send") return true;
	if (tool.toolName !== "TeamStatus") return false;
	const input = objectValue(tool.inputJson);
	const settled = objectValue(input._streamingFields);
	const action =
		input._streamingFieldName === "action" && Object.hasOwn(input, "_streamingFieldValue")
			? input._streamingFieldValue
			: Object.hasOwn(settled, "action")
				? settled.action
				: input.action;
	return action === "send" || action === "broadcast";
}

/** Inline parsing budget, shared by the adapter and defensive measure entry point. */
export const COMMUNICATION_PREVIEW_MAX_CHARS = 8 * 1024;
export const COMMUNICATION_PREVIEW_MAX_LINES = 120;

/**
 * Keep a bounded prefix without splitting the full input into lines. At most 8Ki
 * UTF-16 code units are scanned, including for a multi-megabyte single-line input.
 * CRLF is one line boundary; lone CR and LF each count as one boundary.
 */
export function limitCommunicationPreview(text: string): { text: string; truncated: boolean } {
	let end = Math.min(text.length, COMMUNICATION_PREVIEW_MAX_CHARS);
	let lines = 1;
	for (let index = 0; index < end; index++) {
		const char = text.charCodeAt(index);
		if (char !== 10 && char !== 13) continue;
		if (lines === COMMUNICATION_PREVIEW_MAX_LINES) {
			end = index;
			break;
		}
		lines++;
		if (char === 13 && text.charCodeAt(index + 1) === 10) index++;
	}
	// Do not leave a replacement glyph at a character-budget boundary in an emoji.
	if (end < text.length && end > 0) {
		const last = text.charCodeAt(end - 1);
		if (last >= 0xd800 && last <= 0xdbff) end--;
	}
	return { text: text.slice(0, end), truncated: end < text.length };
}

/** A reserved delivery, optionally enriched by the recipient's actual consumption. */
export interface SendDeliveryTarget {
	id: string;
	deliveryMessageId?: string;
	deliveryId?: string;
	recipientRefId?: string;
	revision?: number;
	receiptDisposition?: "active" | "superseded" | "recipient_deleted";
	title?: string | null;
	injectionConsumedAt?: string;
}

/** Live receipt frames always carry the exact reserved delivery identity. */
export interface SendDeliveryReceipt extends SendDeliveryTarget {
	deliveryMessageId: string;
}

/** Preserve consumption facts across older navigation-only snapshots. */
export function mergeSendDeliveryTargets(
	existing: readonly SendDeliveryTarget[],
	incoming: readonly SendDeliveryTarget[],
	matchingReceiptsOnly = false,
): SendDeliveryTarget[] {
	const targets = new Map<string, SendDeliveryTarget>();
	for (const target of existing) targets.set(target.id, target);
	for (const target of incoming) {
		if (typeof target?.id !== "string" || !target.id.trim()) continue;
		const prior = targets.get(target.id);
		const receipt =
			typeof target.deliveryMessageId === "string" && target.deliveryMessageId.trim()
				? target.deliveryMessageId
				: undefined;
		const sameStableDelivery = !!target.deliveryId && prior?.deliveryId === target.deliveryId;
		if (sameStableDelivery && (target.revision ?? 1) < (prior?.revision ?? 1)) continue;
		const sameReceipt = sameStableDelivery
			? (prior?.revision ?? 1) === (target.revision ?? 1)
			: !target.deliveryId &&
				!prior?.deliveryId &&
				!!receipt &&
				prior?.deliveryMessageId === receipt;
		// An old navigation snapshot can enrich a stable receipt, never downgrade its identity.
		const legacyMatchesStable =
			!target.deliveryId && !!prior?.deliveryId && !!receipt && prior.deliveryMessageId === receipt;
		if (matchingReceiptsOnly && !sameReceipt && !legacyMatchesStable) continue;
		const title =
			typeof target.title === "string" && target.title.trim()
				? target.title
				: (prior?.title ?? target.title);
		const preservePriorReceipt =
			sameReceipt || legacyMatchesStable || (!receipt && !target.deliveryId);
		const injectionConsumedAt =
			(preservePriorReceipt ? prior?.injectionConsumedAt : undefined) ||
			(receipt &&
			typeof target.injectionConsumedAt === "string" &&
			target.injectionConsumedAt.trim()
				? target.injectionConsumedAt
				: undefined);
		const receiptDisposition =
			preservePriorReceipt && prior?.receiptDisposition === "recipient_deleted"
				? "recipient_deleted"
				: preservePriorReceipt &&
						prior?.receiptDisposition === "superseded" &&
						target.receiptDisposition === "active"
					? "superseded"
					: (target.receiptDisposition ??
						(preservePriorReceipt ? prior?.receiptDisposition : undefined));
		const deliveryMessageId = receipt ?? prior?.deliveryMessageId;
		targets.set(target.id, {
			id: target.id,
			...((target.deliveryId ? target : legacyMatchesStable || !receipt ? prior : undefined)
				?.deliveryId
				? {
						deliveryId: target.deliveryId ?? prior?.deliveryId,
						recipientRefId:
							target.recipientRefId ??
							(sameReceipt || legacyMatchesStable || !receipt ? prior?.recipientRefId : undefined),
						revision:
							target.revision ??
							(sameReceipt || legacyMatchesStable || !receipt ? prior?.revision : 1),
						receiptDisposition,
					}
				: {}),
			...(deliveryMessageId ? { deliveryMessageId } : {}),
			...(title !== undefined ? { title } : {}),
			...(injectionConsumedAt ? { injectionConsumedAt } : {}),
		});
	}
	return [...targets.values()];
}

/** Read already-known receipts without parsing tool output text or changing its final status. */
export function knownSendDeliveryTargets(tool: {
	_metadata?: unknown;
	outputJson?: unknown;
	_sendDeliveryTargets?: unknown;
}): SendDeliveryTarget[] {
	const metadata = objectValue(tool._metadata);
	const outputMetadata = objectValue(objectValue(tool.outputJson)._metadata);
	const finalTargets = Array.isArray(metadata.targets) ? metadata.targets : outputMetadata.targets;
	const runtime = Array.isArray(tool._sendDeliveryTargets) ? tool._sendDeliveryTargets : [];
	// Final metadata owns receipt identity; a stale runtime receipt cannot replace it.
	const known = mergeSendDeliveryTargets(
		mergeSendDeliveryTargets([], runtime),
		Array.isArray(finalTargets) ? finalTargets : [],
	);
	return mergeSendDeliveryTargets(known, runtime, true);
}

/** A partial fanout receipt must never shrink the known recipient denominator. */
export function mergeSendDeliveryTargetCount(
	existing: number | undefined,
	incoming: number | undefined,
): number | undefined {
	const counts = [existing, incoming].filter(
		(value): value is number =>
			typeof value === "number" && Number.isSafeInteger(value) && value > 0,
	);
	return counts.length ? Math.max(...counts) : undefined;
}

function objectValue(value: unknown): Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}
