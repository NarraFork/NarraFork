import { sha256 as nobleSHA256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export const STREAMING_EDIT_ORIGIN_MAX_CODE_UNITS = 2_097_152;
const SCRATCH_BYTES = 8 * 1024;

/** Fixed-size evidence, minted only by the server's successful local pre-match. */
export interface StreamingEditOrigin {
	toolUseId: string;
	filePath: string;
	device: string;
	replaceAll: boolean;
	oldFingerprint: string;
	startLine: number;
	endLine?: number;
	matchStatus: "matched";
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** CRLF → LF, but NOT isolated CR; encode UTF-16LE including unpaired surrogates. */
export function fingerprintStreamingEditOld(text: string): string | undefined {
	if (text.length > STREAMING_EDIT_ORIGIN_MAX_CODE_UNITS) return undefined;
	const hash = nobleSHA256.create();
	const scratch = new Uint8Array(SCRATCH_BYTES);
	let offset = 0;
	for (let i = 0; i < text.length; i++) {
		let unit = text.charCodeAt(i);
		if (unit === 13 && text.charCodeAt(i + 1) === 10) {
			unit = 10;
			i++;
		}
		scratch[offset++] = unit & 255;
		scratch[offset++] = unit >>> 8;
		if (offset === scratch.length) {
			hash.update(scratch);
			offset = 0;
		}
	}
	if (offset) hash.update(scratch.subarray(0, offset));
	return bytesToHex(hash.digest());
}

export function readStreamingEditOrigin(value: unknown): StreamingEditOrigin | undefined {
	if (
		!record(value) ||
		value.matchStatus !== "matched" ||
		typeof value.toolUseId !== "string" ||
		!value.toolUseId ||
		typeof value.filePath !== "string" ||
		!value.filePath ||
		value.device !== "local" ||
		typeof value.replaceAll !== "boolean" ||
		typeof value.oldFingerprint !== "string" ||
		!/^[0-9a-f]{64}$/.test(value.oldFingerprint) ||
		!Number.isSafeInteger(value.startLine) ||
		(value.startLine as number) < 1 ||
		(value.endLine !== undefined &&
			(!Number.isSafeInteger(value.endLine) ||
				(value.endLine as number) < (value.startLine as number)))
	)
		return undefined;
	return value as unknown as StreamingEditOrigin;
}

export function createStreamingEditOrigin(
	toolUseId: string,
	input: Record<string, unknown>,
	metadata: Record<string, unknown>,
	effectiveDevice = "local",
): StreamingEditOrigin | undefined {
	if (effectiveDevice !== "local" || typeof input.old_string !== "string" || !input.old_string)
		return undefined;
	const oldFingerprint = fingerprintStreamingEditOld(input.old_string);
	if (!oldFingerprint) return undefined;
	return readStreamingEditOrigin({
		toolUseId,
		filePath: input.file_path,
		device: input.device ?? effectiveDevice,
		replaceAll: input.replace_all === true,
		oldFingerprint,
		startLine: metadata.startLine,
		endLine: metadata.endLine,
		matchStatus: metadata.matchStatus,
	});
}

export function validateStreamingEditOrigin(
	value: unknown,
	toolUseId: string,
	input: unknown,
): StreamingEditOrigin | undefined {
	const origin = readStreamingEditOrigin(value);
	if (
		!origin ||
		!record(input) ||
		origin.toolUseId !== toolUseId ||
		origin.filePath !== input.file_path ||
		origin.device !== (input.device ?? "local") ||
		origin.replaceAll !== (input.replace_all === true) ||
		typeof input.old_string !== "string" ||
		!input.old_string
	)
		return undefined;
	return fingerprintStreamingEditOld(input.old_string) === origin.oldFingerprint
		? origin
		: undefined;
}

// Input metadata is NOT evidence: only dedicated server fields can enter this map.
// Metadata identity survives harmless shallow copies made by the row adapters.
const trustedMetadata = new WeakMap<object, StreamingEditOrigin>();
const validatedInputs = new WeakMap<
	object,
	{ origin?: StreamingEditOrigin; result: Record<string, unknown> }
>();

/** Copy display-only fields without making the render path validate/hash again. */
export function copyStreamingEditInput(
	input: Record<string, unknown>,
	fields: Record<string, unknown>,
): Record<string, unknown> {
	const result = { ...input, ...fields };
	const validated = validatedInputs.get(input);
	if (validated) {
		const unchanged =
			result.file_path === input.file_path &&
			result.old_string === input.old_string &&
			result.device === input.device &&
			result.replace_all === input.replace_all &&
			result._streamingMetadata === input._streamingMetadata;
		// Only display-only copies inherit validation. A late preview may not overwrite
		// the checked target/location or silently carry it onto another input.
		if (!unchanged) delete result._streamingMetadata;
		validatedInputs.set(result, { origin: unchanged ? validated.origin : undefined, result });
	}
	return result;
}

export function knownStreamingEditOrigin(input: unknown): StreamingEditOrigin | undefined {
	if (!record(input) || !record(input._streamingMetadata)) return undefined;
	return trustedMetadata.get(input._streamingMetadata);
}

/** Called on started/updatedInput, never on field deltas or rendering. */
export function handoffStreamingEditOrigin(
	toolUseId: string,
	incoming: unknown,
	serverEvidence?: unknown,
	previous?: unknown,
): unknown {
	if (!record(incoming)) return incoming;
	const evidence =
		serverEvidence !== undefined
			? readStreamingEditOrigin(serverEvidence)
			: (knownStreamingEditOrigin(incoming) ?? knownStreamingEditOrigin(previous));
	const cached = validatedInputs.get(incoming);
	// A handoff result is already checked, including a rejected origin. Cache merges
	// must not resurrect previous evidence after an explicitly failed handoff.
	if (
		serverEvidence === undefined &&
		cached?.result === incoming &&
		(!cached.origin || cached.origin.toolUseId === toolUseId)
	)
		return incoming;
	if (cached && cached.origin === evidence && (!evidence || evidence.toolUseId === toolUseId))
		return cached.result;
	const result = { ...incoming };
	delete result._streamingMetadata;
	delete result._streamingEditOrigin;
	const origin = validateStreamingEditOrigin(evidence, toolUseId, incoming);
	if (origin) {
		const metadata = {
			startLine: origin.startLine,
			endLine: origin.endLine,
			matchStatus: "matched",
		};
		trustedMetadata.set(metadata, origin);
		result._streamingMetadata = metadata;
	}
	validatedInputs.set(incoming, { origin: evidence, result });
	validatedInputs.set(result, { origin: evidence, result });
	return result;
}
