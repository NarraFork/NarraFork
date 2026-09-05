/**
 * Thinking-signature (and encrypted-content) source identity.
 *
 * Credential-bound models — the Claude families via `thinking.signature`, the
 * OpenAI gpt/o-series via `reasoning.encrypted_content` — return a credential
 * on their reasoning blocks. That credential is minted by a specific upstream
 * server and MUST only be echoed back to that same server on subsequent turns:
 * replaying it to a different server fails verification and the request is
 * rejected.
 *
 * Relay models (DeepSeek, GLM, Kimi, ...) mint no credentials at all; their
 * plain-text reasoning crosses upstreams freely and this module plays no part
 * in their retention path.
 *
 * The tricky case is NUG: several NUG channels share the same `channelType`
 * and therefore the same replay/protocol path, but each `channel`
 * (e.g. "antigravity", "channel-a") is a *different* upstream server, so their
 * signatures are NOT interchangeable. We therefore identify a signature's
 * origin with a stable `provider:channel` string (the "reasoning source key")
 * and only echo a stored signature when its source matches the source of the
 * provider that will handle the next request.
 *
 * The key is persisted on the reasoning block as
 * `providerMetadata.signatureSource`. Older messages predate this field and
 * carry no source; see {@link signatureSourcesCompatible} for that case.
 */

/** A stable identity for the upstream that minted a reasoning credential. */
export type ReasoningSourceKey = string;

/**
 * Decide whether a stored signature (minted by `stored`) may be echoed back to
 * the upstream identified by `current`.
 *
 * - Both present and equal → compatible (same server).
 * - Different → incompatible (cross-server, would fail verification).
 * - `stored` missing (legacy messages persisted before signatureSource
 *   existed) → treated as INCOMPATIBLE. Echoing a cross-server signature causes
 *   a hard request failure, so we choose the safe side.
 * - `current` missing (provider does not expose a source, or does not mint
 *   signatures) → treated as INCOMPATIBLE for the same reason: we cannot prove
 *   the signature belongs to this upstream.
 *
 * "Incompatible" does NOT mean "replay the text with a blank signature". There is
 * no unsigned thinking wire form on the Anthropic path: the official API rejects
 * an empty or foreign signature with `Invalid \`signature\` in \`thinking\` block`,
 * and the block sits in replayed history so the failure repeats every turn. A
 * caller that cannot prove ownership of the signature must drop the whole block —
 * Anthropic's own replay rule for a model change is "drop them silently". See
 * `dropUnreplayableThinkingBlocks` in the Anthropic provider for the enforcement.
 *
 * This check only applies to credential-bound models. Relay models skip it
 * entirely (see `hasCredentialBoundReasoning`): an absent signature there is
 * legal wire shape, not an ownership failure.
 */
export function signatureSourcesCompatible(
	stored: ReasoningSourceKey | undefined | null,
	current: ReasoningSourceKey | undefined | null,
): boolean {
	if (!stored || !current) return false;
	return stored === current;
}
