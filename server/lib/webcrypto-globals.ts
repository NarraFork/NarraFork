/**
 * Expose the WebCrypto interface constructors as globals when the runtime omits them.
 *
 * Why this exists
 * ---------------
 * Cottontail 0.2.3 (Electrobun's main-process runtime) implements `crypto.subtle` correctly —
 * `importKey()` and `sign()` both work and produce correct output — but does not define the
 * `CryptoKey` and `SubtleCrypto` *interface objects* as globals. Any `instanceof CryptoKey`
 * check therefore throws:
 *
 *     TypeError: Right hand side of instanceof is not an object
 *
 * Hono's JWT implementation guards on `key instanceof CryptoKey` (`hono/utils/jwt/jws`), so
 * every token signing call fails and all authentication breaks. The WHATWG WebCrypto spec
 * requires these interface objects to be exposed on the global scope, so this is a runtime
 * conformance gap rather than something callers should work around individually.
 *
 * The instances carry the right constructors even though the globals are missing, so we
 * recover each constructor from a real instance rather than substituting a stand-in class.
 * That keeps `instanceof` semantically accurate: it still tests the genuine internal class,
 * so a non-key value is correctly rejected.
 *
 * This is a no-op on runtimes that already conform (Bun, Node, browsers).
 */

import { logger } from "./logger";

/** Interface objects the WebCrypto spec requires on the global scope. */
type WebCryptoGlobals = {
	CryptoKey?: unknown;
	SubtleCrypto?: unknown;
	crypto?: Crypto;
};

let installed = false;

/**
 * Install missing WebCrypto interface objects.
 *
 * Must run before any consumer of WebCrypto loads — call it at the very start of startup.
 * Safe to call more than once; only the first call does work.
 */
export async function installWebCryptoGlobals(): Promise<void> {
	if (installed) return;
	installed = true;

	const globals = globalThis as WebCryptoGlobals;
	const subtle = globals.crypto?.subtle;

	// Without crypto.subtle there is nothing to recover constructors from, and nothing we
	// could substitute would behave correctly. Leave the environment untouched so the
	// eventual failure names the real missing capability.
	if (!subtle) return;

	const missing: string[] = [];

	if (typeof globals.SubtleCrypto === "undefined") {
		globals.SubtleCrypto = subtle.constructor;
		missing.push("SubtleCrypto");
	}

	if (typeof globals.CryptoKey === "undefined") {
		try {
			// Import a throwaway HMAC key purely to read its constructor. HMAC/SHA-256 is the
			// most broadly supported algorithm, and the key material never leaves this function.
			const probeKey = await subtle.importKey(
				"raw",
				new Uint8Array(32),
				{ name: "HMAC", hash: "SHA-256" },
				false,
				["sign"],
			);
			globals.CryptoKey = probeKey.constructor;
			missing.push("CryptoKey");
		} catch (err) {
			// Leave CryptoKey undefined rather than installing a fake: a wrong constructor would
			// make `instanceof` silently misclassify keys, which is worse than a clear failure.
			logger.warn("Could not recover the CryptoKey constructor for this runtime", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	if (missing.length > 0) {
		logger.info("Installed missing WebCrypto interface objects", { globals: missing });
	}
}
