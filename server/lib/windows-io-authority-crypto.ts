import { createHash, createPublicKey, verify } from "node:crypto";
import {
	canonicalWindowsIoJson,
	parseWindowsIoTicketSignedBytes,
	WINDOWS_IO_AUTHORITY_LIMITS,
	type WindowsIoCaptureProof,
	type WindowsIoSignedTicket,
	type WindowsIoTicketPayload,
	windowsIoCaptureProofSchema,
	windowsIoSignedTicketSchema,
} from "@shared/windows-io-authority";

export interface WindowsIoPublicPin {
	issuer: string;
	serviceId: string;
	keyEpoch: number;
	/** Administrator-provisioned Ed25519 public key in raw 32-byte base64url form. */
	publicKey: string;
}
export function decodeWindowsIoBase64url(value: string, limit: number): Uint8Array {
	if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > Math.ceil((limit * 4) / 3))
		throw new Error("Invalid or oversized authority encoding");
	const bytes = Buffer.from(value, "base64url");
	if (bytes.length > limit || bytes.toString("base64url") !== value)
		throw new Error("Noncanonical authority encoding");
	return bytes;
}
function publicKey(raw: string) {
	const bytes = decodeWindowsIoBase64url(raw, 32);
	if (bytes.byteLength !== 32) throw new Error("Invalid Ed25519 pin");
	return createPublicKey({
		key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), bytes]),
		format: "der",
		type: "spki",
	});
}
export function verifyWindowsIoSignedTicket(
	value: unknown,
	pins: readonly WindowsIoPublicPin[],
	now: number,
	expected?: Partial<WindowsIoTicketPayload>,
): WindowsIoTicketPayload {
	if (pins.length === 0 || pins.length > 16)
		throw new Error("Authority pin budget exceeded or no administrator pin");
	const ticket = windowsIoSignedTicketSchema.parse(value);
	if (Buffer.byteLength(JSON.stringify(ticket)) > WINDOWS_IO_AUTHORITY_LIMITS.ticketBytes)
		throw new Error("Ticket exceeds byte budget");
	const bytes = decodeWindowsIoBase64url(ticket.payload, WINDOWS_IO_AUTHORITY_LIMITS.payloadBytes);
	const signature = decodeWindowsIoBase64url(ticket.signature, 64);
	// Verify original bytes with an explicit ADMIN pin before parsing their claims.
	const candidates = pins.filter((pin) => verify(null, bytes, publicKey(pin.publicKey), signature));
	if (candidates.length !== 1) throw new Error("Unknown or ambiguous authority signature");
	const payload = parseWindowsIoTicketSignedBytes(bytes);
	const pin = candidates[0];
	if (
		payload.issuer !== pin.issuer ||
		payload.serviceId !== pin.serviceId ||
		payload.keyEpoch !== pin.keyEpoch
	)
		throw new Error("Authority issuer/service/key epoch mismatch");
	if (payload.issuedAt > now || payload.expiresAt <= now)
		throw new Error("Ticket not currently valid");
	if (expected) {
		for (const [key, value] of Object.entries(expected)) {
			if (
				canonicalWindowsIoJson(payload[key as keyof WindowsIoTicketPayload]) !==
				canonicalWindowsIoJson(value)
			)
				throw new Error("Ticket does not bind the original operation context");
		}
	}
	return payload;
}
/** SHA256 of the ENTIRE original signed payload bytes binds time, nonce, challenge and
 * original request digest together. Native persistence must not hash selected claim fields. */
export function windowsIoTicketPayloadDigest(ticket: WindowsIoSignedTicket): string {
	const parsed = windowsIoSignedTicketSchema.parse(ticket);
	return createHash("sha256")
		.update(decodeWindowsIoBase64url(parsed.payload, WINDOWS_IO_AUTHORITY_LIMITS.payloadBytes))
		.digest("hex");
}
export function windowsIoCaptureProofSignedBytes(value: unknown): Uint8Array {
	const { signature: _signature, ...record } = windowsIoCaptureProofSchema.parse(value);
	return new TextEncoder().encode(canonicalWindowsIoJson(record));
}
/** A valid signature alone is not record ownership: native helper MUST check its durable record. */
export function verifyWindowsIoCaptureProof(
	value: unknown,
	pin: { helperInstanceId: string; keyEpoch: number; publicKey: string },
): WindowsIoCaptureProof {
	const proof = windowsIoCaptureProofSchema.parse(value);
	if (
		proof.helperInstanceId !== pin.helperInstanceId ||
		proof.keyEpoch !== pin.keyEpoch ||
		!verify(
			null,
			windowsIoCaptureProofSignedBytes(proof),
			publicKey(pin.publicKey),
			decodeWindowsIoBase64url(proof.signature, 64),
		)
	)
		throw new Error("Untrusted helper capture proof");
	return proof;
}
export function encodeWindowsIoSignedTicket(
	bytes: Uint8Array,
	signature: Uint8Array,
): WindowsIoSignedTicket {
	if (signature.byteLength !== 64) throw new Error("Broker did not return Ed25519 signature");
	return windowsIoSignedTicketSchema.parse({
		payload: Buffer.from(bytes).toString("base64url"),
		signature: Buffer.from(signature).toString("base64url"),
	});
}
