import { LIMITS } from "../shared/remote-access/protocol";

export type Discovery = {
	hash: string;
	kind: "invite" | "grant";
	id: string;
	expiresAt: number;
};

export function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function exact(value: Record<string, unknown>, keys: string[]): boolean {
	return Object.keys(value).every((key) => keys.includes(key));
}

export function opaque(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value);
}

export function publicKey(value: unknown): value is string {
	return typeof value === "string" && /^04[0-9a-f]{128}$/.test(value);
}

export function signature(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{128}$/.test(value);
}

export function discoveries(value: unknown, now: number): Discovery[] | undefined {
	if (!Array.isArray(value) || value.length > 64) return;
	const hashes = new Set<string>();
	const targets = new Set<string>();
	for (const entry of value) {
		if (
			!object(entry) ||
			!exact(entry, ["hash", "kind", "id", "expiresAt"]) ||
			typeof entry.hash !== "string" ||
			!/^[0-9a-f]{64}$/.test(entry.hash) ||
			(entry.kind !== "invite" && entry.kind !== "grant") ||
			!opaque(entry.id) ||
			typeof entry.expiresAt !== "number" ||
			!Number.isSafeInteger(entry.expiresAt) ||
			entry.expiresAt <= now ||
			entry.expiresAt > now + 30 * 86400 ||
			hashes.has(entry.hash) ||
			targets.has(`${entry.kind}:${entry.id}`)
		)
			return;
		hashes.add(entry.hash);
		targets.add(`${entry.kind}:${entry.id}`);
	}
	return value as Discovery[];
}

function candidateLine(value: string): boolean {
	if (new TextEncoder().encode(value).byteLength > LIMITS.candidateBytes) return false;
	const parts = value.trim().replace(/^a=/, "").split(/\s+/);
	return (
		parts[0]?.startsWith("candidate:") === true &&
		!value.includes("\0") &&
		!/\btyp\s+relay\b/i.test(value) &&
		parts[6] === "typ" &&
		["host", "srflx", "prflx"].includes(parts[7] ?? "")
	);
}

export function sdp(value: unknown): value is string {
	if (
		typeof value !== "string" ||
		!/^v=0(?:\r?\n|$)/.test(value) ||
		value.includes("\0") ||
		new TextEncoder().encode(value).byteLength > LIMITS.sdpBytes
	)
		return false;
	let count = 0;
	for (const line of value.split(/\r?\n/)) {
		if (/^a=candidate:/i.test(line.trim())) {
			if (!candidateLine(line) || ++count > LIMITS.candidates) return false;
		}
	}
	return true;
}

export function sdpCandidateCount(value: string): number {
	return value.split(/\r?\n/).filter((line) => /^a=candidate:/i.test(line.trim())).length;
}

export function candidate(value: unknown): boolean {
	if (value === null) return true;
	if (!object(value) || !exact(value, ["candidate", "sdpMid", "sdpMLineIndex", "usernameFragment"]))
		return false;
	if (new TextEncoder().encode(JSON.stringify(value)).byteLength > LIMITS.candidateBytes)
		return false;
	if (
		typeof value.candidate !== "string" ||
		(value.candidate !== "" && !candidateLine(value.candidate))
	)
		return false;
	if (
		value.sdpMid !== undefined &&
		value.sdpMid !== null &&
		(typeof value.sdpMid !== "string" || value.sdpMid.length > 256)
	)
		return false;
	if (
		value.sdpMLineIndex !== undefined &&
		value.sdpMLineIndex !== null &&
		(typeof value.sdpMLineIndex !== "number" ||
			!Number.isInteger(value.sdpMLineIndex) ||
			value.sdpMLineIndex < 0 ||
			value.sdpMLineIndex > 65535)
	)
		return false;
	if (
		value.usernameFragment !== undefined &&
		(typeof value.usernameFragment !== "string" || value.usernameFragment.length > 256)
	)
		return false;
	return true;
}
