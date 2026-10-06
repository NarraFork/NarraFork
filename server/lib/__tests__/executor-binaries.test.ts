import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXECUTOR_MANIFEST_FILENAME, type ExecutorManifest } from "@shared/remote-executor";
import {
	ExecutorDistributionError,
	ensureExecutorBinary,
	getExecutorArtifactDigest,
	getExecutorManifest,
	resetExecutorManifestCache,
} from "../executor-binaries";
import { HELPER_BIN_DIR } from "../helper-binaries";

const originalFetch = globalThis.fetch;
const LINUX_BINARY = Buffer.from("linux-amd64-executor-payload");
const LINUX_SHA256 = createHash("sha256").update(LINUX_BINARY).digest("hex");
const MANIFEST_PATH = join(HELPER_BIN_DIR, EXECUTOR_MANIFEST_FILENAME);

function manifest(overrides: Partial<ExecutorManifest> = {}): ExecutorManifest {
	return {
		version: "0.5.24",
		protocolVersion: 1,
		releasedAt: "2026-08-15T00:00:00.000Z",
		platforms: {
			"linux-amd64": {
				filename: "narrafork-executor-0.5.24-linux-amd64",
				size: LINUX_BINARY.byteLength,
				sha256: LINUX_SHA256,
			},
		},
		...overrides,
	};
}

interface RouteResponses {
	manifest?: () => Response;
	binary?: () => Response;
}

function mockFetch(routes: RouteResponses): { calls: string[] } {
	const calls: string[] = [];
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		calls.push(url);
		if (url.endsWith(EXECUTOR_MANIFEST_FILENAME)) {
			return routes.manifest?.() ?? new Response("not found", { status: 404 });
		}
		return routes.binary?.() ?? new Response("not found", { status: 404 });
	}) as unknown as typeof fetch;
	return { calls };
}

function jsonResponse(body: unknown): Response {
	const text = typeof body === "string" ? body : JSON.stringify(body);
	return new Response(text, { status: 200, headers: { "content-type": "application/json" } });
}

function binaryResponse(payload: Buffer): Response {
	return new Response(new Blob([Uint8Array.from(payload)]), {
		status: 200,
		headers: { "content-type": "application/octet-stream" },
	});
}

function clearHelperBinDir(): void {
	rmSync(HELPER_BIN_DIR, { recursive: true, force: true });
	mkdirSync(HELPER_BIN_DIR, { recursive: true });
}

beforeEach(() => {
	resetExecutorManifestCache();
	clearHelperBinDir();
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	resetExecutorManifestCache();
	clearHelperBinDir();
});

describe("getExecutorManifest", () => {
	test("fetches, validates and persists the published manifest", async () => {
		mockFetch({ manifest: () => jsonResponse(manifest()) });
		const resolved = await getExecutorManifest();
		expect(resolved?.version).toBe("0.5.24");
		expect(resolved?.protocolVersion).toBe(1);
		// Persisted so a later offline start can still enroll devices.
		expect(existsSync(MANIFEST_PATH)).toBe(true);
		expect(JSON.parse(readFileSync(MANIFEST_PATH, "utf-8")).version).toBe("0.5.24");
	});

	test("caches within the freshness window and coalesces concurrent fetches", async () => {
		const { calls } = mockFetch({ manifest: () => jsonResponse(manifest()) });
		const [first, second] = await Promise.all([getExecutorManifest(), getExecutorManifest()]);
		expect(first?.version).toBe("0.5.24");
		expect(second?.version).toBe("0.5.24");
		await getExecutorManifest();
		expect(calls.length).toBe(1);
	});

	test("falls back to the persisted manifest when the server is unreachable", async () => {
		mkdirSync(HELPER_BIN_DIR, { recursive: true });
		writeFileSync(MANIFEST_PATH, JSON.stringify(manifest()));
		mockFetch({
			manifest: () => {
				throw new Error("network down");
			},
		});
		const resolved = await getExecutorManifest();
		expect(resolved?.version).toBe("0.5.24");
	});

	test("returns null when neither the server nor the cache has a manifest", async () => {
		mockFetch({ manifest: () => new Response("nope", { status: 404 }) });
		expect(await getExecutorManifest()).toBeNull();
	});

	test("rejects a structurally invalid manifest instead of caching it", async () => {
		mockFetch({
			manifest: () =>
				jsonResponse({
					version: "0.5.24",
					protocolVersion: 1,
					releasedAt: "2026-08-15T00:00:00.000Z",
					platforms: {
						// Filename does not match the declared version, so this artifact must
						// not become fetchable under a trusted manifest.
						"linux-amd64": {
							filename: "narrafork-executor-0.0.1-linux-amd64",
							size: 10,
							sha256: "a".repeat(64),
						},
					},
				}),
		});
		expect(await getExecutorManifest()).toBeNull();
		expect(existsSync(MANIFEST_PATH)).toBe(false);
	});

	test("rejects an oversized manifest body", async () => {
		mockFetch({ manifest: () => jsonResponse(`{"padding":"${"x".repeat(70 * 1024)}"}`) });
		expect(await getExecutorManifest()).toBeNull();
	});
});

describe("ensureExecutorBinary", () => {
	test("downloads, verifies and caches the binary", async () => {
		mockFetch({
			manifest: () => jsonResponse(manifest()),
			binary: () => binaryResponse(LINUX_BINARY),
		});
		const artifact = await ensureExecutorBinary("linux-amd64");
		expect(artifact.version).toBe("0.5.24");
		expect(artifact.sha256).toBe(LINUX_SHA256);
		expect(readFileSync(artifact.path)).toEqual(LINUX_BINARY);
		// Cache name is version-scoped so platforms and releases never collide.
		expect(artifact.path).toBe(join(HELPER_BIN_DIR, "narrafork-executor-0.5.24-linux-amd64"));
	});

	test("reuses a cached binary without re-downloading", async () => {
		const { calls } = mockFetch({
			manifest: () => jsonResponse(manifest()),
			binary: () => binaryResponse(LINUX_BINARY),
		});
		await ensureExecutorBinary("linux-amd64");
		const downloadCalls = calls.filter((url) => !url.endsWith(EXECUTOR_MANIFEST_FILENAME)).length;
		await ensureExecutorBinary("linux-amd64");
		expect(calls.filter((url) => !url.endsWith(EXECUTOR_MANIFEST_FILENAME)).length).toBe(
			downloadCalls,
		);
	});

	test("re-downloads when the cached file no longer matches the manifest digest", async () => {
		mkdirSync(HELPER_BIN_DIR, { recursive: true });
		const cachedPath = join(HELPER_BIN_DIR, "narrafork-executor-0.5.24-linux-amd64");
		writeFileSync(cachedPath, "tampered-or-truncated");
		const { calls } = mockFetch({
			manifest: () => jsonResponse(manifest()),
			binary: () => binaryResponse(LINUX_BINARY),
		});
		const artifact = await ensureExecutorBinary("linux-amd64");
		expect(readFileSync(artifact.path)).toEqual(LINUX_BINARY);
		expect(calls.some((url) => url.endsWith("narrafork-executor-0.5.24-linux-amd64"))).toBe(true);
	});

	test("refuses a download whose digest does not match the manifest", async () => {
		mockFetch({
			manifest: () => jsonResponse(manifest()),
			binary: () => binaryResponse(Buffer.from("substituted-payload")),
		});
		await expect(ensureExecutorBinary("linux-amd64")).rejects.toThrow(ExecutorDistributionError);
		expect(existsSync(join(HELPER_BIN_DIR, "narrafork-executor-0.5.24-linux-amd64"))).toBe(false);
	});

	test("reports a clear error for a platform the release does not publish", async () => {
		mockFetch({ manifest: () => jsonResponse(manifest()) });
		await expect(ensureExecutorBinary("windows-arm64")).rejects.toThrow(
			/does not publish a build for windows-arm64/,
		);
	});

	test("reports a clear error when no manifest is available at all", async () => {
		mockFetch({ manifest: () => new Response("nope", { status: 404 }) });
		await expect(ensureExecutorBinary("linux-amd64")).rejects.toThrow(/manifest is unavailable/i);
	});
});

describe("getExecutorArtifactDigest", () => {
	test("returns the published digest and rejects unknown platforms", () => {
		expect(getExecutorArtifactDigest(manifest(), "linux-amd64")).toBe(LINUX_SHA256);
		expect(() => getExecutorArtifactDigest(manifest(), "darwin-arm64")).toThrow(
			ExecutorDistributionError,
		);
	});
});
