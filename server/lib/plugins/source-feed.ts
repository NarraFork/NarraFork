import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
	PLUGIN_UPDATE_MAX_ARCHIVE_BYTES,
	PLUGIN_UPDATE_MAX_METADATA_BYTES,
	pluginSourceIdSchema,
	pluginSourceUrlSchema,
	pluginWebsiteUpdateResponseSchema,
} from "@shared/plugin-source";
import { Hono } from "hono";

export const PLUGIN_SOURCE_FEED_MARKER = "public-plugin-source.json";
export const PLUGIN_SOURCE_FEED_IDENTITY = {
	schemaVersion: 1,
	kind: "narrafork-plugin-source",
} as const;
const SHA256 = /^[a-f0-9]{64}$/;

type PublicFile = { handle: Awaited<ReturnType<typeof open>>; size: number };

function assertContained(root: string, path: string): void {
	const remainder = relative(root, path);
	if (
		isAbsolute(remainder) ||
		remainder === ".." ||
		remainder.startsWith("../") ||
		remainder.startsWith("..\\")
	) {
		throw new Error("Public source file escaped the release directory");
	}
}

/** Only known, bounded regular files are exposed; races are checked before any bytes are read. */
async function openPublicFile(
	root: string,
	path: string,
	maxBytes: number,
): Promise<PublicFile | undefined> {
	assertContained(root, path);
	let info: Awaited<ReturnType<typeof lstat>>;
	try {
		info = await lstat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) {
		throw new Error("Public source file is not a bounded regular file");
	}
	const actual = await realpath(path);
	assertContained(root, actual);
	const handle = await open(actual, "r");
	try {
		const opened = await handle.stat();
		if (
			!opened.isFile() ||
			opened.size > maxBytes ||
			opened.dev !== info.dev ||
			opened.ino !== info.ino
		) {
			throw new Error("Public source file changed while opening");
		}
		return { handle, size: opened.size };
	} catch (error) {
		await handle.close();
		throw error;
	}
}

export async function readPublicSourceJson(
	root: string,
	path: string,
	maxBytes = PLUGIN_UPDATE_MAX_METADATA_BYTES,
): Promise<unknown | undefined> {
	const limit = Number.isFinite(maxBytes)
		? Math.min(PLUGIN_UPDATE_MAX_METADATA_BYTES, Math.max(1, Math.floor(maxBytes)))
		: PLUGIN_UPDATE_MAX_METADATA_BYTES;
	const file = await openPublicFile(root, path, limit);
	if (!file) return undefined;
	try {
		const bytes = new Uint8Array(limit + 1);
		let length = 0;
		while (length < bytes.length) {
			const read = await file.handle.read(bytes, length, bytes.length - length, length);
			if (!read.bytesRead) break;
			length += read.bytesRead;
		}
		if (length > limit) throw new Error("Public source metadata exceeded its budget");
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
	} finally {
		await file.handle.close();
	}
}

/** The marker prevents accidentally serving an installed-plugin/configuration directory. */
export async function openPublicPluginSourceRoot(path: string): Promise<string> {
	const resolved = resolve(path);
	const info = await lstat(resolved);
	if (!info.isDirectory() || info.isSymbolicLink())
		throw new Error("Expected a public release directory");
	const root = await realpath(resolved);
	const marker = await readPublicSourceJson(root, join(root, PLUGIN_SOURCE_FEED_MARKER), 1024);
	if (
		!marker ||
		typeof marker !== "object" ||
		Array.isArray(marker) ||
		Object.keys(marker).length !== 2 ||
		(marker as Record<string, unknown>).schemaVersion !==
			PLUGIN_SOURCE_FEED_IDENTITY.schemaVersion ||
		(marker as Record<string, unknown>).kind !== PLUGIN_SOURCE_FEED_IDENTITY.kind
	) {
		throw new Error("The directory is not an initialized public plugin source");
	}
	return root;
}

export function pluginSourcePublicOrigin(value: string): string {
	const parsed = pluginSourceUrlSchema.parse(value);
	const url = new URL(parsed);
	if (
		url.pathname !== "/" ||
		url.search ||
		url.hash ||
		(url.protocol === "http:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
	) {
		throw new Error("Public origin must be HTTPS, or loopback HTTP, without a path");
	}
	return url.origin;
}

function publicFileStream(
	file: PublicFile,
	requestSignal: AbortSignal,
	onClose: () => void,
): ReadableStream<Uint8Array> {
	const timeout = new AbortController();
	const timer = setTimeout(
		() => timeout.abort(new Error("Public archive response timed out")),
		120_000,
	);
	const signal = AbortSignal.any([requestSignal, timeout.signal]);
	let offset = 0;
	let closed = false;
	let abort: () => void = () => {};
	async function close() {
		if (closed) return;
		closed = true;
		clearTimeout(timer);
		signal.removeEventListener("abort", abort);
		onClose();
		await file.handle.close();
	}
	return new ReadableStream<Uint8Array>({
		start(controller) {
			abort = () => {
				controller.error(signal.reason);
				void close();
			};
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) abort();
		},
		async pull(controller) {
			if (closed) return;
			try {
				signal.throwIfAborted();
				if (offset === file.size) {
					await close();
					controller.close();
					return;
				}
				const bytes = new Uint8Array(Math.min(64 * 1024, file.size - offset));
				const read = await file.handle.read(bytes, 0, bytes.length, offset);
				if (!read.bytesRead) throw new Error("Public archive changed during download");
				offset += read.bytesRead;
				signal.throwIfAborted();
				controller.enqueue(bytes.subarray(0, read.bytesRead));
			} catch (error) {
				await close();
				controller.error(error);
			}
		},
		cancel: close,
	});
}

export interface PluginSourceFeedOptions {
	root: string;
	publicOrigin: string;
	maxConcurrentDownloads?: number;
}

/** Standalone, public, read-only reference API. Never mounted on NarraFork's authenticated app. */
export async function createPluginSourceFeed(options: PluginSourceFeedOptions): Promise<Hono> {
	const root = await openPublicPluginSourceRoot(options.root);
	const origin = pluginSourcePublicOrigin(options.publicOrigin);
	const app = new Hono();
	let activeRequests = 0;
	let activeDownloads = 0;
	const requestedDownloads = options.maxConcurrentDownloads ?? 8;
	const maxDownloads =
		Number.isSafeInteger(requestedDownloads) && requestedDownloads > 0
			? Math.min(32, requestedDownloads)
			: 8;
	app.use("*", async (c, next) => {
		if (c.req.url.length > 8192) return c.json({ error: "source_request_too_large" }, 414);
		if (activeRequests >= 32) return c.json({ error: "source_busy" }, 503);
		activeRequests++;
		try {
			await next();
		} finally {
			activeRequests--;
		}
	});
	app.onError((_error, c) => c.json({ error: "invalid_public_release" }, 503));
	app.get("/v1/plugins/:pluginId/latest", async (c) => {
		const parsedId = pluginSourceIdSchema.safeParse(c.req.param("pluginId"));
		if (!parsedId.success) return c.json({ error: "invalid_plugin_id" }, 400);
		const pluginId = parsedId.data;
		if (c.req.query("pluginId") && c.req.query("pluginId") !== pluginId) {
			return c.json({ error: "plugin_id_mismatch" }, 400);
		}
		if (c.req.query("channel") && c.req.query("channel") !== "stable") {
			return c.json({ error: "unsupported_channel" }, 400);
		}
		c.header("Cache-Control", "no-store");
		c.header("X-Content-Type-Options", "nosniff");
		const raw = await readPublicSourceJson(root, join(root, "plugins", pluginId, "latest.json"));
		if (raw === undefined) return c.json({ schemaVersion: 1, pluginId, latest: null });
		const metadata = pluginWebsiteUpdateResponseSchema.parse(raw);
		if (metadata.pluginId !== pluginId) throw new Error("Public release identity mismatch");
		if (metadata.latest) {
			const file = await openPublicFile(
				root,
				join(root, "assets", `${metadata.latest.artifact.sha256}.nfplugin`),
				PLUGIN_UPDATE_MAX_ARCHIVE_BYTES,
			);
			if (!file) throw new Error("Public release archive is missing");
			await file.handle.close();
			if (file.size !== metadata.latest.artifact.size)
				throw new Error("Public release archive size mismatch");
			metadata.latest.artifact.url = `${origin}/assets/${metadata.latest.artifact.sha256}.nfplugin`;
		}
		return c.json(metadata);
	});
	app.on(["GET", "HEAD"], "/assets/:name", async (c) => {
		const name = c.req.param("name");
		const digest = name.endsWith(".nfplugin") ? name.slice(0, -9) : "";
		if (!SHA256.test(digest)) return c.json({ error: "invalid_asset" }, 400);
		const file = await openPublicFile(
			root,
			join(root, "assets", name),
			PLUGIN_UPDATE_MAX_ARCHIVE_BYTES,
		);
		if (!file?.size) {
			await file?.handle.close();
			return c.json({ error: "asset_not_found" }, 404);
		}
		const headers = {
			"Content-Type": "application/octet-stream",
			"Content-Length": String(file.size),
			"Cache-Control": "public, max-age=31536000, immutable",
			"X-Content-Type-Options": "nosniff",
			ETag: `"${digest}"`,
		};
		if (c.req.method === "HEAD") {
			await file.handle.close();
			return new Response(null, { headers });
		}
		if (activeDownloads >= maxDownloads) {
			await file.handle.close();
			return c.json({ error: "source_busy" }, 503);
		}
		activeDownloads++;
		return new Response(
			publicFileStream(file, c.req.raw.signal, () => {
				activeDownloads--;
			}),
			{ headers },
		);
	});
	return app;
}
