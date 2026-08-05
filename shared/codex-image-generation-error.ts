/**
 * codex-image-generation-error.ts — recognize "this upstream refuses the native
 * image_generation tool" failures so the UI can offer a one-click fix.
 *
 * Some Codex-protocol relays and org accounts do not license OpenAI's
 * server-side `image_generation` tool. NarraFork injects that tool by default
 * (`appendCodexNativeTools`), so on such an upstream EVERY turn dies with
 *
 *   OpenAI API error 403: Image generation is not enabled for this group
 *
 * before the model produces a single token. The setting that fixes it
 * (`codexImageGeneration` per custom provider, `codex.useImageGeneration` for
 * the built-in Codex adapter) lives several clicks away in provider settings,
 * and nothing in the error text says so — the user just sees the same red card
 * on every retry.
 *
 * Matching is deliberately NARROW: only a 403-shaped refusal that names image
 * generation. A generic 403 (bad key, exhausted quota) must not offer to
 * silently disable a feature that was not the cause.
 */

/**
 * Phrases upstreams use for this refusal. All are matched case-insensitively
 * against the error text with the display prefix already stripped.
 *
 * `image generation is not enabled` is the observed ChatGPT/Codex gateway
 * wording; the others cover relays that reword it while still naming the tool.
 */
const IMAGE_GENERATION_REFUSAL_PATTERNS: readonly RegExp[] = [
	/image[_ ]generation is not (?:enabled|allowed|available|supported|permitted)/i,
	/image[_ ]generation.{0,40}\b(?:not enabled|not allowed|disabled|forbidden|unauthorized)\b/i,
	/\b(?:not enabled|not allowed|disabled|forbidden|unauthorized)\b.{0,40}image[_ ]generation/i,
	/unsupported tool.{0,40}image[_ ]generation/i,
	/image[_ ]generation.{0,40}unsupported tool/i,
];

/**
 * A 403 (or its named equivalent) somewhere in the message. Providers format
 * this as `OpenAI API error 403: …`, `status 403`, `HTTP 403`, or a bare
 * `permission_denied` / `insufficient_permissions` code, so all are accepted.
 */
const FORBIDDEN_STATUS_PATTERN =
	/\b403\b|\bpermission[_ ]denied\b|\binsufficient[_ ]permissions\b|\bforbidden\b/i;

/**
 * Whether an error message is the "upstream refuses image_generation" failure,
 * i.e. turning the tool off for that provider is the correct fix.
 *
 * Requires BOTH a forbidden-status marker and an explicit image-generation
 * refusal phrase: the status alone is any permission error, and the phrase alone
 * could appear in unrelated prose (a user pasting docs, a model explaining the
 * limitation).
 */
export function isCodexImageGenerationDisabledError(message: string | null | undefined): boolean {
	const value = message?.trim();
	if (!value) return false;
	if (!FORBIDDEN_STATUS_PATTERN.test(value)) return false;
	return IMAGE_GENERATION_REFUSAL_PATTERNS.some((pattern) => pattern.test(value));
}
