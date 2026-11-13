import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { verifyRemoteFrontendInstallation } from "../scripts/lib/remote-frontend-artifact";
import type { RemoteFrontendCatalogEntry } from "../shared/remote-access/frontend-catalog";
import {
	isRemoteFrontendAssetPath,
	isRemoteFrontendDigest,
	type RemoteFrontendManifest,
} from "../shared/remote-access/frontend-manifest";
import { assertHostDirectory, readRemoteBootstrap, readRemoteFrontendCatalog } from "./store";

export interface RemoteHostOptions {
	storePath: string;
	bootstrapBuildId?: string;
	allowLocalhost?: boolean;
	instanceDomain?: string;
	allowedOrigins?: readonly string[];
	signal?: AbortSignal;
}
interface FileIdentity {
	size: number;
	dev: number;
	ino: number;
	mtimeMs: number;
	ctimeMs: number;
}
interface Installed {
	manifest: RemoteFrontendManifest;
	entry: RemoteFrontendCatalogEntry;
	files: Map<string, FileIdentity>;
}
const securityHeaders = {
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
	"Cross-Origin-Resource-Policy": "same-origin",
	"X-Frame-Options": "DENY",
};
function mime(path: string): string {
	if (/\.m?js$/.test(path)) return "text/javascript; charset=utf-8";
	if (path.endsWith(".css")) return "text/css; charset=utf-8";
	if (path.endsWith(".json")) return "application/json; charset=utf-8";
	if (path.endsWith(".wasm")) return "application/wasm";
	if (path.endsWith(".svg")) return "image/svg+xml";
	if (path.endsWith(".png")) return "image/png";
	if (path.endsWith(".woff2")) return "font/woff2";
	if (path.endsWith(".woff")) return "font/woff";
	if (path.endsWith(".html")) return "text/html; charset=utf-8";
	return "application/octet-stream";
}
function trustedOrigin(url: URL, options: RemoteHostOptions): boolean {
	if (url.username || url.password) return false;
	const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
	if (loopback && options.allowLocalhost && (url.protocol === "http:" || url.protocol === "https:"))
		return true;
	if (url.protocol !== "https:") return false;
	if (options.allowedOrigins?.includes(url.origin))
		return /^[a-z2-7]{52}$/.test(url.hostname.split(".")[0] ?? "");
	const domain = options.instanceDomain?.toLowerCase();
	return (
		!!domain &&
		url.hostname.endsWith(`.${domain}`) &&
		/^[a-z2-7]{52}$/.test(url.hostname.slice(0, -domain.length - 1))
	);
}
function entryMatches(entry: RemoteFrontendCatalogEntry, known: Installed): boolean {
	const manifest = known.manifest;
	return (
		entry.manifestSha256 === known.entry.manifestSha256 &&
		entry.repository === manifest.repository &&
		entry.nfVersion === manifest.nfVersion &&
		entry.bootstrapAbi === manifest.capability.bootstrapAbi &&
		entry.apiEpoch === manifest.capability.apiEpoch &&
		entry.wireVersion === manifest.capability.wireVersion
	);
}

/** Startup/reload verifies immutable installations before any listener is started.
 * assetHandler has no path to archive/import APIs: only bounded control reads and file streaming.
 */
export async function createRemoteHost(options: RemoteHostOptions) {
	const store = resolve(options.storePath);
	await assertHostDirectory(store);
	const bootstrapBuildId = options.bootstrapBuildId ?? (await readRemoteBootstrap(store));
	if (!isRemoteFrontendDigest(bootstrapBuildId))
		throw new Error("REMOTE_HOST_BOOTSTRAP_CONFIG_INVALID");
	if (options.instanceDomain && !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(options.instanceDomain))
		throw new Error("REMOTE_HOST_DOMAIN_INVALID");
	let installed = new Map<string, Installed>();
	let activeStreams = 0;
	async function reload(): Promise<void> {
		const deadline = AbortSignal.any([
				...(options.signal ? [options.signal] : []),
				AbortSignal.timeout(5 * 60_000),
			]),
			catalog = await readRemoteFrontendCatalog(store),
			next = new Map<string, Installed>();
		let count = 0;
		for (const entry of catalog.entries) {
			deadline.throwIfAborted();
			if (entry.disabled) continue;
			const directory = join(store, "frontends", entry.buildId),
				manifest = await verifyRemoteFrontendInstallation(
					directory,
					entry.manifestSha256,
					deadline,
				);
			count += manifest.files.length;
			if (count > 65536) throw new Error("REMOTE_HOST_ACTIVE_FILE_BUDGET");
			const files = new Map<string, FileIdentity>();
			for (const name of ["manifest.json", ...manifest.files.map((file) => file.path)]) {
				const stat = await lstat(join(directory, name));
				if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("REMOTE_HOST_UNSAFE_FILE");
				files.set(name, {
					size: stat.size,
					dev: stat.dev,
					ino: stat.ino,
					mtimeMs: stat.mtimeMs,
					ctimeMs: stat.ctimeMs,
				});
			}
			const value = { manifest, entry, files };
			if (!entryMatches(entry, value)) throw new Error("REMOTE_HOST_CATALOG_IDENTITY_MISMATCH");
			next.set(entry.buildId, value);
		}
		if (!next.has(bootstrapBuildId)) throw new Error("REMOTE_HOST_BOOTSTRAP_UNAVAILABLE");
		installed = next;
	}
	await reload();
	const unavailable = (status = 404) =>
		new Response(null, { status, headers: { ...securityHeaders, "Cache-Control": "no-store" } });
	async function fileResponse(
		request: Request,
		buildId: string,
		path: string,
		known: Installed,
	): Promise<Response> {
		const expected = known.files.get(path);
		if (!expected) return unavailable();
		const root = join(store, "frontends", buildId),
			segments = path.split("/");
		let parent = root;
		const rootStat = await lstat(root);
		if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return unavailable();
		for (const segment of segments.slice(0, -1)) {
			parent = join(parent, segment);
			const stat = await lstat(parent);
			if (!stat.isDirectory() || stat.isSymbolicLink()) return unavailable();
		}
		const full = join(root, path),
			before = await lstat(full);
		if (
			!before.isFile() ||
			before.isSymbolicLink() ||
			before.size !== expected.size ||
			before.dev !== expected.dev ||
			before.ino !== expected.ino ||
			before.mtimeMs !== expected.mtimeMs ||
			before.ctimeMs !== expected.ctimeMs
		)
			return unavailable();
		const handle = await open(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		let handedOff = false;
		try {
			const current = await handle.stat();
			if (
				current.dev !== expected.dev ||
				current.ino !== expected.ino ||
				current.size !== expected.size
			)
				return unavailable();
			const digest =
				path === "manifest.json"
					? known.entry.manifestSha256
					: known.manifest.files.find((file) => file.path === path)?.sha256;
			const headers = new Headers({
				...securityHeaders,
				"Content-Type": mime(path),
				"Content-Length": String(expected.size),
				"Cache-Control": "public, max-age=31536000, immutable",
				ETag: `"${digest}"`,
			});
			if (request.headers.get("if-none-match") === headers.get("etag"))
				return new Response(null, { status: 304, headers });
			if (request.method === "HEAD") return new Response(null, { status: 200, headers });
			if (activeStreams >= 128) return unavailable(503);
			activeStreams++;
			let position = 0,
				closed = false;
			const close = async () => {
				if (closed) return;
				closed = true;
				activeStreams--;
				clearTimeout(deadline);
				request.signal.removeEventListener("abort", abort);
				await handle.close();
			};
			const abort = () => {
				void close();
			};
			const deadline = setTimeout(() => {
				void close();
			}, 5 * 60_000);
			deadline.unref();
			request.signal.addEventListener("abort", abort, { once: true });
			const body = new ReadableStream<Uint8Array>(
				{
					async pull(controller) {
						if (closed || request.signal.aborted) {
							await close();
							controller.error(new Error("REMOTE_HOST_REQUEST_CANCELLED"));
							return;
						}
						try {
							if (position === expected.size) {
								await close();
								controller.close();
								return;
							}
							const buffer = new Uint8Array(Math.min(64 * 1024, expected.size - position));
							const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
							if (!bytesRead) throw new Error("REMOTE_HOST_FILE_CHANGED");
							position += bytesRead;
							controller.enqueue(buffer.subarray(0, bytesRead));
						} catch (error) {
							await close();
							controller.error(error);
						}
					},
					async cancel() {
						await close();
					},
				},
				{ highWaterMark: 0 },
			);
			handedOff = true;
			return new Response(body, { status: 200, headers });
		} finally {
			if (!handedOff) await handle.close();
		}
	}
	async function assetHandler(request: Request): Promise<Response | undefined> {
		const url = new URL(request.url),
			path = url.pathname;
		if (path.startsWith("/signal/")) return undefined;
		if (path === "/api" || path.startsWith("/api/") || path === "/ws" || path.startsWith("/ws/"))
			return unavailable();
		if (!["GET", "HEAD"].includes(request.method)) return unavailable(405);
		if (!trustedOrigin(url, options)) return unavailable(421);
		if (
			path.includes("%") ||
			path.includes("\\") ||
			path.includes("//") ||
			[...path].some(
				(character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
			)
		)
			return unavailable();
		try {
			const catalog = await readRemoteFrontendCatalog(store);
			if (path === "/remote/catalog.json")
				return new Response(request.method === "HEAD" ? null : JSON.stringify(catalog), {
					headers: {
						...securityHeaders,
						"Content-Type": "application/json; charset=utf-8",
						"Cache-Control": "no-store",
					},
				});
			if (path.startsWith("/remote/frontends/")) {
				const match = /^\/remote\/frontends\/([a-f0-9]{64})\/(.+)$/.exec(path);
				if (!match || !isRemoteFrontendAssetPath(match[2])) return unavailable();
				const entry = catalog.entries.find((entry) => entry.buildId === match[1]),
					known = installed.get(match[1]);
				if (!entry || entry.disabled || !known || !entryMatches(entry, known)) return unavailable();
				return await fileResponse(request, match[1], match[2], known);
			}
			if (path.startsWith("/remote/") || /\.[^/]+$/.test(path) || !/^\/[A-Za-z0-9_/-]*$/.test(path))
				return unavailable();
			const bootstrap = installed.get(bootstrapBuildId),
				entry = catalog.entries.find((entry) => entry.buildId === bootstrapBuildId);
			if (!bootstrap || !entry || entry.disabled || !entryMatches(entry, bootstrap))
				return unavailable(503);
			const base = `/remote/frontends/${bootstrapBuildId}/`,
				file = bootstrap.manifest.files.find((file) => file.path === bootstrap.manifest.bootstrap);
			if (!file) return unavailable(503);
			const integrity = `sha256-${Buffer.from(file.sha256, "hex").toString("base64")}`;
			const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>NarraFork remote</title></head><body><div id="root">Connecting…</div><script type="module" crossorigin="anonymous" integrity="${integrity}" src="${base}${bootstrap.manifest.bootstrap}"></script></body></html>`;
			return new Response(request.method === "HEAD" ? null : html, {
				headers: {
					...securityHeaders,
					"Content-Type": "text/html; charset=utf-8",
					"Cache-Control": "no-store",
					"Content-Security-Policy": `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src blob:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self' wss:${options.allowLocalhost ? " ws:" : ""}; frame-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
				},
			});
		} catch {
			return unavailable(503);
		}
	}
	return { assetHandler, reload, bootstrapBuildId };
}

export { configureRemoteBootstrap, importRemoteFrontend, setRemoteFrontendDisabled } from "./store";
