import { getAvatarUrl, getToken } from "@frontend/lib/api";
import { Assets, type Texture } from "pixi.js";

const textureCache = new Map<string, Texture>();
const objectUrlCache = new Map<string, string>();
const loadingCache = new Map<string, number>();
const failedCache = new Map<string, number>();
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
			if (!response.ok) throw new Error(response.statusText);
			const blob = await response.blob();
			createdObjectUrl = URL.createObjectURL(blob);
			loadUrl = createdObjectUrl;
			if (generation !== textureGeneration) {
				URL.revokeObjectURL(createdObjectUrl);
				return;
			}
			objectUrlCache.set(key, loadUrl);
		}
		const texture = await Assets.load<Texture>(loadUrl);
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
	} catch {
		if (generation === textureGeneration) failedCache.set(key, Date.now());
		else if (createdObjectUrl) URL.revokeObjectURL(createdObjectUrl);
	} finally {
		if (loadingCache.get(key) === generation) loadingCache.delete(key);
	}
}

function requestTexture(key: string, source: string, authenticated: boolean): Texture | null {
	const cached = textureCache.get(key);
	if (cached) return cached;
	const failedAt = failedCache.get(key);
	if (failedAt != null) {
		if (Date.now() - failedAt < FAILED_RETRY_MS) return null;
		failedCache.delete(key);
	}
	const generation = textureGeneration;
	if (loadingCache.get(key) !== generation) {
		loadingCache.set(key, generation);
		void loadTextureFromSource(key, source, authenticated, generation);
	}
	return null;
}

export function getPixiAvatarTexture(
	userId: string | null | undefined,
	avatarImageId: string | null | undefined,
): Texture | null {
	if (!userId || !avatarImageId) return null;
	return requestTexture(
		`avatar:${userId}:${avatarImageId}`,
		getAvatarUrl(userId, avatarImageId),
		true,
	);
}

export function getPixiUploadImageTexture(
	narratorId: string | null | undefined,
	imageId: string | null | undefined,
): Texture | null {
	if (!narratorId || !imageId) return null;
	return requestTexture(
		`upload:${narratorId}:${imageId}`,
		`/api/uploads/${narratorId}/${imageId}`,
		true,
	);
}

export function getPixiPreviewImageTexture(url: string | null | undefined): Texture | null {
	if (!url) return null;
	return requestTexture(`preview:${url}`, url, !isDirectImageUrl(url));
}

export function getPixiGeneratedImageTexture(opts: {
	result?: string | null;
	savedPath?: string | null;
}): Texture | null {
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
	return null;
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
