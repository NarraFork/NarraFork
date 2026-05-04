import { getAvatarUrl, getToken } from "@frontend/lib/api";
import { Texture } from "pixi.js";

export type PixiImageTextureStatus = "idle" | "loading" | "ready" | "failed";

export interface PixiImageTextureResult {
	texture: Texture | null;
	status: PixiImageTextureStatus;
	error?: string;
}

const textureCache = new Map<string, Texture>();
const objectUrlCache = new Map<string, string>();
const loadingCache = new Map<string, number>();
const failedCache = new Map<string, { at: number; error: string }>();
const loadListeners = new Set<() => void>();
const FAILED_RETRY_MS = 5_000;
let textureGeneration = 0;

function notifyTextureLoaded(): void {
	for (const listener of loadListeners) listener();
}

export function subscribePixiImageTextureLoads(listener: () => void): () => void {
	loadListeners.add(listener);
	return () => loadListeners.delete(listener);
}

function authHeaders(): Record<string, string> {
	const token = getToken();
	return token ? { Authorization: `Bearer ${token}` } : {};
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
			const response = await fetch(source, { headers: authHeaders() });
			if (!response.ok) throw new Error(`${response.status} ${response.statusText}`.trim());
			const blob = await response.blob();
			if (!blob.type.startsWith("image/")) throw new Error(blob.type || "response is not image");
			createdObjectUrl = URL.createObjectURL(blob);
			loadUrl = createdObjectUrl;
			if (generation !== textureGeneration) {
				URL.revokeObjectURL(createdObjectUrl);
				return;
			}
			objectUrlCache.set(key, loadUrl);
		}

		const texture = await textureFromImageSource(loadUrl);
		if (generation !== textureGeneration) {
			texture.destroy(true);
			if (createdObjectUrl) URL.revokeObjectURL(createdObjectUrl);
			return;
		}
		const previous = textureCache.get(key);
		if (previous && previous !== texture) previous.destroy(true);
		textureCache.set(key, texture);
		failedCache.delete(key);
		notifyTextureLoaded();
	} catch (error) {
		if (generation === textureGeneration) {
			failedCache.set(key, { at: Date.now(), error: errorMessage(error) });
			notifyTextureLoaded();
		} else if (createdObjectUrl) {
			URL.revokeObjectURL(createdObjectUrl);
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
	const cached = textureCache.get(key);
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
): PixiImageTextureResult {
	if (!userId || !avatarImageId) return { texture: null, status: "idle" };
	return requestTexture(
		`avatar:${userId}:${avatarImageId}`,
		getAvatarUrl(userId, avatarImageId),
		true,
	);
}

export function getPixiUploadImageTexture(
	narratorId: string | null | undefined,
	imageId: string | null | undefined,
): PixiImageTextureResult {
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
}): PixiImageTextureResult {
	if (opts.savedPath) {
		const url = `/api/fs/preview?path=${encodeURIComponent(opts.savedPath)}`;
		return requestTexture(`generated-path:${opts.savedPath}`, url, true);
	}
	if (opts.result) {
		const dataUrl = opts.result.startsWith("data:")
			? opts.result
			: `data:image/png;base64,${opts.result}`;
		return requestTexture(
			`generated-inline:${opts.result.slice(0, 80)}:${opts.result.length}`,
			dataUrl,
			false,
		);
	}
	return { texture: null, status: "idle" };
}

export function invalidatePixiImageTextures(): void {
	textureGeneration++;
	for (const texture of textureCache.values()) {
		texture.destroy(true);
	}
	textureCache.clear();
	loadingCache.clear();
	failedCache.clear();
	for (const url of objectUrlCache.values()) URL.revokeObjectURL(url);
	objectUrlCache.clear();
}

export function destroyPixiImageTextureCache(): void {
	invalidatePixiImageTextures();
}
