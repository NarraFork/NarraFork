/**
 * Generate a strong random password for an admin-created account.
 *
 * Uses `crypto.getRandomValues` rather than `Math.random`, and rejects sampled
 * bytes outside a whole number of alphabet cycles so every character stays
 * equally likely (naive modulo would bias the first few characters).
 *
 * The alphabet omits look-alike characters (0/O, 1/l/I) because these passwords
 * get read out loud or copied from a chat message at least once.
 */
const ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%^&*-_=+";
const DEFAULT_LENGTH = 20;

export function generateRandomPassword(length = DEFAULT_LENGTH): string {
	const max = Math.floor(256 / ALPHABET.length) * ALPHABET.length;
	const out: string[] = [];
	const buffer = new Uint8Array(length * 2);
	while (out.length < length) {
		crypto.getRandomValues(buffer);
		for (const byte of buffer) {
			if (out.length >= length) break;
			if (byte >= max) continue;
			out.push(ALPHABET[byte % ALPHABET.length]);
		}
	}
	return out.join("");
}
