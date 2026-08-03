import { describe, expect, test } from "bun:test";
import {
	isTransientTlsHandshakeCode,
	isTransientTlsHandshakeError,
	isTransientTlsHandshakeMessage,
	TRANSIENT_TLS_HANDSHAKE_CODE,
} from "../tls-transport-error";

/**
 * Every code here is a real Bun/BoringSSL tag for an attributable certificate
 * defect (see `get_cert_error_from_no`). They describe a misconfiguration and
 * must never be classified as transient — retrying only delays the real error.
 */
const DETERMINISTIC_CERT_CODES = [
	"CERT_HAS_EXPIRED",
	"CERT_NOT_YET_VALID",
	"DEPTH_ZERO_SELF_SIGNED_CERT",
	"SELF_SIGNED_CERT_IN_CHAIN",
	"UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
	"UNABLE_TO_VERIFY_LEAF_SIGNATURE",
	"HOSTNAME_MISMATCH",
	"ERR_TLS_CERT_ALTNAME_INVALID",
	"CERT_REVOKED",
	"CERT_UNTRUSTED",
];

describe("transient TLS handshake classification", () => {
	test("recognizes the unattributable handshake code", () => {
		expect(isTransientTlsHandshakeCode(TRANSIENT_TLS_HANDSHAKE_CODE)).toBe(true);
		expect(isTransientTlsHandshakeCode("unknown_certificate_verification_error")).toBe(true);
		expect(isTransientTlsHandshakeCode(" UNKNOWN_CERTIFICATE_VERIFICATION_ERROR ")).toBe(true);
	});

	test("rejects attributable certificate defects", () => {
		for (const code of DETERMINISTIC_CERT_CODES) {
			expect(isTransientTlsHandshakeCode(code)).toBe(false);
			expect(isTransientTlsHandshakeError(Object.assign(new Error("tls"), { code }))).toBe(false);
		}
	});

	test("rejects non-string and empty codes", () => {
		for (const code of [undefined, null, 0, 500, {}, []]) {
			expect(isTransientTlsHandshakeCode(code)).toBe(false);
		}
		expect(isTransientTlsHandshakeError(undefined)).toBe(false);
		expect(isTransientTlsHandshakeError(null)).toBe(false);
		expect(isTransientTlsHandshakeError("")).toBe(false);
	});

	test("detects the code inside a wrapped network error message", () => {
		const message =
			"Network request failed [tls/UNKNOWN_CERTIFICATE_VERIFICATION_ERROR] after 15571 ms: " +
		expect(isTransientTlsHandshakeMessage(message)).toBe(true);
		expect(isTransientTlsHandshakeError(new Error(message))).toBe(true);
		expect(isTransientTlsHandshakeError(message)).toBe(true);
	});

	test("walks a nested cause chain", () => {
		const root = Object.assign(new Error("handshake failed"), {
			code: TRANSIENT_TLS_HANDSHAKE_CODE,
		});
		const wrapped = new Error("provider request failed", {
			cause: new Error("transport failed", { cause: root }),
		});
		expect(isTransientTlsHandshakeError(wrapped)).toBe(true);
	});

	test("survives a self-referential cause without looping", () => {
		const looped = new Error("looped") as Error & { cause?: unknown };
		looped.cause = looped;
		expect(isTransientTlsHandshakeError(looped)).toBe(false);
	});

	test("stops before an unbounded cause chain", () => {
		let deepest: Error & { cause?: unknown } = Object.assign(new Error("handshake"), {
			code: TRANSIENT_TLS_HANDSHAKE_CODE,
		});
		for (let i = 0; i < 20; i++) {
			deepest = new Error(`layer ${i}`, { cause: deepest });
		}
		expect(isTransientTlsHandshakeError(deepest)).toBe(false);
	});
});
