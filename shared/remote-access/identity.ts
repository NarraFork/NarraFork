const encoder = new TextEncoder();
const HEX = /^[0-9a-f]*$/;
const DOMAIN = encoder.encode("narrafork-remote-v1\0");

export function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function unhex(value: string): Uint8Array<ArrayBuffer> {
	if (value.length % 2 !== 0 || !HEX.test(value)) throw new Error("INVALID_HEX");
	return Uint8Array.from(value.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
	const bytes = typeof value === "string" ? encoder.encode(value) : Uint8Array.from(value);
	return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

export async function instanceId(publicKey: string): Promise<string> {
	const bytes = unhex(publicKey);
	if (bytes.byteLength !== 65 || bytes[0] !== 4) throw new Error("INVALID_PUBLIC_KEY");
	// Import validates that the SEC1 point belongs to P-256, not merely its encoding.
	await crypto.subtle.importKey("raw", bytes, { name: "ECDSA", namedCurve: "P-256" }, false, [
		"verify",
	]);
	const digest = unhex(await sha256Hex(bytes));
	const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
	let result = "";
	let accumulator = 0;
	let bits = 0;
	for (const byte of digest) {
		accumulator = (accumulator << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			bits -= 5;
			result += alphabet[(accumulator >>> bits) & 31];
		}
	}
	if (bits > 0) result += alphabet[(accumulator << (5 - bits)) & 31];
	return result;
}

/** Domain-separated, unambiguous UTF-8 byte-length-prefixed signing input. */
export function transcript(label: string, fields: readonly string[]): Uint8Array<ArrayBuffer> {
	const parts = [label, ...fields].map((field) => encoder.encode(field));
	const length = DOMAIN.byteLength + parts.reduce((sum, part) => sum + 4 + part.byteLength, 0);
	if (length > 96 * 1024) throw new Error("TRANSCRIPT_TOO_LARGE");
	const result = new Uint8Array(length);
	result.set(DOMAIN);
	const view = new DataView(result.buffer);
	let offset = DOMAIN.byteLength;
	for (const part of parts) {
		view.setUint32(offset, part.byteLength, false);
		offset += 4;
		result.set(part, offset);
		offset += part.byteLength;
	}
	return result;
}

export async function generateIdentity(): Promise<{ publicKey: string; privateKey: CryptoKey }> {
	const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
		"sign",
		"verify",
	]);
	return {
		publicKey: hex(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))),
		privateKey: pair.privateKey,
	};
}

export async function sign(
	privateKey: CryptoKey,
	label: string,
	fields: readonly string[],
): Promise<string> {
	return hex(
		new Uint8Array(
			await crypto.subtle.sign(
				{ name: "ECDSA", hash: "SHA-256" },
				privateKey,
				transcript(label, fields),
			),
		),
	);
}

export async function verify(
	publicKey: string,
	signature: string,
	label: string,
	fields: readonly string[],
): Promise<boolean> {
	try {
		const bytes = unhex(publicKey);
		const signatureBytes = unhex(signature);
		if (bytes.byteLength !== 65 || bytes[0] !== 4 || signatureBytes.byteLength !== 64) return false;
		const key = await crypto.subtle.importKey(
			"raw",
			bytes,
			{ name: "ECDSA", namedCurve: "P-256" },
			false,
			["verify"],
		);
		return await crypto.subtle.verify(
			{ name: "ECDSA", hash: "SHA-256" },
			key,
			signatureBytes,
			transcript(label, fields),
		);
	} catch {
		return false;
	}
}
