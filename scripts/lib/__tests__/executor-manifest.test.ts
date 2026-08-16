import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	buildExecutorManifest,
	ExecutorManifestError,
	formatExecutorManifest,
	parseExecutorManifest,
	sha256Hex,
} from "../executor-manifest";

const RELEASED_AT = "2026-08-15T00:00:00.000Z";

function bytes(content: string): Uint8Array {
	return new Uint8Array(Buffer.from(content));
}

function baseOptions() {
	return {
		version: "0.5.24",
		protocolVersion: 1,
		releasedAt: RELEASED_AT,
		artifacts: [
			{ platform: "linux-amd64" as const, bytes: bytes("linux-amd64-binary") },
			{ platform: "windows-amd64" as const, bytes: bytes("windows-amd64-binary") },
		],
	};
}

describe("buildExecutorManifest", () => {
	test("derives filenames and digests from the artifacts", () => {
		const manifest = buildExecutorManifest(baseOptions());
		expect(manifest.version).toBe("0.5.24");
		expect(manifest.protocolVersion).toBe(1);
		expect(manifest.platforms["linux-amd64"]).toEqual({
			filename: "narrafork-executor-0.5.24-linux-amd64",
			size: bytes("linux-amd64-binary").byteLength,
			sha256: createHash("sha256").update(bytes("linux-amd64-binary")).digest("hex"),
		});
		// Windows artifacts keep the .exe suffix so the published URL is runnable.
		expect(manifest.platforms["windows-amd64"]?.filename).toBe(
			"narrafork-executor-0.5.24-windows-amd64.exe",
		);
	});

	test("emits platforms in canonical order regardless of input order", () => {
		const manifest = buildExecutorManifest({
			...baseOptions(),
			artifacts: [
				{ platform: "windows-arm64", bytes: bytes("w-arm") },
				{ platform: "linux-arm64", bytes: bytes("l-arm") },
				{ platform: "linux-amd64", bytes: bytes("l-amd") },
			],
		});
		expect(Object.keys(manifest.platforms)).toEqual([
			"linux-amd64",
			"linux-arm64",
			"windows-arm64",
		]);
	});

	test("accepts a partial platform set for single-platform builds", () => {
		const manifest = buildExecutorManifest({
			...baseOptions(),
			artifacts: [{ platform: "darwin-arm64", bytes: bytes("mac") }],
		});
		expect(Object.keys(manifest.platforms)).toEqual(["darwin-arm64"]);
	});

	test("rejects malformed versions, protocol versions and timestamps", () => {
		expect(() => buildExecutorManifest({ ...baseOptions(), version: "v0.5.24" })).toThrow(
			ExecutorManifestError,
		);
		expect(() => buildExecutorManifest({ ...baseOptions(), version: "0.5" })).toThrow(
			ExecutorManifestError,
		);
		expect(() => buildExecutorManifest({ ...baseOptions(), protocolVersion: 0 })).toThrow(
			ExecutorManifestError,
		);
		expect(() => buildExecutorManifest({ ...baseOptions(), protocolVersion: 1.5 })).toThrow(
			ExecutorManifestError,
		);
		expect(() => buildExecutorManifest({ ...baseOptions(), releasedAt: "not-a-date" })).toThrow(
			ExecutorManifestError,
		);
	});

	test("rejects empty, duplicate and unknown artifacts", () => {
		expect(() => buildExecutorManifest({ ...baseOptions(), artifacts: [] })).toThrow(
			ExecutorManifestError,
		);
		expect(() =>
			buildExecutorManifest({
				...baseOptions(),
				artifacts: [{ platform: "linux-amd64", bytes: new Uint8Array(0) }],
			}),
		).toThrow(/is empty/);
		expect(() =>
			buildExecutorManifest({
				...baseOptions(),
				artifacts: [
					{ platform: "linux-amd64", bytes: bytes("a") },
					{ platform: "linux-amd64", bytes: bytes("b") },
				],
			}),
		).toThrow(/Duplicate/);
		expect(() =>
			buildExecutorManifest({
				...baseOptions(),
				// biome-ignore lint/suspicious/noExplicitAny: exercising the runtime guard
				artifacts: [{ platform: "linux-riscv64" as any, bytes: bytes("a") }],
			}),
		).toThrow(/Unknown executor platform/);
	});

	test("prerelease versions are publishable", () => {
		const manifest = buildExecutorManifest({ ...baseOptions(), version: "0.6.0-beta.1" });
		expect(manifest.platforms["linux-amd64"]?.filename).toBe(
			"narrafork-executor-0.6.0-beta.1-linux-amd64",
		);
	});
});

describe("formatExecutorManifest", () => {
	test("round-trips through parse and is byte-stable", () => {
		const manifest = buildExecutorManifest(baseOptions());
		const text = formatExecutorManifest(manifest);
		expect(text.endsWith("\n")).toBe(true);
		expect(formatExecutorManifest(buildExecutorManifest(baseOptions()))).toBe(text);
		expect(parseExecutorManifest(JSON.parse(text))).toEqual(manifest);
	});
});

describe("parseExecutorManifest", () => {
	function published(overrides: Record<string, unknown> = {}) {
		return {
			version: "0.5.24",
			protocolVersion: 1,
			releasedAt: RELEASED_AT,
			platforms: {
				"linux-amd64": {
					filename: "narrafork-executor-0.5.24-linux-amd64",
					size: 18,
					sha256: "a".repeat(64),
				},
			},
			...overrides,
		};
	}

	test("accepts a well-formed manifest", () => {
		const parsed = parseExecutorManifest(published());
		expect(parsed.platforms["linux-amd64"]?.size).toBe(18);
	});

	test("ignores unknown platform keys instead of trusting them", () => {
		const parsed = parseExecutorManifest(
			published({
				platforms: {
					"linux-amd64": {
						filename: "narrafork-executor-0.5.24-linux-amd64",
						size: 18,
						sha256: "a".repeat(64),
					},
					"linux-riscv64": { filename: "evil", size: 1, sha256: "b".repeat(64) },
				},
			}),
		);
		expect(Object.keys(parsed.platforms)).toEqual(["linux-amd64"]);
	});

	test("rejects a filename that does not match the manifest version", () => {
		expect(() =>
			parseExecutorManifest(
				published({
					platforms: {
						"linux-amd64": {
							// Version mismatch would let a stale or attacker-chosen artifact be
							// fetched under a trusted manifest version.
							filename: "narrafork-executor-0.4.0-linux-amd64",
							size: 18,
							sha256: "a".repeat(64),
						},
					},
				}),
			),
		).toThrow(/unexpected filename/);
	});

	test("rejects path traversal in filenames", () => {
		expect(() =>
			parseExecutorManifest(
				published({
					platforms: {
						"linux-amd64": {
							filename: "../../products/narrafork/releases/evil",
							size: 18,
							sha256: "a".repeat(64),
						},
					},
				}),
			),
		).toThrow(/unexpected filename/);
	});

	test("rejects invalid sizes and digests", () => {
		expect(() =>
			parseExecutorManifest(
				published({
					platforms: {
						"linux-amd64": {
							filename: "narrafork-executor-0.5.24-linux-amd64",
							size: 0,
							sha256: "a".repeat(64),
						},
					},
				}),
			),
		).toThrow(/invalid size/);
		expect(() =>
			parseExecutorManifest(
				published({
					platforms: {
						"linux-amd64": {
							filename: "narrafork-executor-0.5.24-linux-amd64",
							size: 18,
							sha256: "NOTHEX",
						},
					},
				}),
			),
		).toThrow(/invalid sha256/);
		expect(() =>
			parseExecutorManifest(
				published({
					platforms: {
						"linux-amd64": {
							filename: "narrafork-executor-0.5.24-linux-amd64",
							size: 18,
							// Uppercase hex would compare unequal against our lowercase digests.
							sha256: "A".repeat(64),
						},
					},
				}),
			),
		).toThrow(/invalid sha256/);
	});

	test("rejects non-objects, bad metadata and empty platform maps", () => {
		expect(() => parseExecutorManifest(null)).toThrow(ExecutorManifestError);
		expect(() => parseExecutorManifest("{}")).toThrow(ExecutorManifestError);
		expect(() => parseExecutorManifest(published({ version: 42 }))).toThrow(/invalid version/);
		expect(() => parseExecutorManifest(published({ protocolVersion: "1" }))).toThrow(
			/invalid protocolVersion/,
		);
		expect(() => parseExecutorManifest(published({ releasedAt: "yesterday" }))).toThrow(
			/invalid releasedAt/,
		);
		expect(() => parseExecutorManifest(published({ platforms: {} }))).toThrow(
			/no usable platforms/,
		);
		expect(() => parseExecutorManifest(published({ platforms: null }))).toThrow(
			/platforms is not an object/,
		);
	});
});

describe("sha256Hex", () => {
	test("matches node crypto and is lowercase hex", () => {
		const payload = bytes("executor");
		expect(sha256Hex(payload)).toBe(createHash("sha256").update(payload).digest("hex"));
		expect(sha256Hex(payload)).toMatch(/^[0-9a-f]{64}$/);
	});
});
