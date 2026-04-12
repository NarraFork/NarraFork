import { createHash } from "node:crypto";
import { APP_VERSION } from "./version";

/**
 * Hardcoded salt from backend validation.
 * Must match exactly for fingerprint validation to pass.
 */
export const FINGERPRINT_SALT = "59cf53e54c78";

/**
 * Computes 3-character fingerprint for Claude Code attribution.
 * Algorithm: SHA256(SALT + msg[4] + msg[7] + msg[20] + version)[:3]
 *
 * IMPORTANT: Do not change this method without careful coordination with
 * 1P and 3P (Bedrock, Vertex, Azure) APIs.
 *
 * @param messageText - First user message text content
 * @param version - Version string (defaults to APP_VERSION)
 * @returns 3-character hex fingerprint
 */
export function computeFingerprint(messageText: string, version?: string): string {
	// Extract chars at indices [4, 7, 20], use "0" if index not found
	const indices = [4, 7, 20];
	const chars = indices.map((i) => messageText[i] || "0").join("");

	const fingerprintInput = `${FINGERPRINT_SALT}${chars}${version ?? APP_VERSION}`;

	// SHA256 hash, return first 3 hex chars
	const hash = createHash("sha256").update(fingerprintInput).digest("hex");
	return hash.slice(0, 3);
}

/**
 * Extract text content from the first user message in the history.
 * Handles both string content and content blocks array format.
 *
 * @param messages - Array of messages (DbMessage format)
 * @returns First user message text, or empty string if not found
 */
export function extractFirstUserMessageText(
	messages: Array<{ role: string; contentJson: unknown }>,
): string {
	const firstUserMessage = messages.find((msg) => msg.role === "user");
	if (!firstUserMessage) {
		return "";
	}

	const content = firstUserMessage.contentJson;

	// Handle string content
	if (typeof content === "string") {
		return content;
	}

	// Handle content blocks array
	if (Array.isArray(content)) {
		for (const block of content) {
			if (
				typeof block === "object" &&
				block !== null &&
				"type" in block &&
				block.type === "text" &&
				"text" in block &&
				typeof block.text === "string"
			) {
				return block.text;
			}
		}
	}

	return "";
}

/**
 * Computes fingerprint from a message history.
 * Uses the first user message text content.
 *
 * @param messages - Array of messages
 * @param version - Version string (defaults to APP_VERSION)
 * @returns 3-character hex fingerprint
 */
export function computeFingerprintFromMessages(
	messages: Array<{ role: string; contentJson: unknown }>,
	version?: string,
): string {
	const firstMessageText = extractFirstUserMessageText(messages);
	return computeFingerprint(firstMessageText, version);
}
