import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { isValidGitHubRepository } from "./github-repository";
import { isValidReleaseVersion } from "./release-version";

export const RELAY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const RELAY_CLOCK_SKEW_MS = 5 * 60 * 1000;
export const MAX_RELAY_READY_BYTES = 8 * 1024;
export const MAX_RELAY_PAYLOAD_BYTES = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const SHA = /^[a-f0-9]{64}$/;
export type RelayKind = "main" | "helpers" | "executor" | "remote-peer";
export const MAX_MIRROR_UPLOAD_CONCURRENCY = 8;
export const DEFAULT_MIRROR_UPLOAD_CONCURRENCY = 3;
export const DEFAULT_MIRROR_DIRECT_UPLOAD_CONCURRENCY = 2;
export function mirrorUploadConcurrency(
	value?: unknown,
	transport: "direct" | "webdav" = "webdav",
): number {
	if (value === undefined || value === "")
		return transport === "direct"
			? DEFAULT_MIRROR_DIRECT_UPLOAD_CONCURRENCY
			: DEFAULT_MIRROR_UPLOAD_CONCURRENCY;
	if (typeof value !== "number" && (typeof value !== "string" || !/^[1-8]$/.test(value)))
		throw new Error("Mirror upload concurrency must be an integer between 1 and 8");
	const concurrency = Number(value);
	if (
		!Number.isSafeInteger(concurrency) ||
		concurrency < 1 ||
		concurrency > MAX_MIRROR_UPLOAD_CONCURRENCY
	)
		throw new Error("Mirror upload concurrency must be an integer between 1 and 8");
	return concurrency;
}
export const MAX_MIRROR_JOB_TIMEOUT_MS = 300 * 60_000;
export const MAX_MIRROR_TRANSFER_TIMEOUT_MS = 60 * 60_000;
/** Explicit deployment configuration, not data accepted from an unsigned relay payload. */
export function mirrorTimeoutMinutes(value: unknown, fallback: number, maximum: number): number {
	if (value === undefined || value === "") return fallback * 60_000;
	if (typeof value !== "number" && (typeof value !== "string" || !/^[0-9]{1,3}$/.test(value)))
		throw new Error("Mirror timeout must be whole bounded minutes");
	const minutes = Number(value);
	if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > maximum)
		throw new Error(`Mirror timeout must be between 1 and ${maximum} minutes`);
	return minutes * 60_000;
}
export function mirrorJobTimeoutMs(kind: RelayKind, value?: unknown): number {
	return mirrorTimeoutMinutes(value, kind === "main" ? 25 : 120, 300);
}
export function mirrorTransferTimeoutMs(value?: unknown): number {
	return mirrorTimeoutMinutes(value, 15, 60);
}
export function validateMirrorJobTimeoutMs(value: number): number {
	if (!Number.isSafeInteger(value) || value < 1 || value > MAX_MIRROR_JOB_TIMEOUT_MS)
		throw new Error("Mirror job timeout exceeds hard limit");
	return value;
}
export type RelayReadyManifest = {
	schemaVersion: 1;
	feed: string;
	product: string;
	repository: string;
	kind: RelayKind;
	tag: string;
	jobId: string;
	createdAt: string;
	expiresAt: string;
	payload: { size: number; sha256: string };
};
function check(condition: unknown): asserts condition {
	if (!condition) throw new Error("Invalid mirror relay data");
}
function record(value: unknown, keys: string[]): Record<string, unknown> {
	check(value !== null && typeof value === "object" && !Array.isArray(value));
	check(Object.keys(value).length === keys.length && keys.every((k) => Object.hasOwn(value, k)));
	return value as Record<string, unknown>;
}
function segment(value: unknown): asserts value is string {
	check(typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value));
}
function kind(value: unknown): asserts value is RelayKind {
	check(value === "main" || value === "helpers" || value === "executor" || value === "remote-peer");
}
function timestamp(value: unknown): number {
	check(typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value));
	const time = Date.parse(value);
	check(Number.isFinite(time) && new Date(time).toISOString() === value);
	return time;
}
function dateStart(date: string): number {
	check(/^\d{4}-\d\d-\d\d$/.test(date));
	return timestamp(`${date}T00:00:00.000Z`);
}
function manifest(value: unknown): RelayReadyManifest {
	const m = record(value, [
		"schemaVersion",
		"feed",
		"product",
		"repository",
		"kind",
		"tag",
		"jobId",
		"createdAt",
		"expiresAt",
		"payload",
	]);
	check(m.schemaVersion === 1);
	segment(m.feed);
	segment(m.product);
	segment(m.jobId);
	kind(m.kind);
	check(isValidGitHubRepository(m.repository));
	const prefix = m.kind === "main" ? "v" : `${m.kind}-v`;
	check(
		typeof m.tag === "string" &&
			m.tag.startsWith(prefix) &&
			isValidReleaseVersion(m.tag.slice(prefix.length)),
	);
	const created = timestamp(m.createdAt);
	check(timestamp(m.expiresAt) === created + RELAY_TTL_MS);
	const p = record(m.payload, ["size", "sha256"]);
	check(
		typeof p.size === "number" &&
			Number.isSafeInteger(p.size) &&
			p.size > 0 &&
			p.size <= MAX_RELAY_PAYLOAD_BYTES,
	);
	check(typeof p.sha256 === "string" && SHA.test(p.sha256));
	return m as unknown as RelayReadyManifest;
}
function base64(value: unknown): Buffer {
	check(
		typeof value === "string" &&
			value.length > 0 &&
			/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value),
	);
	const bytes = Buffer.from(value, "base64");
	check(bytes.toString("base64") === value);
	return bytes;
}
function key(value: string): Buffer {
	check(typeof value === "string" && value.length === 44);
	const bytes = base64(value);
	check(bytes.length === 32);
	return bytes;
}
function hash(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}
function parseJson(bytes: Uint8Array): unknown {
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		throw new Error("Invalid mirror relay data");
	}
}
export function createRelayReady(
	input: RelayReadyManifest,
	signingKey: string,
): { manifestHash: string; bytes: Uint8Array } {
	const m = manifest(input);
	const bytes = Buffer.from(JSON.stringify(m));
	const hmac = createHmac("sha256", key(signingKey)).update(bytes).digest("hex");
	const envelope = Buffer.from(JSON.stringify({ manifestBase64: bytes.toString("base64"), hmac }));
	check(envelope.length <= MAX_RELAY_READY_BYTES);
	return { manifestHash: hash(bytes), bytes: envelope };
}
export function parseRelayReady(
	bytes: Uint8Array,
	signingKey: string,
	expected: {
		manifestHash: string;
		feed: string;
		product: string;
		repository: string;
		kind: RelayKind;
		date: string;
		now?: number;
	},
): RelayReadyManifest {
	check(bytes.length > 0 && bytes.length <= MAX_RELAY_READY_BYTES);
	const e = record(parseJson(bytes), ["manifestBase64", "hmac"]);
	const raw = base64(e.manifestBase64);
	check(typeof e.hmac === "string" && SHA.test(e.hmac));
	check(SHA.test(expected.manifestHash) && hash(raw) === expected.manifestHash);
	const signature = createHmac("sha256", key(signingKey)).update(raw).digest();
	check(timingSafeEqual(signature, Buffer.from(e.hmac, "hex")));
	const m = manifest(parseJson(raw));
	check(isValidGitHubRepository(expected.repository));
	check(
		m.feed === expected.feed &&
			m.product === expected.product &&
			m.kind === expected.kind &&
			m.repository.toLowerCase() === expected.repository.toLowerCase(),
	);
	dateStart(expected.date);
	check(relayDate(timestamp(m.createdAt)) === expected.date);
	const now = expected.now ?? Date.now();
	check(
		Number.isFinite(now) &&
			timestamp(m.createdAt) <= now + RELAY_CLOCK_SKEW_MS &&
			now <= timestamp(m.expiresAt) + RELAY_CLOCK_SKEW_MS,
	);
	return m;
}
export function relayDate(now: number): string {
	check(Number.isFinite(now));
	const value = new Date(now).toISOString().slice(0, 10);
	dateStart(value);
	return value;
}
export function relayScanDates(now: number): string[] {
	const first = dateStart(relayDate(now - RELAY_TTL_MS - RELAY_CLOCK_SKEW_MS));
	const last = dateStart(relayDate(now + RELAY_CLOCK_SKEW_MS));
	const dates: string[] = [];
	for (let t = first; t <= last; t += DAY_MS) dates.push(relayDate(t));
	check(dates.length <= 9);
	return dates;
}
export function relayBucketExpired(date: string, now: number): boolean {
	check(Number.isFinite(now));
	return now > dateStart(date) + DAY_MS + RELAY_TTL_MS + DAY_MS + 2 * RELAY_CLOCK_SKEW_MS;
}
export function relayReadyDirectory(
	feed: string,
	product: string,
	relayKind: RelayKind,
	date: string,
): string {
	segment(feed);
	segment(product);
	kind(relayKind);
	dateStart(date);
	return `narrafork-mirror-v1/${feed}/ready/${product}/${relayKind}/${date}`;
}
export function relayReadyPath(m: RelayReadyManifest, manifestHash: string): string {
	manifest(m);
	check(SHA.test(manifestHash));
	return `${relayReadyDirectory(m.feed, m.product, m.kind, relayDate(timestamp(m.createdAt)))}/${manifestHash}.json`;
}
export function relayObjectPath(m: RelayReadyManifest, sha256: string): string {
	manifest(m);
	check(SHA.test(sha256));
	return `narrafork-mirror-v1/${m.feed}/batches/${m.product}/${m.kind}/${relayDate(timestamp(m.createdAt))}/${m.jobId}/objects/${sha256}`;
}
