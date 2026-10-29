import {
	hex,
	instanceId,
	sha256Hex,
	sign,
	transcript,
	unhex,
} from "../shared/remote-access/identity";
import { encodeFrame } from "../shared/remote-access/protocol";

// Publicly known scalar=1 is ONLY a cross-language test vector, never a runtime identity.
const publicKey =
	"046b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5";
const b64 = (value: string) => Buffer.from(unhex(value)).toString("base64url");
const key = await crypto.subtle.importKey(
	"jwk",
	{
		kty: "EC",
		crv: "P-256",
		x: b64(publicKey.slice(2, 66)),
		y: b64(publicKey.slice(66)),
		d: b64(`${"00".repeat(31)}01`),
	},
	{ name: "ECDSA", namedCurve: "P-256" },
	false,
	["sign"],
);
const label = "register";
const fields = ["test-challenge", publicKey];
const vectors = {
	warning: "Public test key scalar=1; MUST NOT be used as runtime key",
	publicKey,
	instanceId: await instanceId(publicKey),
	label,
	fields,
	transcriptHex: hex(transcript(label, fields)),
	signature: await sign(key, label, fields),
	hashInput: "prototype",
	hash: await sha256Hex("prototype"),
	frame: { kind: 1, streamId: 7, sequence: 0, payloadHex: hex(new TextEncoder().encode("hello")) },
	frameHex: hex(
		encodeFrame({ kind: 1, streamId: 7, sequence: 0, payload: new TextEncoder().encode("hello") }),
	),
};
await Bun.write(
	new URL("../shared/remote-access/vectors.json", import.meta.url),
	`${JSON.stringify(vectors, null, 2)}\n`,
);
console.log("Generated WebRTC cross-language test vectors (public test key only)");
