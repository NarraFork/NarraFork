/**
 * Branded `manifest.webmanifest`.
 *
 * The manifest is generated at BUILD time by `VitePWA` (see `frontend/vite.config.ts`),
 * so the installed-app name it carries is baked into the bundle. That is the one
 * name a user sees on their home screen or in a window switcher, which makes it the
 * single most important thing to make instance-specific — so the server overrides
 * those fields on the way out instead.
 *
 * Overridden: `name`, `short_name`, and `icons` (pointed at the recolouring routes).
 *
 * Deliberately NOT overridden: `theme_color` / `background_color`. Those are the
 * dark UI background (#1a1b1e), not an accent — a browser paints them across the
 * PWA status bar and splash screen, so setting them to a saturated brand colour
 * would produce a screen that does not match the app it is introducing. Instance
 * identity is carried by the name and the icons.
 */

import { resolveBranding } from "@shared/branding";
import { logger } from "../logger";
import type { NarraForkSettings } from "../settings/types";

/**
 * Icon entries point at the branding routes rather than the static PNGs.
 *
 * Those routes serve `no-cache` + ETag, so an admin changing the colour is picked
 * up on the next revalidation. Pointing at `pwa-512x512.png` would pin the
 * default icon for anyone who already installed the app.
 *
 * The paths are RELATIVE, resolved by the browser against the manifest's own URL.
 * A rooted `/api/branding/…` would address the origin root, which is not where
 * NarraFork lives when it is mounted under a prefix (a reverse-proxy subpath, or
 * code-server's `/proxy/<port>/`) — the icons would 404 and an installed app would
 * fall back to a generic placeholder with nothing pointing at the cause.
 */
const BRANDED_ICONS = [
	{ src: "api/branding/icon-192.png", sizes: "192x192", type: "image/png" },
	{ src: "api/branding/icon-512.png", sizes: "512x512", type: "image/png" },
	{
		src: "api/branding/icon-512.png",
		sizes: "512x512",
		type: "image/png",
		purpose: "maskable",
	},
] as const;

/**
 * Apply branding to a static manifest body.
 *
 * Unparseable input is returned untouched: a manifest we cannot read is still a
 * manifest the browser might accept, and replacing it with a guess would be worse
 * than serving the unbranded original.
 */
export function brandManifestJson(staticBody: string, settings: NarraForkSettings): string {
	const branding = resolveBranding(settings.branding);

	let parsed: Record<string, unknown>;
	try {
		const candidate: unknown = JSON.parse(staticBody);
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
			return staticBody;
		}
		parsed = candidate as Record<string, unknown>;
	} catch (error) {
		logger.warn("Static web manifest could not be parsed; serving it unbranded", {
			error: String(error),
		});
		return staticBody;
	}

	return JSON.stringify({
		...parsed,
		name: branding.name,
		short_name: branding.name,
		icons: BRANDED_ICONS,
	});
}
