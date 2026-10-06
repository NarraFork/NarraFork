import { base64UrlDecode, base64UrlEncode, canonicalJson, utf8Bytes } from "./protocol";

const NETWORK_ID_INFO = "narrafork-vnet-network-id-v1";
const PACKET_KEY_INFO = "narrafork-vnet-packet-key-v1";
const HMAC_KEY_INFO = "narrafork-vnet-hmac-key-v1";

export type VNetPacketKey = CryptoKey;
export type VNetHmacKey = CryptoKey;

function secretBytes(secret: string | Uint8Array): Uint8Array {
	return typeof secret === "string" ? utf8Bytes(secret) : secret;
}

function bufferSource(value: Uint8Array): BufferSource {
	return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

async function importHkdfKey(secret: string | Uint8Array): Promise<CryptoKey> {
	return crypto.subtle.importKey("raw", bufferSource(secretBytes(secret)), "HKDF", false, [
		"deriveBits",
		"deriveKey",
	]);
}

export async function deriveNetworkId(networkName: string, networkSecret: string): Promise<string> {
	const key = await importHmacKey(networkSecret);
	const bytes = await crypto.subtle.sign(
		"HMAC",
		key,
		bufferSource(utf8Bytes(`${NETWORK_ID_INFO}:${networkName}`)),
	);
	return base64UrlEncode(new Uint8Array(bytes).slice(0, 18));
}

export async function derivePacketKey(
	networkSecret: string,
	networkName: string,
): Promise<VNetPacketKey> {
	const baseKey = await importHkdfKey(networkSecret);
	return crypto.subtle.deriveKey(
		{
			name: "HKDF",
			hash: "SHA-256",
			salt: bufferSource(utf8Bytes(networkName)),
			info: bufferSource(utf8Bytes(PACKET_KEY_INFO)),
		},
		baseKey,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
}

export async function deriveHmacKey(
	networkSecret: string,
	networkName: string,
): Promise<VNetHmacKey> {
	const baseKey = await importHkdfKey(networkSecret);
	return crypto.subtle.deriveKey(
		{
			name: "HKDF",
			hash: "SHA-256",
			salt: bufferSource(utf8Bytes(networkName)),
			info: bufferSource(utf8Bytes(HMAC_KEY_INFO)),
		},
		baseKey,
		{ name: "HMAC", hash: "SHA-256", length: 256 },
		false,
		["sign", "verify"],
	);
}

export async function importHmacKey(secret: string | Uint8Array): Promise<VNetHmacKey> {
	return crypto.subtle.importKey(
		"raw",
		bufferSource(secretBytes(secret)),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
}

export async function hmacSha256(
	keyOrSecret: VNetHmacKey | string | Uint8Array,
	data: string | Uint8Array,
): Promise<string> {
	const key = keyOrSecret instanceof CryptoKey ? keyOrSecret : await importHmacKey(keyOrSecret);
	const bytes = typeof data === "string" ? utf8Bytes(data) : data;
	const signature = await crypto.subtle.sign("HMAC", key, bufferSource(bytes));
	return base64UrlEncode(signature);
}

export async function verifyHmac(
	keyOrSecret: VNetHmacKey | string | Uint8Array,
	data: string | Uint8Array,
	tag: string,
): Promise<boolean> {
	try {
		const key = keyOrSecret instanceof CryptoKey ? keyOrSecret : await importHmacKey(keyOrSecret);
		const bytes = typeof data === "string" ? utf8Bytes(data) : data;
		return crypto.subtle.verify(
			"HMAC",
			key,
			bufferSource(base64UrlDecode(tag)),
			bufferSource(bytes),
		);
	} catch {
		return false;
	}
}

export async function encryptPacket(
	key: VNetPacketKey,
	metadata: unknown,
	payload: Uint8Array | string,
): Promise<{ nonce: string; ciphertext: string }> {
	const iv = new Uint8Array(12);
	crypto.getRandomValues(iv);
	const encodedPayload = typeof payload === "string" ? utf8Bytes(payload) : payload;
	const ciphertext = await crypto.subtle.encrypt(
		{
			name: "AES-GCM",
			iv: bufferSource(iv),
			additionalData: bufferSource(utf8Bytes(canonicalJson(metadata))),
		},
		key,
		bufferSource(encodedPayload),
	);
	return {
		nonce: base64UrlEncode(iv),
		ciphertext: base64UrlEncode(ciphertext),
	};
}

export async function decryptPacket(
	key: VNetPacketKey,
	metadata: unknown,
	nonce: string,
	ciphertext: string,
): Promise<Uint8Array> {
	const plaintext = await crypto.subtle.decrypt(
		{
			name: "AES-GCM",
			iv: bufferSource(base64UrlDecode(nonce)),
			additionalData: bufferSource(utf8Bytes(canonicalJson(metadata))),
		},
		key,
		bufferSource(base64UrlDecode(ciphertext)),
	);
	return new Uint8Array(plaintext);
}
