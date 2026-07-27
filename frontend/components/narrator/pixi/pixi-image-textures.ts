import { ApiError, authorizedFetch, getAvatarUrl, readFetchError } from "@frontend/lib/api";
import { Texture } from "pixi.js";

export type PixiImageTextureStatus = "idle" | "loading" | "ready" | "failed";

export interface PixiImageTextureResult {
	texture: Texture | null;
	status: PixiImageTextureStatus;
	error?: string;
}

interface CachedTexture {
	texture: Texture;
	bytes: number;
}

const textureCache = new Map<string, CachedTexture>();
const objectUrlCache = new Map<string, string>();
const loadingCache = new Map<string, number>();
const failedCache = new Map<string, { at: number; error: string }>();
const loadListeners = new Set<() => void>();
const FAILED_RETRY_MS = 5_000;
const MAX_TEXTURE_CACHE_ENTRIES = 96;
const MAX_TEXTURE_CACHE_BYTES = 96 * 1024 * 1024;
const MAX_IMAGE_SOURCE_BLOB_BYTES = 25 * 1024 * 1024;
export const MAX_INLINE_IMAGE_RESULT_CHARS = 16 * 1024 * 1024;
const MAX_FAILED_CACHE_ENTRIES = 256;
let textureGeneration = 0;
let textureCacheBytes = 0;

function notifyTextureLoaded(): void {
	for (const listener of loadListeners) listener();
}

export function subscribePixiImageTextureLoads(listener: () => void): () => void {
	loadListeners.add(listener);
	return () => loadListeners.delete(listener);
}

function isDirectImageUrl(url: string): boolean {
	return (
		url.startsWith("data:") ||
		url.startsWith("blob:") ||
		url.startsWith("http://") ||
		url.startsWith("https://")
	);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error || "unknown error");
}

function estimatedInlineImageBytes(source: string): number {
	if (!source.startsWith("data:")) return Math.ceil((source.length * 3) / 4);
	const comma = source.indexOf(",");
	if (comma === -1) return source.length;
	const metadata = source.slice(0, comma).toLowerCase();
	const payloadLength = source.length - comma - 1;
	if (metadata.includes(";base64")) return Math.ceil((payloadLength * 3) / 4);
	return payloadLength;
}

function normalizeGeneratedImageDataUrl(result: string): string | null {
	if (result.length > MAX_INLINE_IMAGE_RESULT_CHARS) return null;
	const dataUrl = result.startsWith("data:") ? result : `data:image/png;base64,${result}`;
	if (!dataUrl.startsWith("data:image/")) return null;
	if (estimatedInlineImageBytes(dataUrl) > MAX_IMAGE_SOURCE_BLOB_BYTES) return null;
	return dataUrl;
}

function disposeTexture(texture: Texture): void {
	texture.source?.unload();
	texture.destroy(false);
}

function estimateTextureBytes(texture: Texture): number {
	const width = Math.max(1, Math.ceil(Number.isFinite(texture.width) ? texture.width : 1));
	const height = Math.max(1, Math.ceil(Number.isFinite(texture.height) ? texture.height : 1));
	return width * height * 4;
}

function revokeObjectUrlForKey(key: string): void {
	const url = objectUrlCache.get(key);
	if (!url) return;
	URL.revokeObjectURL(url);
	objectUrlCache.delete(key);
}

function setObjectUrlForKey(key: string, url: string): void {
	const previous = objectUrlCache.get(key);
	if (previous && previous !== url) URL.revokeObjectURL(previous);
	objectUrlCache.set(key, url);
}

function disposeCacheEntry(key: string, entry: CachedTexture): void {
	textureCache.delete(key);
	textureCacheBytes = Math.max(0, textureCacheBytes - entry.bytes);
	disposeTexture(entry.texture);
	revokeObjectUrlForKey(key);
}

function pruneTextureCache(): void {
	while (
		textureCache.size > MAX_TEXTURE_CACHE_ENTRIES ||
		(textureCacheBytes > MAX_TEXTURE_CACHE_BYTES && textureCache.size > 1)
	) {
		const oldest = textureCache.entries().next().value;
		if (!oldest) break;
		const [key, entry] = oldest;
		disposeCacheEntry(key, entry);
	}
}

function setCachedTexture(key: string, texture: Texture): void {
	const previous = textureCache.get(key);
	if (previous) disposeCacheEntry(key, previous);
	const entry: CachedTexture = { texture, bytes: estimateTextureBytes(texture) };
	textureCache.set(key, entry);
	textureCacheBytes += entry.bytes;
	pruneTextureCache();
}

function getCachedTexture(key: string): Texture | null {
	const entry = textureCache.get(key);
	if (!entry) return null;
	textureCache.delete(key);
	textureCache.set(key, entry);
	return entry.texture;
}

function setFailed(key: string, error: string): void {
	if (failedCache.has(key)) failedCache.delete(key);
	failedCache.set(key, { at: Date.now(), error });
	while (failedCache.size > MAX_FAILED_CACHE_ENTRIES) {
		const oldestKey = failedCache.keys().next().value;
		if (!oldestKey) break;
		failedCache.delete(oldestKey);
	}
}

async function textureFromImageSource(source: string): Promise<Texture> {
	const image = new Image();
	image.decoding = "async";
	image.src = source;

	try {
		await image.decode();
	} catch {
		if (!image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) {
			await new Promise<void>((resolve, reject) => {
				image.onload = () => resolve();
				image.onerror = () => reject(new Error("image decode failed"));
			});
		}
	}

	if (image.naturalWidth <= 0 || image.naturalHeight <= 0) {
		throw new Error("decoded image has no size");
	}
	return Texture.from(image);
}

async function loadTextureFromSource(
	key: string,
	source: string,
	authenticated: boolean,
	generation: number,
): Promise<void> {
	let createdObjectUrl: string | null = null;
	try {
		let loadUrl = source;
		if (authenticated) {
			const response = await authorizedFetch(source);
			if (!response.ok) {
				const error = await readFetchError(response, `HTTP ${response.status}`);
				throw new ApiError(error.message, response.status, error.data);
			}
			const blob = await response.blob();
			if (!blob.type.startsWith("image/")) throw new Error(blob.type || "response is not image");
			if (blob.size > MAX_IMAGE_SOURCE_BLOB_BYTES) throw new Error("image blob too large");
			createdObjectUrl = URL.createObjectURL(blob);
			loadUrl = createdObjectUrl;
			if (generation !== textureGeneration) {
				URL.revokeObjectURL(createdObjectUrl);
				createdObjectUrl = null;
				return;
			}
		}

		const texture = await textureFromImageSource(loadUrl);
		if (generation !== textureGeneration) {
			disposeTexture(texture);
			if (createdObjectUrl) URL.revokeObjectURL(createdObjectUrl);
			return;
		}
		setCachedTexture(key, texture);
		if (createdObjectUrl) {
			setObjectUrlForKey(key, createdObjectUrl);
			createdObjectUrl = null;
		}
		failedCache.delete(key);
		notifyTextureLoaded();
	} catch (error) {
		if (createdObjectUrl) URL.revokeObjectURL(createdObjectUrl);
		if (generation === textureGeneration) {
			setFailed(key, errorMessage(error));
			notifyTextureLoaded();
		}
	} finally {
		if (loadingCache.get(key) === generation) loadingCache.delete(key);
	}
}

function requestTexture(
	key: string,
	source: string,
	authenticated: boolean,
): PixiImageTextureResult {
	const cached = getCachedTexture(key);
	if (cached) return { texture: cached, status: "ready" };
	const failed = failedCache.get(key);
	if (failed) {
		if (Date.now() - failed.at < FAILED_RETRY_MS) {
			return { texture: null, status: "failed", error: failed.error };
		}
		failedCache.delete(key);
	}
	const generation = textureGeneration;
	if (loadingCache.get(key) !== generation) {
		loadingCache.set(key, generation);
		void loadTextureFromSource(key, source, authenticated, generation);
	}
	return { texture: null, status: "loading" };
}

export function getPixiAvatarTexture(
	userId: string | null | undefined,
	avatarImageId: string | null | undefined,
	avatarServingSupported = true,
): PixiImageTextureResult {
	if (!avatarServingSupported || !userId || !avatarImageId)
		return { texture: null, status: "idle" };
	return requestTexture(
		`avatar:${userId}:${avatarImageId}`,
		getAvatarUrl(userId, avatarImageId),
		true,
	);
}

export function getPixiUploadImageTexture(
	narratorId: string | null | undefined,
	imageId: string | null | undefined,
	narratorImageServingSupported = true,
): PixiImageTextureResult {
	if (!narratorImageServingSupported) {
		return { texture: null, status: "failed", error: "image serving unavailable" };
	}
	if (!narratorId || !imageId) return { texture: null, status: "idle" };
	return requestTexture(
		`upload:${narratorId}:${imageId}`,
		`/api/uploads/${narratorId}/${imageId}`,
		true,
	);
}

export function getPixiPreviewImageTexture(url: string | null | undefined): PixiImageTextureResult {
	if (!url) return { texture: null, status: "idle" };
	return requestTexture(`preview:${url}`, url, !isDirectImageUrl(url));
}

export function getPixiGeneratedImageTexture(opts: {
	result?: string | null;
	savedPath?: string | null;
	fsPreviewSupported?: boolean;
}): PixiImageTextureResult {
	if (opts.result) {
		const dataUrl = normalizeGeneratedImageDataUrl(opts.result);
		if (!dataUrl) return { texture: null, status: "failed", error: "image data too large" };
		return requestTexture(
			`generated-inline:${opts.result.slice(0, 80)}:${opts.result.length}`,
			dataUrl,
			false,
		);
	}
	if (opts.savedPath) {
		if (opts.fsPreviewSupported === false) {
			return { texture: null, status: "failed", error: "file preview unavailable" };
		}
		const url = `/api/fs/preview?path=${encodeURIComponent(opts.savedPath)}`;
		return requestTexture(`generated-path:${opts.savedPath}`, url, true);
	}
	return { texture: null, status: "idle" };
}

export function invalidatePixiImageTextures(): void {
	textureGeneration++;
	for (const [key, entry] of [...textureCache]) {
		disposeCacheEntry(key, entry);
	}
	textureCache.clear();
	textureCacheBytes = 0;
	loadingCache.clear();
	failedCache.clear();
	for (const url of objectUrlCache.values()) URL.revokeObjectURL(url);
	objectUrlCache.clear();
}

export function destroyPixiImageTextureCache(): void {
	invalidatePixiImageTextures();
}
