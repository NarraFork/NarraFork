/**
 * Whether a model's reasoning blocks carry server-bound credentials.
 *
 * Two model families mint reasoning replay credentials that only the upstream
 * that produced them can verify: Anthropic's `thinking.signature` and OpenAI's
 * `reasoning.encrypted_content`. For those models an uncredentialed reasoning
 * block is unreplayable — it must be dropped rather than echoed back, and the
 * credential dies as soon as the request is routed to a different upstream.
 *
 * Every other model (DeepSeek, GLM, Kimi, MiniMax, Qwen, Mimo, ...) emits
 * plain-text reasoning with no credential protocol at all. Their relays accept
 * the text back as-is, and most perform measurably better when it is echoed —
 * so the text is always preserved, with an empty signature where the wire
 * schema demands one.
 */

import { bareModelForEffort, parseClaudeModel } from "./reasoning-effort-support";

/**
 * OpenAI's own model ids: `gpt-*`, the o-series reasoners (`o1`, `o3`, `o4-mini`,
 * ...), and `chatgpt-*` aliases. All of them bind `encrypted_content` to the
 * OpenAI Responses backend that minted it.
 *
 * `o\d+` rather than `o\d` so a future two-digit o-series id (`o12`) classifies
 * with its family instead of falling through to the relay branch, where its
 * signed reasoning would be echoed back as plain text.
 */
const OPENAI_OFFICIAL_PATTERN = /^(?:gpt|o\d+|chatgpt)[-_.]?/i;

/**
 * Whether this model's reasoning is credential-bound (strict retention rules).
 *
 * Callers strip the `provider:` prefix first (`parseModelId`); a remaining NUG
 * channel segment is stripped here (`bareModelForEffort`) so a
 * `anthropic:GLM-5.1` residue cannot flip the classification.
 *
 * True for every Claude family (sonnet/opus/haiku/fable/mythos — including old
 * generations, which never emit thinking blocks anyway, so the strict path is a
 * no-op there) and for OpenAI's gpt/o-series/chatgpt ids. False for everything
 * else, including DeepSeek.
 */
export function hasCredentialBoundReasoning(model: string): boolean {
	const bare = bareModelForEffort(model);
	if (!bare) return false;
	if (parseClaudeModel(bare) != null) return true;
	return OPENAI_OFFICIAL_PATTERN.test(bare);
}
