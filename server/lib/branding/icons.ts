/**
 * Brand icon generation: recolour the shipped icons to the configured accent
 * colour, and cache the result.
 *
 * Recolouring the three PNGs costs ~70ms of synchronous CPU (measured: 18/42/10ms
 * for 192/512/180). On this single-threaded server that is far too much to pay per
 * request — a PWA install fetches all three plus the favicon, and browsers
 * revalidate them regularly. So results are cached per colour, and requests that
 * arrive while a colour is still being generated share the same in-flight promise
 * instead of each starting their own encode.
 *
 * The default colour is short-circuited entirely: an unbranded instance serves the
 * original bytes and never touches the codec.
 */

import { extname } from "node:path";
import {
	DEFAULT_BRAND_ICON_COLOR,
	normalizeBrandIconColor,
	recolorBrandSvg,
} from "@shared/branding";
import { logger } from "../logger";
import { isCompiledRuntime } from "../runtime-target";
import { recolorBrandPng } from "./png-recolor";

/** Source assets, keyed by the logical name used in the public routes. */
export const BRAND_ASSET_FILES = {
	favicon: "favicon.svg",
	icon192: "pwa-192x192.png",
	icon512: "pwa-512x512.png",
	appleTouch: "apple-touch-icon-180x180.png",
} as const;

export type BrandAssetName = keyof typeof BRAND_ASSET_FILES;

export interface BrandAsset {
	body: Uint8Array;
	contentType: string;
	/** Strong validator over (colour, source bytes) — see `computeEtag`. */
	etag: string;
}

export type BrandIconSet = Record<BrandAssetName, BrandAsset>;

/**
 * Cache bound.
 *
 * In practice one instance has one colour, so this never fills. It exists so that
 * a bug which somehow drove colour values from request input could not turn the
 * cache into unbounded memory growth holding decoded 512x512 buffers.
 */
const MAX_CACHED_COLORS = 8;

/** Insertion-ordered so the oldest colour can be evicted (Map preserves order). */
const iconSetCache = new Map<string, Promise<BrandIconSet>>();

/** Source bytes, read once per process — they never change while running. */
let sourceAssetsPromise: Promise<Map<BrandAssetName, Uint8Array>> | null = null;

const MIME_BY_EXTENSION: Record<string, string> = {
	".svg": "image/svg+xml",
	".png": "image/png",
};

/**
 * Locate a source asset across the three ways this server can run.
 *
 * Mirrors the static-file strategy in `server/main.ts`: a compiled binary reads
 * from the embedded asset map, a source production run reads `dist/frontend`, and
 * dev reads `frontend/public`. All three are probed rather than selected up front
 * because `bun run start` and `bun run dev` differ only by whether the build
 * output exists, and a partially built tree should still yield an icon.
 */
async function readSourceAsset(fileName: string): Promise<Uint8Array | null> {
	const candidates: string[] = [];

	if (isCompiledRuntime()) {
		try {
			// Dynamic so a non-compiled run (where the generated file is absent) does
			// not fail at import time.
			const generatedModulePath = "../../generated/embedded-frontend";
			const generated = (await import(generatedModulePath)) as {
				embeddedAssets?: Record<string, string>;
			};
			const embedded = generated.embeddedAssets ?? {};
			for (const [urlPath, filePath] of Object.entries(embedded)) {
				if (urlPath.replaceAll("\\", "/") === `/${fileName}`) {
					candidates.push(filePath);
					break;
				}
			}
		} catch {
			// Not available — fall through to the filesystem candidates.
		}
	}

	candidates.push(
		new URL(`../../../dist/frontend/${fileName}`, import.meta.url).pathname,
		new URL(`../../../frontend/public/${fileName}`, import.meta.url).pathname,
	);

	for (const candidate of candidates) {
		try {
			const file = Bun.file(candidate);
			if (await file.exists()) return new Uint8Array(await file.arrayBuffer());
		} catch {
			// Unreadable candidate — try the next one.
		}
	}

	return null;
}

async function loadSourceAssets(): Promise<Map<BrandAssetName, Uint8Array>> {
	const result = new Map<BrandAssetName, Uint8Array>();
	for (const [name, fileName] of Object.entries(BRAND_ASSET_FILES) as Array<
		[BrandAssetName, string]
	>) {
		const bytes = await readSourceAsset(fileName);
		if (bytes) {
			result.set(name, bytes);
		} else {
			// Not fatal: the route falls back to letting the static handler serve the
			// asset. Logged because a missing brand asset means custom colours silently
			// stop applying to that icon.
			logger.warn("Brand source asset not found", { fileName });
		}
	}
	return result;
}

function getSourceAssets(): Promise<Map<BrandAssetName, Uint8Array>> {
	sourceAssetsPromise ??= loadSourceAssets();
	return sourceAssetsPromise;
}

/**
 * Validator over the colour AND the source bytes.
 *
 * Including the source content is what makes an upgrade that ships a new logo
 * visible: with a colour-only tag, browsers holding the previous icon would keep
 * it indefinitely, because the URL and the colour both stayed the same.
 */
function computeEtag(colorHex: string, body: Uint8Array): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(colorHex);
	hasher.update(body);
	return `"${hasher.digest("hex").slice(0, 24)}"`;
}

async function buildIconSet(colorHex: string): Promise<BrandIconSet> {
	const sources = await getSourceAssets();
	const set = {} as BrandIconSet;

	for (const [name, fileName] of Object.entries(BRAND_ASSET_FILES) as Array<
		[BrandAssetName, string]
	>) {
		const source = sources.get(name);
		if (!source) continue;

		const contentType = MIME_BY_EXTENSION[extname(fileName)] ?? "application/octet-stream";
		let body: Uint8Array = source;

		if (fileName.endsWith(".svg")) {
			body = new TextEncoder().encode(recolorBrandSvg(new TextDecoder().decode(source), colorHex));
		} else {
			// A null result means the asset is not a shape the codec handles; serving
			// the original keeps the icon correct-but-uncoloured rather than broken.
			const recolored = recolorBrandPng(source, colorHex);
			if (recolored) {
				body = recolored;
			} else {
				logger.warn("Brand icon could not be recoloured; serving original", { fileName });
			}
		}

		set[name] = { body, contentType, etag: computeEtag(colorHex, body) };
	}

	return set;
}

/**
 * Brand icons for one colour. Concurrent callers share one generation pass.
 *
 * A rejected build is evicted so a transient failure (an unreadable asset during
 * an upgrade) does not poison the colour for the process lifetime.
 */
export function getBrandIcons(colorHex: string): Promise<BrandIconSet> {
	const color = normalizeBrandIconColor(colorHex) || DEFAULT_BRAND_ICON_COLOR;
	const cached = iconSetCache.get(color);
	if (cached) return cached;

	const pending = buildIconSet(color).catch((error: unknown) => {
		iconSetCache.delete(color);
		throw error;
	});
	iconSetCache.set(color, pending);

	while (iconSetCache.size > MAX_CACHED_COLORS) {
		const oldest = iconSetCache.keys().next();
		if (oldest.done || oldest.value === color) break;
		iconSetCache.delete(oldest.value);
	}

	return pending;
}

/** Drop cached icons. Exported for tests and for a future settings-reload hook. */
export function clearBrandIconCache(): void {
	iconSetCache.clear();
	sourceAssetsPromise = null;
}
