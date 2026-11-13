import { describe, expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import {
	createRelayReady,
	MAX_RELAY_PAYLOAD_BYTES,
	MAX_RELAY_READY_BYTES,
	mirrorJobTimeoutMs,
	mirrorTransferTimeoutMs,
	parseRelayReady,
	RELAY_CLOCK_SKEW_MS,
	RELAY_TTL_MS,
	type RelayReadyManifest,
	relayBucketExpired,
	relayDate,
	relayObjectPath,
	relayReadyDirectory,
	relayReadyPath,
	relayScanDates,
	validateMirrorJobTimeoutMs,
} from "./mirror-relay";

const key = Buffer.alloc(32, 7).toString("base64");
const now = Date.parse("2026-04-20T12:00:00.000Z");
function ready(created = now): RelayReadyManifest {
	return {
		schemaVersion: 1,
		feed: "default",
		product: "narrafork",
		repository: "NarraFork/NarraFork",
		kind: "main",
		tag: "v0.9.2",
		jobId: "run-123_attempt-2",
		createdAt: new Date(created).toISOString(),
		expiresAt: new Date(created + RELAY_TTL_MS).toISOString(),
		payload: { size: 100, sha256: "a".repeat(64) },
	};
}
function expected(m = ready(), manifestHash = createRelayReady(m, key).manifestHash, time = now) {
	return {
		manifestHash,
		feed: m.feed,
		product: m.product,
		repository: m.repository,
		kind: m.kind,
		date: relayDate(Date.parse(m.createdAt)),
		now: time,
	};
}
function signedUnknown(value: unknown) {
	const bytes = Buffer.from(JSON.stringify(value));
	return {
		bytes: Buffer.from(
			JSON.stringify({
				manifestBase64: bytes.toString("base64"),
				hmac: createHmac("sha256", Buffer.from(key, "base64")).update(bytes).digest("hex"),
			}),
		),
		manifestHash: createHash("sha256").update(bytes).digest("hex"),
	};
}
describe("bounded mirror timeout configuration", () => {
	test("main stays 25 minutes, auxiliary defaults to 120 and explicit overrides are bounded", () => {
		expect(mirrorJobTimeoutMs("main")).toBe(25 * 60_000);
		expect(mirrorJobTimeoutMs("helpers")).toBe(120 * 60_000);
		expect(mirrorJobTimeoutMs("executor")).toBe(120 * 60_000);
		expect(mirrorJobTimeoutMs("remote-peer")).toBe(120 * 60_000);
		expect(mirrorJobTimeoutMs("main", "300")).toBe(300 * 60_000);
		expect(mirrorTransferTimeoutMs()).toBe(15 * 60_000);
		expect(mirrorTransferTimeoutMs("60")).toBe(60 * 60_000);
		for (const value of [
			"NaN",
			"-1",
			"0",
			"301",
			"1.5",
			" 30",
			"Infinity",
			Number.NaN,
			-1,
			301,
			1.5,
		])
			expect(() => mirrorJobTimeoutMs("main", value)).toThrow();
		for (const value of ["61", "0", "NaN", "1e1", -1, 61, Number.POSITIVE_INFINITY])
			expect(() => mirrorTransferTimeoutMs(value)).toThrow();
		for (const value of [0, Number.NaN, 300 * 60_000 + 1])
			expect(() => validateMirrorJobTimeoutMs(value)).toThrow();
	});
});
describe("relay signed control envelope", () => {
	test("remote-peer signed relay binds its own kind and tag without weakening payload limits", () => {
		const m: RelayReadyManifest = {
			...ready(),
			kind: "remote-peer",
			tag: "remote-peer-v0.1.0-alpha.1",
		};
		const result = createRelayReady(m, key);
		expect(parseRelayReady(result.bytes, key, expected(m, result.manifestHash))).toEqual(m);
		for (const tag of ["executor-v0.1.0-alpha.1", "helpers-v1.0.0", "v0.1.0-alpha.1"])
			expect(() => createRelayReady({ ...m, tag }, key)).toThrow();
		expect(() =>
			createRelayReady({ ...m, payload: { ...m.payload, size: MAX_RELAY_PAYLOAD_BYTES + 1 } }, key),
		).toThrow();
		expect(() =>
			parseRelayReady(result.bytes, key, { ...expected(m, result.manifestHash), kind: "executor" }),
		).toThrow();
	});
	test("roundtrips exact manifest bytes, not the large independent payload", () => {
		const m = ready();
		m.payload.size = MAX_RELAY_PAYLOAD_BYTES;
		const result = createRelayReady(m, key);
		expect(result.bytes.length).toBeLessThan(MAX_RELAY_READY_BYTES);
		const envelope = JSON.parse(Buffer.from(result.bytes).toString());
		expect(JSON.parse(Buffer.from(envelope.manifestBase64, "base64").toString())).toEqual(m);
		expect(parseRelayReady(result.bytes, key, expected(m, result.manifestHash))).toEqual(m);
	});
	for (const [field, value] of Object.entries({
		schemaVersion: 2,
		feed: "other",
		product: "other",
		repository: "other/repo",
		kind: "helpers",
		tag: "v0.9.3",
		jobId: "other",
		createdAt: "2026-04-20T12:01:00.000Z",
		expiresAt: "2026-04-27T12:01:00.000Z",
		payload: { size: 101, sha256: "b".repeat(64) },
	})) {
		test(`HMAC covers ${field} even if attacker updates filename`, () => {
			const original = createRelayReady(ready(), key);
			const e = JSON.parse(Buffer.from(original.bytes).toString());
			const changed = Buffer.from(JSON.stringify({ ...ready(), [field]: value }));
			e.manifestBase64 = changed.toString("base64");
			const manifestHash = createHash("sha256").update(changed).digest("hex");
			expect(() =>
				parseRelayReady(Buffer.from(JSON.stringify(e)), key, expected(ready(), manifestHash)),
			).toThrow();
		});
	}
	test("binds filename, configured trust, date, signing key and HMAC length", () => {
		const result = createRelayReady(ready(), key);
		for (const patch of [
			{ manifestHash: "b".repeat(64) },
			{ feed: "other" },
			{ product: "other" },
			{ repository: "other/repo" },
			{ kind: "helpers" as const },
			{ date: "2026-04-21" },
		])
			expect(() => parseRelayReady(result.bytes, key, { ...expected(), ...patch })).toThrow();
		expect(() =>
			parseRelayReady(result.bytes, Buffer.alloc(32, 8).toString("base64"), expected()),
		).toThrow();
		const e = JSON.parse(Buffer.from(result.bytes).toString());
		e.hmac = "a";
		expect(() => parseRelayReady(Buffer.from(JSON.stringify(e)), key, expected())).toThrow();
		expect(
			parseRelayReady(result.bytes, key, { ...expected(), repository: "narrafork/narrafork" })
				.repository,
		).toBe("NarraFork/NarraFork");
	});
	test("strict keys, base64, schema, bounded size, kind/tag, repository and no arbitrary paths", () => {
		const invalid = [
			{ ...ready(), url: "https://secret.invalid" },
			{ ...ready(), schemaVersion: 2 },
			{ ...ready(), payload: { ...ready().payload, path: "../../evil" } },
			...[-1, 0, 1.2, MAX_RELAY_PAYLOAD_BYTES + 1].map((size) => ({
				...ready(),
				payload: { ...ready().payload, size },
			})),
			{ ...ready(), payload: { size: 1, sha256: "A".repeat(64) } },
			{ ...ready(), feed: "../other" },
			{ ...ready(), jobId: "https://evil" },
			{ ...ready(), repository: "https://github.com/a/b" },
			{ ...ready(), tag: "helpers-v1.0.0" },
			{ ...ready(), kind: "executor", tag: "helpers-v1.0.0" },
			{ ...ready(), createdAt: "2026-02-30T12:00:00.000Z" },
			{ ...ready(), expiresAt: "2026-04-27T12:00:00.001Z" },
		];
		for (const m of invalid) {
			const result = signedUnknown(m);
			expect(() =>
				parseRelayReady(result.bytes, key, expected(ready(), result.manifestHash)),
			).toThrow();
			expect(() => createRelayReady(m as RelayReadyManifest, key)).toThrow();
		}
		for (const badKey of [
			"",
			"secret",
			`${key}\n`,
			Buffer.alloc(31).toString("base64"),
			key.replace(/=$/, ""),
		])
			expect(() => createRelayReady(ready(), badKey)).toThrow();
		const result = createRelayReady(ready(), key);
		const e = JSON.parse(Buffer.from(result.bytes).toString());
		for (const envelope of [
			{ ...e, unknown: true },
			{ ...e, manifestBase64: `${e.manifestBase64}\n` },
			{ ...e, manifestBase64: "%%==" },
		])
			expect(() =>
				parseRelayReady(Buffer.from(JSON.stringify(envelope)), key, expected()),
			).toThrow();
		expect(() =>
			parseRelayReady(new Uint8Array(MAX_RELAY_READY_BYTES + 1), key, expected()),
		).toThrow();
		for (const relayKind of ["helpers", "executor"] as const) {
			const m = { ...ready(), kind: relayKind, tag: `${relayKind}-v1.2.3` };
			expect(parseRelayReady(createRelayReady(m, key).bytes, key, expected(m)).kind).toBe(
				relayKind,
			);
		}
	});
	test("precise seven-day lifetime and inclusive five-minute skew boundaries", () => {
		const m = ready();
		const result = createRelayReady(m, key);
		for (const time of [
			now - RELAY_CLOCK_SKEW_MS,
			now,
			now + RELAY_TTL_MS,
			now + RELAY_TTL_MS + RELAY_CLOCK_SKEW_MS,
		])
			expect(parseRelayReady(result.bytes, key, expected(m, result.manifestHash, time))).toEqual(m);
		for (const time of [
			now - RELAY_CLOCK_SKEW_MS - 1,
			now + RELAY_TTL_MS + RELAY_CLOCK_SKEW_MS + 1,
		])
			expect(() =>
				parseRelayReady(result.bytes, key, expected(m, result.manifestHash, time)),
			).toThrow();
	});
});
describe("UTC scan and retention paths", () => {
	test("usually eight buckets, nine across both midnight tolerance edges", () => {
		expect(relayScanDates(now)).toHaveLength(8);
		for (const time of ["2026-04-20T00:00:00.000Z", "2026-04-20T23:58:00.000Z"]) {
			const t = Date.parse(time);
			const dates = relayScanDates(t);
			expect(dates).toHaveLength(9);
			expect(dates).toContain(relayDate(t - RELAY_TTL_MS - RELAY_CLOCK_SKEW_MS));
			expect(dates).toContain(relayDate(t + RELAY_CLOCK_SKEW_MS));
		}
		expect(relayScanDates(Date.parse("2026-04-20T00:05:00.000Z"))).toHaveLength(8);
	});
	test("retention starts strictly after bucket END plus TTL, grace, twice skew", () => {
		const threshold =
			Date.parse("2026-04-21T00:00:00.000Z") + RELAY_TTL_MS + 86400000 + 2 * RELAY_CLOCK_SKEW_MS;
		for (const time of [threshold - 1, threshold])
			expect(relayBucketExpired("2026-04-20", time)).toBe(false);
		expect(relayBucketExpired("2026-04-20", threshold + 1)).toBe(true);
		expect(() => relayBucketExpired("2026-02-30", threshold)).toThrow();
	});
	test("fixed namespace and signed creation date/job bind all object paths", () => {
		const m = ready();
		const result = createRelayReady(m, key);
		const directory = "narrafork-mirror-v1/default/ready/narrafork/main/2026-04-20";
		expect(relayReadyDirectory(m.feed, m.product, m.kind, "2026-04-20")).toBe(directory);
		expect(relayReadyPath(m, result.manifestHash)).toBe(`${directory}/${result.manifestHash}.json`);
		expect(relayObjectPath(m, m.payload.sha256)).toBe(
			`narrafork-mirror-v1/default/batches/narrafork/main/2026-04-20/${m.jobId}/objects/${m.payload.sha256}`,
		);
		for (const value of ["../x", "/evil", "https://evil", "", "a/b", "a%2fb"])
			expect(() => relayReadyDirectory(value, m.product, m.kind, "2026-04-20")).toThrow();
		expect(() => relayObjectPath(m, "../evil")).toThrow();
	});
});
