/**
 * Bun's catch-all tag for a TLS handshake that failed with an X509 verify code
 * it could not attribute to a known certificate defect: `get_cert_error_from_no`
 * maps every recognized `X509_V_ERR_*` value to its own tag and falls through to
 * this one for everything else.
 *
 * That makes it categorically different from a real certificate problem. An
 * expired cert, a self-signed chain, a hostname mismatch or a missing local
 * issuer each arrive with their own specific code (`CERT_HAS_EXPIRED`,
 * `DEPTH_ZERO_SELF_SIGNED_CERT`, `HOSTNAME_MISMATCH`,
 * `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`, ...) and must keep failing fast — they
 * are configuration faults that no amount of retrying fixes. What lands on the
 * unknown tag is a handshake that was disturbed: a relay or proxy resetting
 * mid-handshake, a VPN/NAT rebinding the flow, an interception box dropping the
 * TLS session. Those are transient and recover on a fresh connection.
 */
export const TRANSIENT_TLS_HANDSHAKE_CODE = "UNKNOWN_CERTIFICATE_VERIFICATION_ERROR";

const MAX_CAUSE_DEPTH = 5;

/** Whether a transport error code is the replayable handshake tag. */
export function isTransientTlsHandshakeCode(code: unknown): boolean {
	return typeof code === "string" && code.trim().toUpperCase() === TRANSIENT_TLS_HANDSHAKE_CODE;
}

/**
 * Whether an error message carries the handshake tag. Needed because the code is
 * not always still attached by the time a failure is reclassified — the wrapped
 * `NetworkRequestError` message embeds it as `[tls/<code>]`, and some paths only
 * keep a message string.
 */
export function isTransientTlsHandshakeMessage(message: unknown): boolean {
	return (
		typeof message === "string" && message.toUpperCase().includes(TRANSIENT_TLS_HANDSHAKE_CODE)
	);
}

/**
 * Whether a thrown value represents a TLS handshake that failed for an
 * unattributable reason, walking a bounded cause chain.
 *
 * Callers may replay such a request regardless of HTTP method: the handshake
 * failed before a single request byte reached the peer, so a replay cannot
 * duplicate a side effect the way replaying a mid-flight POST could.
 */
export function isTransientTlsHandshakeError(error: unknown): boolean {
	let current = error;
	for (let depth = 0; current && typeof current === "object" && depth < MAX_CAUSE_DEPTH; depth++) {
		const value = current as { code?: unknown; message?: unknown; cause?: unknown };
		if (isTransientTlsHandshakeCode(value.code)) return true;
		if (isTransientTlsHandshakeMessage(value.message)) return true;
		if (!value.cause || value.cause === current) return false;
		current = value.cause;
	}
	return typeof error === "string" && isTransientTlsHandshakeMessage(error);
}
