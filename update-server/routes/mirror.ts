import { Hono } from "hono";
import {
	MAX_MIRROR_SNAPSHOT_BYTES,
	MIRROR_ASSET_HEADERS,
	parseMirrorAssetDescriptor,
} from "../../shared/independent-update-mirror";
import { requireAuth } from "../lib/auth";
import { MirrorIngestError, MirrorIngestService } from "../services/mirror-ingest";
import { objectPath, readMirrorBounded } from "../services/mirror-ingest-io";
import type { StorageBackend } from "../storage/types";

function boundedDownload(
	source: ReadableStream<Uint8Array>,
	size: number,
	signal: AbortSignal,
): ReadableStream<Uint8Array> {
	const reader = source.getReader();
	let bytes = 0;
	let timer: ReturnType<typeof setTimeout>;
	let controller: ReadableStreamDefaultController<Uint8Array>;
	let closed = false;
	const cleanup = () => {
		clearTimeout(timer);
		signal.removeEventListener("abort", abort);
	};
	const fail = (message: string) => {
		if (closed) return;
		closed = true;
		cleanup();
		controller.error(new Error(message));
		void reader.cancel().catch(() => {});
	};
	const abort = () => fail("Mirror download aborted");
	return new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
			timer = setTimeout(() => fail("Mirror download deadline exceeded"), 120_000);
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) abort();
		},
		async pull(c) {
			try {
				const { done, value } = await reader.read();
				if (closed) return;
				if (done) {
					if (bytes !== size) return fail("Mirror download truncated");
					closed = true;
					cleanup();
					c.close();
					return;
				}
				bytes += value.byteLength;
				if (bytes > size) return fail("Mirror download byte limit exceeded");
				c.enqueue(value);
			} catch {
				fail("Mirror download storage failure");
			}
		},
		cancel() {
			closed = true;
			cleanup();
			return reader.cancel();
		},
	});
}

export function createMirrorRoutes(
	storage: StorageBackend,
	ingest: MirrorIngestService = new MirrorIngestService(storage),
) {
	const routes = new Hono();
	routes.onError((error, c) =>
		error instanceof MirrorIngestError
			? c.json({ error: error.message, code: error.code }, error.status as 400 | 409 | 429 | 503)
			: c.json({ error: error.message }, 400),
	);
	routes.get("/:product/mirror/index", async (c) => {
		const snapshot = await ingest.readMain(c.req.param("product") as string);
		return snapshot
			? c.json(snapshot.index)
			: c.json({ error: "Canonical mirror snapshot unavailable" }, 404);
	});
	routes.get("/:product/mirror/availability/:version/:platform", async (c) => {
		const product = c.req.param("product") as string;
		const repo = ingest.repository(product);
		const snapshot = await ingest.readMain(product);
		if (!snapshot) return c.json({ error: "Canonical mirror snapshot unavailable" }, 404);
		const version = c.req.param("version");
		const platform = c.req.param("platform");
		if (
			!snapshot.index.releases.some(
				(r) => r.version === version && r.files.some((f) => f.platform === platform),
			)
		)
			return c.json({ error: "Unknown canonical target/platform" }, 404);
		const assets = [];
		for (const asset of snapshot.assets.filter(
			(a) => a.version === version && a.platform === platform,
		)) {
			if ((await storage.getFileSize(objectPath(asset.sha256))) === asset.size)
				assets.push({ name: asset.name, size: asset.size, sha256: asset.sha256 });
		}
		return c.json({ schemaVersion: 1, repository: repo, version, platform, assets });
	});
	routes.get("/:product/mirror/assets/:sha256", async (c) => {
		const product = c.req.param("product") as string;
		const sha = c.req.param("sha256");
		if (!/^[a-f0-9]{64}$/.test(sha)) return c.json({ error: "Invalid SHA256" }, 400);
		const snapshot = await ingest.readMain(product);
		const asset = snapshot?.assets.find((a) => a.sha256 === sha);
		if (!asset || (await storage.getFileSize(objectPath(sha))) !== asset.size)
			return c.json({ error: "Committed mirror asset unavailable" }, 404);
		const stream = await storage.getFileStream(objectPath(sha));
		return stream
			? new Response(boundedDownload(stream, asset.size, c.req.raw.signal), {
					headers: {
						"Content-Type": "application/octet-stream",
						"Content-Length": String(asset.size),
						"X-Content-Type-Options": "nosniff",
					},
				})
			: c.json({ error: "Mirror asset unavailable" }, 404);
	});
	routes.put("/:product/mirror/assets/:sha256", requireAuth("upload"), async (c) => {
		const product = c.req.param("product") as string;
		if (c.req.header(MIRROR_ASSET_HEADERS.repository)?.toLowerCase() !== ingest.repository(product))
			throw new Error("Upload repository mismatch");
		const asset = parseMirrorAssetDescriptor({
			kind: c.req.header(MIRROR_ASSET_HEADERS.kind),
			name: c.req.header(MIRROR_ASSET_HEADERS.name),
			size: Number(c.req.header(MIRROR_ASSET_HEADERS.size)),
			sha256: c.req.param("sha256"),
			version: c.req.header(MIRROR_ASSET_HEADERS.version),
			...(c.req.header(MIRROR_ASSET_HEADERS.platform)
				? { platform: c.req.header(MIRROR_ASSET_HEADERS.platform) }
				: {}),
		});
		const length = c.req.header("content-length");
		if (length !== undefined && Number(length) !== asset.size)
			throw new Error("Content-Length does not match descriptor");
		if (!c.req.raw.body) throw new Error("Missing upload body");
		return c.json(await ingest.ingestAsset(product, asset, c.req.raw.body, c.req.raw.signal));
	});
	routes.post("/:product/mirror/snapshot", requireAuth("upload"), async (c) => {
		const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(120_000)]);
		const input = JSON.parse(
			(await readMirrorBounded(c.req.raw.body, MAX_MIRROR_SNAPSHOT_BYTES, signal)).toString("utf8"),
		);
		return c.json(await ingest.commitMain(c.req.param("product") as string, input, signal));
	});
	routes.get("/:product/mirror/tools/:kind/:tag", async (c) => {
		const metadata = await ingest.readTools(
			c.req.param("product") as string,
			c.req.param("kind") as "helpers" | "executor" | "remote-peer",
			c.req.param("tag") as string,
		);
		return metadata ? c.json(metadata) : c.json({ error: "Component metadata unavailable" }, 404);
	});
	routes.get("/:product/mirror/tools/:kind/:tag/assets/:name", async (c) => {
		const metadata = await ingest.readTools(
			c.req.param("product") as string,
			c.req.param("kind") as "helpers" | "executor" | "remote-peer",
			c.req.param("tag") as string,
		);
		// readTools revalidates the bounded stored projection, including every declared
		// manifest/license byte length and SHA-256. Never serve undeclared storage paths.
		const text = metadata?.assets.find((a) => a.name === c.req.param("name"));
		if (text)
			return new Response(text.content, {
				headers: {
					"Content-Type": text.name.endsWith(".json")
						? "application/json; charset=utf-8"
						: "text/plain; charset=utf-8",
					"Content-Length": String(text.size),
					"X-Content-Type-Options": "nosniff",
				},
			});
		const asset = metadata?.binaries?.find((a) => a.name === c.req.param("name"));
		if (!asset || (await storage.getFileSize(objectPath(asset.sha256))) !== asset.size)
			return c.json({ error: "Committed component binary unavailable" }, 404);
		const stream = await storage.getFileStream(objectPath(asset.sha256));
		return stream
			? new Response(boundedDownload(stream, asset.size, c.req.raw.signal), {
					headers: {
						"Content-Type": "application/octet-stream",
						"Content-Length": String(asset.size),
						"X-Content-Type-Options": "nosniff",
					},
				})
			: c.json({ error: "Component binary unavailable" }, 404);
	});
	routes.post("/:product/mirror/tools/:kind/:tag", requireAuth("upload"), async (c) => {
		const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(120_000)]);
		const input = JSON.parse(
			(await readMirrorBounded(c.req.raw.body, 1024 * 1024, signal)).toString("utf8"),
		);
		return c.json(
			await ingest.commitTools(
				c.req.param("product") as string,
				c.req.param("kind") as "helpers" | "executor" | "remote-peer",
				c.req.param("tag") as string,
				input,
				signal,
			),
		);
	});
	return routes;
}
