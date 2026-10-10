import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { EXECUTOR_LICENSE_FILES, HELPER_LICENSE_FILES } from "../../scripts/lib/helper-release";
import { resolveUpdateServerBridgeConfig } from "../../scripts/lib/update-server-bridge-http";
import {
	HELPER_MIRROR_STATE_FILENAME,
	type PreparedToolsMirror,
	prepareUpdateServerToolsMirror,
	publishUpdateServerToolsMirror,
	type RestoreToolsMirrorOptions,
	restoreUpdateServerToolsMirror,
} from "../../scripts/lib/update-server-tools-mirror";
import {
	getHelperAssetName,
	HELPER_MANIFEST_FILENAME,
	HELPER_PLATFORMS,
	HELPER_RELEASE_TAG,
	HELPER_TOOL_VERSIONS,
	HELPER_TOOLS,
} from "../../shared/helper-distribution";
import {
	EXECUTOR_MANIFEST_FILENAME,
	EXECUTOR_PLATFORMS,
	executorPublishedFilename,
} from "../../shared/remote-executor";
import { initConfig } from "../../update-server/lib/config";
import { createToolRoutes } from "../../update-server/routes/tools";
import type { StorageBackend } from "../../update-server/storage/types";

const repo = "FixtureOwner/fixture-repo";
const commit = "a".repeat(40);
const token = "fixture-tools-token-never-real";
const serverUrl = "https://fixture-tools.invalid";
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const temporary: string[] = [];
afterEach(async () => {
	for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});
async function fixture(
	kind: "helpers" | "executor" = "helpers",
	version = kind === "helpers" ? "1.0.0" : "0.8.4",
) {
	await mkdir(join(import.meta.dir, "../../.narrafork"), { recursive: true });
	const dir = await mkdtemp(join(import.meta.dir, "../../.narrafork/tools-mirror-test-"));
	temporary.push(dir);
	const bundleDir = join(dir, "bundle");
	await mkdir(bundleDir);
	const configPath = join(dir, "config.json");
	await writeFile(
		configPath,
		JSON.stringify({
			tokens: [
				{
					id: "fixture",
					name: "fixture",
					tokenHash: digest(token),
					role: "upload",
					createdAt: "1970-01-01T00:00:00Z",
				},
			],
		}),
	);
	await initConfig(configPath);
	const remote = new Map<string, Buffer>();
	const writes: string[] = [];
	const requests: {
		method: string;
		name: string;
		authenticated: boolean;
		redirect?: RequestRedirect;
	}[] = [];
	const storage: StorageBackend = {
		async saveFile(path, data) {
			const bytes = Buffer.isBuffer(data)
				? data
				: Buffer.from(await new Response(data).arrayBuffer());
			remote.set(path.replace("tools/", ""), Buffer.from(bytes));
			writes.push(path.replace("tools/", ""));
		},
		async getFile(path) {
			return remote.get(path.replace("tools/", "")) ?? null;
		},
		async getFileStream(path) {
			const bytes = remote.get(path.replace("tools/", ""));
			return bytes ? new Blob([Uint8Array.from(bytes)]).stream() : null;
		},
		async getFileSize(path) {
			return remote.get(path.replace("tools/", ""))?.length ?? null;
		},
		async deleteFile(path) {
			remote.delete(path.replace("tools/", ""));
		},
		async deleteDirectory() {},
		async listFiles() {
			return [...remote.keys()].map((name) => `tools/${name}`);
		},
		async fileExists(path) {
			return remote.has(path.replace("tools/", ""));
		},
		async getFileSliceStream() {
			return null;
		},
	};
	const app = new Hono().route("/api/v2/tools", createToolRoutes(storage));
	const hook: {
		before?: (request: Request) => Promise<Response | undefined> | Response | undefined;
		beforeRequest?: (input: string | URL | Request, init?: RequestInit) => void;
		after?: (request: Request, response: Response) => Promise<Response> | Response;
	} = {};
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		hook.beforeRequest?.(input, init);
		const request = new Request(input, init);
		const name = new URL(request.url).pathname.split("/").at(-1) as string;
		requests.push({
			method: request.method,
			name,
			authenticated: request.headers.has("authorization"),
			redirect: init?.redirect,
		});
		const intercepted = await hook.before?.(request);
		const response = intercepted ?? (await app.fetch(request));
		return hook.after ? hook.after(request, response) : response;
	}) as typeof fetch;
	const files = new Map<string, Buffer>();
	const artifact = (name: string) => {
		const bytes = Buffer.from(`${kind}:${name}\n`);
		files.set(name, bytes);
		return { name, size: bytes.length, sha256: digest(bytes) };
	};
	const licenses = (kind === "helpers" ? HELPER_LICENSE_FILES : EXECUTOR_LICENSE_FILES).map(
		artifact,
	);
	const manifest =
		kind === "helpers"
			? {
					schemaVersion: 1,
					repository: repo,
					tag: HELPER_RELEASE_TAG,
					commit,
					catalogVersion: "1.0.0",
					files: HELPER_TOOLS.flatMap((tool) =>
						HELPER_PLATFORMS.map((platform) => ({
							tool,
							platform,
							toolVersion: HELPER_TOOL_VERSIONS[tool],
							...artifact(getHelperAssetName(tool, platform)),
						})),
					),
					licenses,
				}
			: {
					schemaVersion: 1,
					repository: repo,
					tag: `executor-v${version}`,
					commit,
					manifest: {
						version,
						protocolVersion: 1,
						releasedAt: "1970-01-01T00:00:00Z",
						platforms: Object.fromEntries(
							EXECUTOR_PLATFORMS.map((platform) => {
								const file = artifact(executorPublishedFilename(version, platform));
								return [platform, { filename: file.name, size: file.size, sha256: file.sha256 }];
							}),
						),
					},
					licenses,
				};
	const manifestName = kind === "helpers" ? HELPER_MANIFEST_FILENAME : EXECUTOR_MANIFEST_FILENAME;
	files.set(manifestName, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
	for (const [name, bytes] of files) await writeFile(join(bundleDir, name), bytes);
	const config = resolveUpdateServerBridgeConfig({
		NF_UPDATE_SERVER: serverUrl,
		NF_UPDATE_TOKEN: token,
	});
	if (!config) throw new Error("Fixture configuration missing");
	const options = {
		kind,
		version,
		repo,
		commit,
		bundleDir,
		bridgeDir: join(dir, "bridge"),
		config,
		fetchImpl,
	};
	return { dir, options, remote, writes, files, requests, hook, manifest, manifestName };
}

async function forgeSealedControl(
	prepared: PreparedToolsMirror,
	mutate: (control: Record<string, unknown>) => void,
): Promise<string> {
	const seal = JSON.parse(await readFile(prepared.sealPath, "utf8"));
	const controlPath = join(prepared.bridgeDir, "assets", seal.control.name);
	const control = JSON.parse(await readFile(controlPath, "utf8")) as Record<string, unknown>;
	mutate(control);
	const bytes = Buffer.from(`${JSON.stringify(control, null, 2)}\n`);
	await writeFile(controlPath, bytes);
	seal.control.size = bytes.length;
	seal.control.sha256 = digest(bytes);
	const sealBytes = `${JSON.stringify(seal, null, 2)}\n`;
	await writeFile(prepared.sealPath, sealBytes);
	const forgedSha = digest(sealBytes);
	const receipt = JSON.parse(await readFile(prepared.receiptPath, "utf8"));
	receipt.sealSha256 = forgedSha;
	await writeFile(prepared.receiptPath, JSON.stringify(receipt));
	return forgedSha;
}

describe("legacy tools mirror using the actual Hono PUT/GET route", () => {
	test("first helper takeover snapshots aliases, uploads exact bytes and publishes receipt last", async () => {
		const f = await fixture();
		f.remote.set("rg-linux-x64", Buffer.from("legacy rg bytes"));
		const prepared = await prepareUpdateServerToolsMirror(f.options);
		expect(f.writes).toEqual([]);
		const seal = JSON.parse(await readFile(prepared.sealPath, "utf8"));
		expect(
			seal.assets.find((file: { name: string }) => file.name === "rg-linux-x64").observed.sha256,
		).toBe(digest("legacy rg bytes"));
		const result = await publishUpdateServerToolsMirror(prepared, f.options.config, f.options);
		expect(result.status).toBe("MIRRORED");
		expect(result.atomic).toBe(false);
		expect(result.warning).toContain("no CAS");
		expect(f.writes.at(-1)).toBe(HELPER_MIRROR_STATE_FILENAME);
		expect(f.remote.has(HELPER_MANIFEST_FILENAME)).toBe(false);
		for (const [name, bytes] of f.files)
			if (name !== f.manifestName) expect(f.remote.get(name)).toEqual(bytes);
		const state = JSON.parse(f.remote.get(HELPER_MIRROR_STATE_FILENAME)?.toString() ?? "");
		expect(state.manifestSha256).toBe(digest(f.files.get(f.manifestName) as Buffer));
		expect(JSON.stringify(state)).not.toContain(token);
		expect(await readFile(prepared.sealPath, "utf8")).not.toContain(token);
		expect(await readFile(prepared.receiptPath, "utf8")).not.toContain(token);
		expect(f.requests.every((request) => request.redirect === "error")).toBe(true);
		expect(
			f.requests
				.filter((request) => request.method === "GET")
				.every((request) => !request.authenticated),
		).toBe(true);
	});
	test("executor validates all six binaries and projects only inner manifest LAST", async () => {
		const f = await fixture("executor");
		const prepared = await prepareUpdateServerToolsMirror(f.options);
		await publishUpdateServerToolsMirror(prepared, f.options.config, f.options);
		expect(f.writes.at(-1)).toBe(EXECUTOR_MANIFEST_FILENAME);
		const inner = JSON.parse(f.remote.get(EXECUTOR_MANIFEST_FILENAME)?.toString() ?? "");
		expect(inner).toEqual((f.manifest as { manifest: unknown }).manifest);
		expect(inner.repository).toBeUndefined();
		expect(inner.licenses).toBeUndefined();
		expect(f.writes.filter((name) => name.startsWith("narrafork-executor-"))).toHaveLength(7);
	});
	test("existing verified aliases skip PUT including final marker", async () => {
		const f = await fixture();
		const prepared = await prepareUpdateServerToolsMirror(f.options);
		await publishUpdateServerToolsMirror(prepared, f.options.config, f.options);
		const initial = [...f.writes];
		await publishUpdateServerToolsMirror(prepared, f.options.config, f.options);
		expect(f.writes).toEqual(initial);
	});
	test("all source hashes and licenses are prechecked before remote PUT", async () => {
		const f = await fixture();
		await writeFile(join(f.options.bundleDir, "zstd-win-arm64.exe"), "tampered");
		await expect(prepareUpdateServerToolsMirror(f.options)).rejects.toThrow("mismatch");
		expect(f.writes).toEqual([]);
	});
	test("outer executor repository/commit/protocol must match, no projection bypass", async () => {
		const f = await fixture("executor");
		const outer = f.manifest as { commit: string };
		outer.commit = "b".repeat(40);
		await writeFile(join(f.options.bundleDir, f.manifestName), JSON.stringify(outer));
		await expect(prepareUpdateServerToolsMirror(f.options)).rejects.toThrow("identity");
		expect(f.requests).toEqual([]);
	});
	test("executor existing immutable versioned binary conflict fails ALL preflight", async () => {
		const f = await fixture("executor");
		f.remote.set(executorPublishedFilename("0.8.4", "windows-arm64"), Buffer.from("different"));
		await expect(prepareUpdateServerToolsMirror(f.options)).rejects.toThrow("alias change");
		expect(f.writes).toEqual([]);
	});
	test("newer executor manifest blocks stale preparation before any upload", async () => {
		const f = await fixture("executor");
		const old = {
			version: "0.8.5",
			protocolVersion: 1,
			releasedAt: "1970-01-01T00:00:00Z",
			platforms: {
				"linux-amd64": {
					filename: executorPublishedFilename("0.8.5", "linux-amd64"),
					size: 1,
					sha256: "f".repeat(64),
				},
			},
		};
		f.remote.set(EXECUTOR_MANIFEST_FILENAME, Buffer.from(JSON.stringify(old)));
		await expect(prepareUpdateServerToolsMirror(f.options)).rejects.toThrow("rollback");
		expect(f.writes).toEqual([]);
	});
	test("same executor version different binary digest is a conflict", async () => {
		const f = await fixture("executor");
		const old = structuredClone(
			(f.manifest as { manifest: { platforms: Record<string, { sha256: string }> } }).manifest,
		);
		const platform = old.platforms["linux-amd64"];
		if (!platform) throw new Error("fixture missing platform");
		platform.sha256 = "f".repeat(64);
		f.remote.set(EXECUTOR_MANIFEST_FILENAME, Buffer.from(JSON.stringify(old)));
		await expect(prepareUpdateServerToolsMirror(f.options)).rejects.toThrow(
			"different manifest digest",
		);
		expect(f.writes).toEqual([]);
	});
	test("post-prepare unknown helper alias drift fails closed, no clobber", async () => {
		const f = await fixture();
		f.remote.set("rg-linux-x64", Buffer.from("old"));
		const prepared = await prepareUpdateServerToolsMirror(f.options);
		f.remote.set("rg-linux-x64", Buffer.from("external edit"));
		await expect(
			publishUpdateServerToolsMirror(prepared, f.options.config, f.options),
		).rejects.toThrow("PUBLISHED_NOT_MIRRORED");
		expect(f.writes).toEqual([]);
		expect(f.remote.get("rg-linux-x64")?.toString()).toBe("external edit");
	});
	test("existing helper receipt with newer catalog blocks rollback", async () => {
		const f = await fixture();
		const prepared = await prepareUpdateServerToolsMirror(f.options);
		await publishUpdateServerToolsMirror(prepared, f.options.config, f.options);
		const state = JSON.parse(f.remote.get(HELPER_MIRROR_STATE_FILENAME)?.toString() ?? "");
		state.catalogVersion = "2.0.0";
		state.tag = "helpers-v2.0.0";
		f.remote.set(HELPER_MIRROR_STATE_FILENAME, Buffer.from(JSON.stringify(state)));
		f.writes.splice(0);
		await expect(
			prepareUpdateServerToolsMirror({ ...f.options, bridgeDir: join(f.dir, "bridge2") }),
		).rejects.toThrow("rollback");
		expect(f.writes).toEqual([]);
	});
	test("same helper catalog commit conflict and receipt-owned alias drift cannot be adopted", async () => {
		const f = await fixture();
		const prepared = await prepareUpdateServerToolsMirror(f.options);
		await publishUpdateServerToolsMirror(prepared, f.options.config, f.options);
		f.writes.splice(0);
		f.remote.set("rg-linux-x64", Buffer.from("external unrecorded bytes"));
		await expect(
			prepareUpdateServerToolsMirror({ ...f.options, bridgeDir: join(f.dir, "bridge2") }),
		).rejects.toThrow("alias drift");
		f.remote.set("rg-linux-x64", f.files.get("rg-linux-x64") as Buffer);
		const state = JSON.parse(f.remote.get(HELPER_MIRROR_STATE_FILENAME)?.toString() ?? "");
		state.commit = "b".repeat(40);
		f.remote.set(HELPER_MIRROR_STATE_FILENAME, Buffer.from(JSON.stringify(state)));
		await expect(
			prepareUpdateServerToolsMirror({ ...f.options, bridgeDir: join(f.dir, "bridge3") }),
		).rejects.toThrow("catalog identity");
		expect(f.writes).toEqual([]);
	});
	test("partial lost response resumes from frozen before/target hashes without republishing known bytes", async () => {
		const f = await fixture("executor");
		const prepared = await prepareUpdateServerToolsMirror(f.options);
		let puts = 0;
		f.hook.before = (request) => {
			if (request.method === "PUT" && ++puts === 3)
				return new Response("unavailable", { status: 503 });
		};
		await expect(
			publishUpdateServerToolsMirror(prepared, f.options.config, f.options),
		).rejects.toThrow("PUBLISHED_NOT_MIRRORED");
		expect(f.remote.has(EXECUTOR_MANIFEST_FILENAME)).toBe(false);
		const completed = [...f.writes];
		expect(completed.length).toBe(2);
		const receipt = JSON.parse(await readFile(prepared.receiptPath, "utf8"));
		expect(receipt.verified).toEqual(completed);
		f.hook.before = undefined;
		const restored = await restoreUpdateServerToolsMirror({
			...f.options,
			trustedSealSha256: prepared.sealSha256,
		});
		await publishUpdateServerToolsMirror(restored, f.options.config, f.options);
		for (const name of completed)
			expect(f.writes.filter((write) => write === name)).toHaveLength(1);
		expect(f.writes.at(-1)).toBe(EXECUTOR_MANIFEST_FILENAME);
	});
	test("mirror-only refuses a new source or endpoint and never snapshots drift anew", async () => {
		const f = await fixture();
		const prepared = await prepareUpdateServerToolsMirror(f.options);
		await expect(
			restoreUpdateServerToolsMirror({
				trustedSealSha256: prepared.sealSha256,
				...f.options,
				commit: "b".repeat(40),
			}),
		).rejects.toThrow("identity");
		await expect(
			restoreUpdateServerToolsMirror({
				trustedSealSha256: prepared.sealSha256,
				...f.options,
				config: { serverUrl: "https://another.invalid", token },
			}),
		).rejects.toThrow("identity");
		f.remote.set("rg-linux-x64", Buffer.from("unknown"));
		await expect(
			restoreUpdateServerToolsMirror({ ...f.options, trustedSealSha256: prepared.sealSha256 }),
		).rejects.toThrow("alias change");
		expect(f.writes).toEqual([]);
		expect(JSON.parse(await readFile(prepared.receiptPath, "utf8")).status).toBe("PREPARED");
	});
	test("remote corruption after upload prevents manifest-last and preserves failure receipt", async () => {
		const f = await fixture("executor");
		const prepared = await prepareUpdateServerToolsMirror(f.options);
		f.hook.before = (request) => {
			if (request.method === "GET" && f.writes.length > 0) {
				const name = new URL(request.url).pathname.split("/").at(-1) as string;
				if (name === f.writes[0]) f.remote.set(name, Buffer.from("corrupt"));
			}
		};
		await expect(
			publishUpdateServerToolsMirror(prepared, f.options.config, f.options),
		).rejects.toThrow("PUBLISHED_NOT_MIRRORED");
		expect(f.remote.has(EXECUTOR_MANIFEST_FILENAME)).toBe(false);
		expect(JSON.parse(await readFile(prepared.receiptPath, "utf8")).status).toBe(
			"PUBLISHED_NOT_MIRRORED",
		);
	});
	test("executor newer manifest appearing during publish forbids marker rollback", async () => {
		const f = await fixture("executor");
		const prepared = await prepareUpdateServerToolsMirror(f.options);
		f.hook.before = (request) => {
			if (request.method === "GET" && f.writes.length > 0) {
				f.remote.set(
					EXECUTOR_MANIFEST_FILENAME,
					Buffer.from(
						JSON.stringify({
							version: "0.8.5",
							protocolVersion: 1,
							releasedAt: "1970-01-01T00:00:00Z",
							platforms: {
								"linux-amd64": {
									filename: executorPublishedFilename("0.8.5", "linux-amd64"),
									size: 1,
									sha256: "f".repeat(64),
								},
							},
						}),
					),
				);
			}
		};
		await expect(
			publishUpdateServerToolsMirror(prepared, f.options.config, f.options),
		).rejects.toThrow("PUBLISHED_NOT_MIRRORED");
		expect(f.writes).not.toContain(EXECUTOR_MANIFEST_FILENAME);
	});
	test("bounded metadata and binary readers reject oversized declared body before writes", async () => {
		const f = await fixture();
		f.hook.before = (request) =>
			request.url.endsWith("rg-linux-x64")
				? new Response("x", { headers: { "content-length": String(32 * 1024 * 1024 + 1) } })
				: undefined;
		await expect(prepareUpdateServerToolsMirror(f.options)).rejects.toThrow("operation failed");
		expect(f.writes).toEqual([]);
	});
	test("body timeout, parent cancellation and transport failures sanitize errors", async () => {
		const f = await fixture();
		const prepared = await prepareUpdateServerToolsMirror(f.options);
		f.hook.before = (request) =>
			request.method === "PUT" ? Promise.reject(new Error(`secret:${token}`)) : undefined;
		await expect(
			publishUpdateServerToolsMirror(prepared, f.options.config, f.options),
		).rejects.toThrow("PUBLISHED_NOT_MIRRORED");
		expect(await readFile(prepared.receiptPath, "utf8")).not.toContain(token);
		f.hook.before = () => new Response(new ReadableStream({ start() {} }));
		await expect(
			restoreUpdateServerToolsMirror({
				trustedSealSha256: prepared.sealSha256,
				...f.options,
				requestTimeoutMs: 10,
			}),
		).rejects.toThrow("operation failed");
		const abort = new AbortController();
		abort.abort();
		await expect(
			restoreUpdateServerToolsMirror({
				trustedSealSha256: prepared.sealSha256,
				...f.options,
				signal: abort.signal,
			}),
		).rejects.toThrow();
	});
	test("frozen artifact tampering cannot resume", async () => {
		const f = await fixture();
		const prepared = await prepareUpdateServerToolsMirror(f.options);
		await writeFile(join(prepared.bridgeDir, "assets", "rg-linux-x64"), "tamper");
		await expect(
			publishUpdateServerToolsMirror(prepared, f.options.config, f.options),
		).rejects.toThrow("asset changed");
		expect(f.writes).toEqual([]);
	});
	test("a PUT committed by the real route but with lost acknowledgement resumes without clobber", async () => {
		const f = await fixture();
		const prepared = await prepareUpdateServerToolsMirror(f.options);
		f.hook.after = (request, response) =>
			request.method === "PUT" ? new Response("lost ack", { status: 502 }) : response;
		await expect(
			publishUpdateServerToolsMirror(prepared, f.options.config, f.options),
		).rejects.toThrow("PUBLISHED_NOT_MIRRORED");
		expect(f.writes).toHaveLength(1);
		const ownPartial = f.writes[0];
		f.hook.after = undefined;
		const restored = await restoreUpdateServerToolsMirror({
			...f.options,
			trustedSealSha256: prepared.sealSha256,
		});
		await publishUpdateServerToolsMirror(restored, f.options.config, f.options);
		expect(f.writes.filter((name) => name === ownPartial)).toHaveLength(1);
	});
	test("authenticated redirect fails with no request to Location and no credential in artifact", async () => {
		const f = await fixture();
		const prepared = await prepareUpdateServerToolsMirror(f.options);
		f.hook.before = (request) =>
			request.method === "PUT"
				? new Response(null, {
						status: 307,
						headers: { location: "https://untrusted.invalid/steal" },
					})
				: undefined;
		await expect(
			publishUpdateServerToolsMirror(prepared, f.options.config, f.options),
		).rejects.toThrow("PUBLISHED_NOT_MIRRORED");
		expect(f.requests.every((request) => request.redirect === "error")).toBe(true);
		expect(f.writes).toEqual([]);
		expect(await readFile(prepared.receiptPath, "utf8")).not.toContain(token);
	});
	test("unbounded binary body is stopped at 32MiB and cancelled", async () => {
		const f = await fixture();
		let cancelled = false;
		let emitted = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				emitted++;
				controller.enqueue(new Uint8Array(64 * 1024));
			},
			cancel() {
				cancelled = true;
			},
		});
		f.hook.before = (request) =>
			request.url.endsWith("rg-linux-x64") ? new Response(stream) : undefined;
		await expect(prepareUpdateServerToolsMirror(f.options)).rejects.toThrow("operation failed");
		expect(cancelled).toBe(true);
		expect(emitted).toBeLessThan(520);
		expect(f.writes).toEqual([]);
	});
	test("local and remote manifests are capped at 64KiB before any PUT", async () => {
		const f = await fixture();
		await writeFile(join(f.options.bundleDir, f.manifestName), " ".repeat(64 * 1024 + 1));
		await expect(prepareUpdateServerToolsMirror(f.options)).rejects.toThrow("size/type");
		expect(f.requests).toEqual([]);
		await writeFile(
			join(f.options.bundleDir, f.manifestName),
			f.files.get(f.manifestName) as Buffer,
		);
		f.hook.before = (request) =>
			request.url.endsWith(HELPER_MIRROR_STATE_FILENAME)
				? new Response("x", { headers: { "content-length": String(64 * 1024 + 1) } })
				: undefined;
		await expect(prepareUpdateServerToolsMirror(f.options)).rejects.toThrow("operation failed");
		expect(f.writes).toEqual([]);
	});
	test("a lower-version control changed by an external publisher is unknown even during publication", async () => {
		const f = await fixture("executor");
		const old = {
			version: "0.8.2",
			protocolVersion: 1,
			releasedAt: "1970-01-01T00:00:00Z",
			platforms: {
				"linux-amd64": {
					filename: executorPublishedFilename("0.8.2", "linux-amd64"),
					size: 1,
					sha256: "f".repeat(64),
				},
			},
		};
		f.remote.set(EXECUTOR_MANIFEST_FILENAME, Buffer.from(JSON.stringify(old)));
		const prepared = await prepareUpdateServerToolsMirror(f.options);
		f.hook.before = (request) => {
			if (request.method === "GET" && f.writes.length > 0) {
				f.remote.set(
					EXECUTOR_MANIFEST_FILENAME,
					Buffer.from(JSON.stringify({ ...old, releasedAt: "2000-01-01T00:00:00Z" })),
				);
			}
		};
		await expect(
			publishUpdateServerToolsMirror(prepared, f.options.config, f.options),
		).rejects.toThrow("PUBLISHED_NOT_MIRRORED");
		expect(f.writes).toHaveLength(1);
	});
	test("manifest binary sizes cannot expand the existing 32MiB consumer ceiling", async () => {
		const f = await fixture("executor");
		const outer = f.manifest as { manifest: { platforms: Record<string, { size: number }> } };
		const platform = outer.manifest.platforms["linux-amd64"];
		if (!platform) throw new Error("missing fixture platform");
		platform.size = 32 * 1024 * 1024 + 1;
		await writeFile(join(f.options.bundleDir, f.manifestName), JSON.stringify(outer));
		await expect(prepareUpdateServerToolsMirror(f.options)).rejects.toThrow("platform mismatch");
		expect(f.requests).toEqual([]);
	});
	test("new helper catalog written after partial success prevents stale recovery", async () => {
		const f = await fixture();
		const prepared = await prepareUpdateServerToolsMirror({
			...f.options,
			sourceRunId: "123",
			sourceRunAttempt: "1",
		});
		f.hook.after = (request, response) =>
			request.method === "PUT" ? new Response(null, { status: 503 }) : response;
		await expect(
			publishUpdateServerToolsMirror(prepared, f.options.config, f.options),
		).rejects.toThrow("PUBLISHED_NOT_MIRRORED");
		f.hook.after = undefined;
		await expect(
			restoreUpdateServerToolsMirror({
				trustedSealSha256: prepared.sealSha256,
				...f.options,
				sourceRunId: "456",
			}),
		).rejects.toThrow("sealed identity");
		const state = JSON.parse(
			await readFile(join(prepared.bridgeDir, "assets", HELPER_MIRROR_STATE_FILENAME), "utf8"),
		);
		state.catalogVersion = "2.0.0";
		state.tag = "helpers-v2.0.0";
		f.remote.set(HELPER_MIRROR_STATE_FILENAME, Buffer.from(JSON.stringify(state)));
		const before = [...f.writes];
		await expect(
			restoreUpdateServerToolsMirror({
				trustedSealSha256: prepared.sealSha256,
				...f.options,
				sourceRunId: "123",
				sourceRunAttempt: "1",
			}),
		).rejects.toThrow("rollback");
		expect(f.writes).toEqual(before);
	});
	test("frozen binary changed during public preflight is rejected before authenticated PUT", async () => {
		const f = await fixture();
		const prepared = await prepareUpdateServerToolsMirror(f.options);
		f.hook.before = async (request) => {
			if (request.method === "GET" && request.url.endsWith("rg-linux-x64")) {
				await writeFile(
					join(prepared.bridgeDir, "assets", "rg-linux-x64"),
					"modified after initial verification",
				);
			}
		};
		await expect(
			publishUpdateServerToolsMirror(prepared, f.options.config, f.options),
		).rejects.toThrow("PUBLISHED_NOT_MIRRORED");
		expect(f.writes).toEqual([]);
	});
	test("restore requires an independent trusted digest and refuses mismatching expected seals", async () => {
		const f = await fixture();
		const prepared = await prepareUpdateServerToolsMirror(f.options);
		f.requests.splice(0);
		await expect(
			restoreUpdateServerToolsMirror(f.options as RestoreToolsMirrorOptions),
		).rejects.toThrow("independent trusted");
		await expect(
			restoreUpdateServerToolsMirror({ ...f.options, trustedSealSha256: "0".repeat(64) }),
		).rejects.toThrow("trusted digest mismatch");
		expect(f.requests).toEqual([]);
		expect(f.writes).toEqual([]);
		expect(JSON.parse(await readFile(prepared.receiptPath, "utf8")).sealSha256).toBe(
			prepared.sealSha256,
		);
	});
	test("self-signed receipt and resealed executor control cannot replace the original trusted seal", async () => {
		const f = await fixture("executor");
		const prepared = await prepareUpdateServerToolsMirror(f.options);
		await forgeSealedControl(prepared, (inner) => {
			inner.protocolVersion = 999;
		});
		f.requests.splice(0);
		await expect(
			restoreUpdateServerToolsMirror({ ...f.options, trustedSealSha256: prepared.sealSha256 }),
		).rejects.toThrow("trusted digest mismatch");
		expect(f.requests).toEqual([]);
		expect(f.writes).toEqual([]);
		expect((await readFile(join(f.options.bundleDir, f.manifestName))).toString("utf8")).toBe(
			f.files.get(f.manifestName)?.toString("utf8") ?? "",
		);
	});
	test("even a newly supplied seal digest cannot authorize an executor control not projected from the original outer", async () => {
		const f = await fixture("executor");
		const prepared = await prepareUpdateServerToolsMirror(f.options);
		const forgedSha = await forgeSealedControl(prepared, (inner) => {
			inner.releasedAt = "2099-01-01T00:00:00Z";
		});
		f.requests.splice(0);
		await expect(
			restoreUpdateServerToolsMirror({ ...f.options, trustedSealSha256: forgedSha }),
		).rejects.toThrow("original manifest projection");
		await expect(
			publishUpdateServerToolsMirror(
				{ ...prepared, sealSha256: forgedSha },
				f.options.config,
				f.options,
			),
		).rejects.toThrow("original manifest projection");
		expect(f.requests).toEqual([]);
		expect(f.writes).toEqual([]);
	});
	for (const [field, changed] of [
		["repository", "DifferentOwner/repo"],
		["tag", "helpers-v9.0.0"],
		["commit", "b".repeat(40)],
		["catalogVersion", "9.0.0"],
		["manifestSha256", "f".repeat(64)],
	] as const) {
		test(`resealed helper marker ${field} must still match the original manifest`, async () => {
			const f = await fixture();
			const prepared = await prepareUpdateServerToolsMirror(f.options);
			const forgedSha = await forgeSealedControl(prepared, (marker) => {
				marker[field] = changed;
			});
			f.requests.splice(0);
			await expect(
				restoreUpdateServerToolsMirror({ ...f.options, trustedSealSha256: forgedSha }),
			).rejects.toThrow("original manifest projection");
			expect(f.requests).toEqual([]);
			expect(f.writes).toEqual([]);
		});
	}
	test("resealed helper marker asset hash cannot invent license/binary provenance", async () => {
		const f = await fixture();
		const prepared = await prepareUpdateServerToolsMirror(f.options);
		const forgedSha = await forgeSealedControl(prepared, (marker) => {
			const files = marker.files as { sha256: string }[];
			if (!files[0]) throw new Error("Missing fixture files");
			files[0].sha256 = "f".repeat(64);
		});
		f.requests.splice(0);
		await expect(
			restoreUpdateServerToolsMirror({ ...f.options, trustedSealSha256: forgedSha }),
		).rejects.toThrow("original manifest projection");
		expect(f.requests).toEqual([]);
		expect(f.writes).toEqual([]);
	});
	for (const kind of ["helpers", "executor"] as const) {
		for (const target of ["binary", "control"] as const) {
			for (const mutation of ["replace-path", "write-inode"] as const) {
				test(`${kind} ${target} PUT retains sealed bytes after in-flight ${mutation}`, async () => {
					const f = await fixture(kind);
					const prepared = await prepareUpdateServerToolsMirror(f.options);
					const name =
						target === "control"
							? kind === "helpers"
								? HELPER_MIRROR_STATE_FILENAME
								: EXECUTOR_MANIFEST_FILENAME
							: kind === "helpers"
								? "rg-linux-x64"
								: executorPublishedFilename(f.options.version, "linux-amd64");
					const publicPath = join(prepared.bridgeDir, "assets", name);
					const sealedBytes = await readFile(publicPath);
					let mutated = false;
					// Mutation happens synchronously at fetch entry, after upload FD selection but before
					// the request body can be prefetched. This also exercises tiny JSON bodies honestly.
					f.hook.beforeRequest = (input, init) => {
						if (init?.method === "PUT" && String(input).endsWith(name) && !mutated) {
							mutated = true;
							const changed = Buffer.alloc(sealedBytes.length, 0x58);
							if (mutation === "replace-path") {
								writeFileSync(`${publicPath}.replacement`, changed, { flag: "wx" });
								renameSync(`${publicPath}.replacement`, publicPath);
							} else {
								writeFileSync(publicPath, changed, { flag: "r+" });
							}
						}
					};
					const result = await publishUpdateServerToolsMirror(
						prepared,
						f.options.config,
						f.options,
					);
					expect(result.status).toBe("MIRRORED");
					expect(mutated).toBe(true);
					expect(f.remote.get(name)?.toString("hex")).toBe(sealedBytes.toString("hex"));
					expect((await readFile(publicPath)).equals(sealedBytes)).toBe(false);
				});
			}
		}
	}
});
