/**
 * The wallpaper image layer.
 *
 * ## Why an `<img>` and not a CSS `background-image`
 *
 * Two reasons, both discovered the hard way:
 *
 * 1. **Hotlink protection.** Many wallpaper hosts answer 403 when a `Referer` header is
 *    present. A browser always sends one for a CSS background request, and CSS gives no way
 *    to opt out. `<img referrerpolicy="no-referrer">` does — it is the only way to load such
 *    an image without changing the referrer policy of the whole document.
 * 2. **Silent failure.** A CSS background that fails to load paints nothing and reports
 *    nothing. An `<img>` fires `onerror`, which is what lets the settings card say "this
 *    image could not be loaded" instead of leaving the user staring at a flat colour.
 *
 * The layer is a fixed, non-interactive element behind the app (a child of `<body>`; the
 * shell keeps a translucent background above it). Blur is applied to the image itself, so
 * the panels above it only need transparency.
 */

const LAYER_ID = "nf-wallpaper";

export interface WallpaperLayerParams {
	src: string;
	blur: number;
}

function ensureLayer(): { wrapper: HTMLDivElement; img: HTMLImageElement } {
	const existing = document.getElementById(LAYER_ID);
	if (existing instanceof HTMLDivElement) {
		const img = existing.querySelector("img");
		if (img instanceof HTMLImageElement) return { wrapper: existing, img };
		existing.remove();
	}
	const wrapper = document.createElement("div");
	wrapper.id = LAYER_ID;
	wrapper.setAttribute("aria-hidden", "true");
	const img = document.createElement("img");
	img.alt = "";
	// The whole point: no Referer, so hotlink-protected hosts serve the image.
	img.referrerPolicy = "no-referrer";
	img.decoding = "async";
	wrapper.appendChild(img);
	document.body.appendChild(wrapper);
	return { wrapper, img };
}

/** Previously created object URL, revoked when a file wallpaper is replaced. */
let activeObjectUrl: string | null = null;

export type WallpaperResult = "ok" | "error" | "unsupported";

/**
 * Show `params.src` behind the app. Resolves once the image has decoded (or failed).
 * `blob` marks a locally stored file whose object URL this module owns.
 */
export async function showWallpaper(
	params: WallpaperLayerParams,
	options: { objectUrl?: boolean } = {},
): Promise<WallpaperResult> {
	if (typeof document === "undefined") return "unsupported";
	const { wrapper, img } = ensureLayer();
	wrapper.style.setProperty("--nf-bg-blur", `${Math.max(0, params.blur)}px`);

	const loaded = await new Promise<boolean>((resolve) => {
		const onLoad = () => resolve(true);
		const onError = () => resolve(false);
		img.addEventListener("load", onLoad, { once: true });
		img.addEventListener("error", onError, { once: true });
		img.src = params.src;
	});

	if (!loaded) {
		wrapper.dataset.state = "error";
		return "error";
	}
	wrapper.dataset.state = "ready";
	if (options.objectUrl) {
		if (activeObjectUrl && activeObjectUrl !== params.src) URL.revokeObjectURL(activeObjectUrl);
		activeObjectUrl = params.src;
	}
	return "ok";
}

export function hideWallpaper(): void {
	if (typeof document === "undefined") return;
	document.getElementById(LAYER_ID)?.remove();
	if (activeObjectUrl) {
		URL.revokeObjectURL(activeObjectUrl);
		activeObjectUrl = null;
	}
}
