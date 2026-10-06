import { createHash } from "node:crypto";

/**
 * NUG image dedup protocol (client side).
 *
 * Chat history accumulates base64-encoded images that are re-sent in full on
 * every turn, making request bodies grow without bound. To avoid this, the NUG
 * gateway content-addresses image payloads: any inline image it sees is cached
 * by the SHA-256 of its bytes, and the gateway confirms which refs are cached
 * by emitting an `imageCacheAckEvent`. Only once a ref has been acknowledged
 * may the client drop the inline payload and send the `imageRef` alone.
 *
 * Strategy (kept entirely inside NugProvider, no changes to the shared
 * Anthropic/OpenAI providers):
 *   - Every image gets an `imageRef` (its content hash) added so the gateway
 *     can cache/identify it.
 *   - If the ref is NOT yet confirmed cached, the inline payload is kept so the
 *     gateway can store it on this request and acknowledge it.
 *   - If the ref IS confirmed cached, the inline payload is stripped (sent as
 *     ref-only) and recorded so it can be restored afterwards.
 *
 * Because the agent loop reuses the same in-memory history array across turns
 * and retries, every payload that is temporarily stripped is recorded in the
 * returned `ImagePayloadMap`. The caller MUST restore those payloads once the
 * request attempt completes (success or failure), so the persistent history is
 * never left with empty image bytes. On a gateway cache miss (HTTP 409) the
 * caller also drops the affected refs from its confirmed set and retries inline.
 *
 * All functions here are NUG-specific and must only be used on the NUG path.
 */

const REF_PREFIX = "sha256:";

/** Records stripped history image payloads so they can be restored after the request. */
export type ImagePayloadMap = Map<string, string>;

/** A set of content refs the gateway has confirmed are cached. */
export type ConfirmedRefSet = Set<string>;

/**
 * Bounded insertion-ordered ref set used as a tiny LRU cache.
 * Re-adding an existing ref refreshes it to the newest position; adding beyond
 * maxSize evicts the oldest ref so long-running sessions do not grow unbounded.
 */
export class BoundedConfirmedRefSet extends Set<string> {
	private readonly maxSize: number;

	constructor(maxSize: number) {
		super();
		const normalizedMaxSize = Number.isFinite(maxSize) ? Math.floor(maxSize) : 1;
		this.maxSize = Math.max(1, normalizedMaxSize);
	}

	override add(value: string): this {
		if (!value) return this;
		if (this.has(value)) super.delete(value);
		super.add(value);
		while (this.size > this.maxSize) {
			const oldest = this.values().next().value;
			if (typeof oldest !== "string") break;
			super.delete(oldest);
		}
		return this;
	}
}

/**
 * Result of preparing history images for one request:
 *   - stripped: refs whose inline payload was removed (ref-only), with the
 *     original payload recorded so it can be restored afterwards.
 *   - present: refs whose inline payload was kept (sent in full this turn).
 */
export interface DedupResult {
	/** ref → original payload, for the images stripped to ref-only this turn. */
	stripped: ImagePayloadMap;
	/** refs sent with full inline payload this turn (gateway should cache + ack). */
	present: string[];
}

function newDedupResult(): DedupResult {
	return { stripped: new Map(), present: [] };
}

/** Compute the canonical content reference for a base64 payload. */
export function imageRefForBase64(base64: string): string {
	let buf: Buffer;
	try {
		buf = Buffer.from(base64, "base64");
	} catch {
		return "";
	}
	if (buf.length === 0) return "";
	return REF_PREFIX + createHash("sha256").update(buf).digest("hex");
}

/** Extract the base64 payload from a data URI ("data:<mime>;base64,<payload>"). */
function base64FromDataUri(s: string): string | null {
	const idx = s.indexOf(",");
	if (idx < 0) return null;
	const meta = s.slice(0, idx);
	if (!meta.includes(";base64")) return null;
	return s.slice(idx + 1);
}

// === OpenAI / Codex (Responses + Chat Completions) ===

interface OAIImagePart {
	type?: string;
	image_url?: string | { url?: string };
	imageRef?: string;
}

interface OAIMessageNode {
	role?: string;
	content?: unknown;
}

function oaiPartDataUri(part: OAIImagePart): string | null {
	if (part.type === "input_image" && typeof part.image_url === "string") {
		return part.image_url;
	}
	if (
		part.type === "image_url" &&
		part.image_url &&
		typeof part.image_url === "object" &&
		typeof part.image_url.url === "string"
	) {
		return part.image_url.url;
	}
	return null;
}

function oaiSetPartDataUri(part: OAIImagePart, value: string): void {
	if (part.type === "input_image") {
		part.image_url = value;
	} else if (part.type === "image_url" && part.image_url && typeof part.image_url === "object") {
		part.image_url.url = value;
	}
}

/**
 * Tag every image in a built OpenAI/Codex history with its `imageRef`, stripping
 * the inline payload only for confirmed-cached refs. Mutates the history in place.
 */
export function dedupOpenAIHistoryImages(
	history: unknown[],
	confirmed: ConfirmedRefSet,
): DedupResult {
	const result = newDedupResult();
	if (!Array.isArray(history)) return result;

	for (const msg of history) {
		const content = (msg as OAIMessageNode)?.content;
		if (!Array.isArray(content)) continue;
		for (const rawPart of content) {
			const part = rawPart as OAIImagePart;
			if (part.type !== "input_image" && part.type !== "image_url") continue;
			const uri = oaiPartDataUri(part);
			if (!uri) continue;
			const b64 = base64FromDataUri(uri);
			if (!b64) continue;
			const ref = imageRefForBase64(b64);
			if (!ref) continue;
			part.imageRef = ref;
			if (confirmed.has(ref)) {
				result.stripped.set(ref, uri);
				oaiSetPartDataUri(part, "");
			} else {
				result.present.push(ref);
			}
		}
	}
	return result;
}

/** Restore OpenAI history image payloads stripped for one request. */
export function restoreOpenAIHistoryImages(history: unknown[], payloads: ImagePayloadMap): void {
	if (!Array.isArray(history)) return;
	for (const msg of history) {
		const content = (msg as OAIMessageNode)?.content;
		if (!Array.isArray(content)) continue;
		for (const rawPart of content) {
			const part = rawPart as OAIImagePart;
			if (!part.imageRef) continue;
			const original = payloads.get(part.imageRef);
			if (original) oaiSetPartDataUri(part, original);
		}
	}
}

// === Anthropic (Messages API) ===

interface AnthropicImagePart {
	type?: string;
	source?: { type?: string; media_type?: string; data?: string };
	imageRef?: string;
}

interface AnthropicMessageNode {
	role?: string;
	content?: unknown;
}

/**
 * Tag every image in a built Anthropic history with its `imageRef`, stripping
 * the inline payload only for confirmed-cached refs. Mutates the history in place.
 *
 * Anthropic images look like:
 *   { type: "image", source: { type: "base64", media_type, data } }
 */
export function dedupAnthropicHistoryImages(
	history: unknown[],
	confirmed: ConfirmedRefSet,
): DedupResult {
	const result = newDedupResult();
	if (!Array.isArray(history)) return result;

	for (const msg of history) {
		const content = (msg as AnthropicMessageNode)?.content;
		if (!Array.isArray(content)) continue;
		for (const rawPart of content) {
			const part = rawPart as AnthropicImagePart;
			if (part.type !== "image" || !part.source) continue;
			const data = part.source.data;
			if (typeof data !== "string" || data.length === 0) continue;
			const ref = imageRefForBase64(data);
			if (!ref) continue;
			part.imageRef = ref;
			if (confirmed.has(ref)) {
				result.stripped.set(ref, data);
				part.source.data = "";
			} else {
				result.present.push(ref);
			}
		}
	}
	return result;
}

/** Restore Anthropic history image payloads stripped for one request. */
export function restoreAnthropicHistoryImages(history: unknown[], payloads: ImagePayloadMap): void {
	if (!Array.isArray(history)) return;
	for (const msg of history) {
		const content = (msg as AnthropicMessageNode)?.content;
		if (!Array.isArray(content)) continue;
		for (const rawPart of content) {
			const part = rawPart as AnthropicImagePart;
			if (!part.imageRef || !part.source) continue;
			const original = payloads.get(part.imageRef);
			if (original && (!part.source.data || part.source.data.length === 0)) {
				part.source.data = original;
			}
		}
	}
}

// === Error detection ===

/**
 * Whether an error from the NUG gateway is an image cache miss (HTTP 409).
 *
 * The OpenAI/Codex path surfaces only the extracted `error.message`
 * ("...not cached; resend them inline") rather than the raw `image_cache_miss`
 * code. Within NugProvider a 409 always originates from the NUG gateway, so the
 * status alone is a reliable signal.
 */
export function isImageCacheMissError(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	const e = err as { status?: number };
	return e.status === 409;
}
