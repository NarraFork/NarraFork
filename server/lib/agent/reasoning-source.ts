/**
 * Thinking-signature source identity.
 *
 * Anthropic-family models return a `signature` (and optionally a base64
 * `redactedContent` block) on their thinking blocks. That signature is minted
 * by a specific upstream server and MUST only be echoed back to that same
 * server on subsequent turns — replaying a signature to a different server
 * fails signature verification and the request is rejected.
 *
 * The tricky case is NUG: several NUG channels share the same `channelType`
 * signatures are NOT interchangeable. We therefore identify a signature's
 * origin with a stable `provider:channel` string (the "reasoning source key")
 * and only echo a stored signature when its source matches the source of the
 * provider that will handle the next request.
 *
 * The key is persisted on the reasoning block as
 * `providerMetadata.signatureSource`. Older messages predate this field and
 * carry no source; see {@link signatureSourcesCompatible} for that case.
 */

/** A stable identity for the upstream that minted a thinking signature. */
export type ReasoningSourceKey = string;

/**
 * Decide whether a stored signature (minted by `stored`) may be echoed back to
 * the upstream identified by `current`.
 *
 * - Both present and equal → compatible (same server).
 * - Different → incompatible (cross-server, would fail verification).
 * - `stored` missing (legacy messages persisted before signatureSource
 *   existed) → treated as INCOMPATIBLE. Dropping a possibly-valid signature
 *   only costs a little thinking continuity (the text is still replayed as an
 *   unsigned thinking block, which upstreams accept), whereas echoing a
 *   cross-server signature causes a hard request failure. We choose the safe
 *   side.
 * - `current` missing (provider does not expose a source, or does not mint
 *   signatures) → treated as INCOMPATIBLE for the same reason: we cannot prove
 *   the signature belongs to this upstream.
 */
export function signatureSourcesCompatible(
	stored: ReasoningSourceKey | undefined | null,
	current: ReasoningSourceKey | undefined | null,
): boolean {
	if (!stored || !current) return false;
	return stored === current;
}
