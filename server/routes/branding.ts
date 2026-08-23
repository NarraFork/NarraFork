/**
 * Public branding endpoints: the instance name/colour, and the recoloured icons.
 *
 * PUBLIC on purpose, and that is the load-bearing decision here. The tab title,
 * the favicon and the login page heading all have to be right BEFORE a session
 * exists — the login screen is exactly where a user needs to know which instance
 * they are about to sign into. Gating these behind auth would leave every
 * pre-login surface showing the default brand.
 *
 * The exposure is an instance display name and a hex colour, which are chosen
 * precisely so they can be shown to anyone who can reach the page. No other
 * settings field is reachable through here: the JSON payload is constructed
 * field-by-field rather than spread from settings.
 *
 * Caching: every route sends `Cache-Control: no-cache` plus a strong ETag. These
 * are fixed URLs whose CONTENT changes when an admin edits the colour, so the
 * filename cannot carry the version (the same problem the plugin UI runtime has —
 * see `NO_CACHE_FRONTEND_PATHS` in `server/main.ts`). Revalidation keeps a colour
 * change immediate while 304s keep the byte cost near zero.
 */

import { resolveBranding } from "@shared/branding";
import { Hono } from "hono";
import { type BrandAssetName, getBrandIcons } from "../lib/branding";
import { logger } from "../lib/logger";
import { settings } from "../lib/settings";

const app = new Hono();

/** Route path → logical asset. Paths carry the extension so browsers sniff nothing. */
const ASSET_ROUTES: Array<{ path: string; asset: BrandAssetName }> = [
	{ path: "/favicon.svg", asset: "favicon" },
	{ path: "/icon-192.png", asset: "icon192" },
	{ path: "/icon-512.png", asset: "icon512" },
	{ path: "/apple-touch-icon.png", asset: "appleTouch" },
];

app.get("/", (c) => {
	const branding = resolveBranding(settings.branding);
	// Built explicitly rather than spread: this response is unauthenticated, so the
	// shape must not be able to grow by accident when `settings.branding` does.
	return c.json(
		{
			name: branding.name,
			iconColor: branding.iconColor,
			customized: branding.customized,
		},
		200,
		{ "Cache-Control": "no-cache" },
	);
});

for (const { path, asset } of ASSET_ROUTES) {
	app.get(path, async (c) => {
		const branding = resolveBranding(settings.branding);
		let icons: Awaited<ReturnType<typeof getBrandIcons>>;
		try {
			icons = await getBrandIcons(branding.iconColor);
		} catch (error) {
			logger.warn("Brand icon generation failed", { path, error: String(error) });
			return c.notFound();
		}

		const item = icons[asset];
		// Absent means the source asset could not be read (already logged by the icon
		// layer). 404 lets the caller fall back to the statically served default icon
		// instead of showing a broken image.
		if (!item) return c.notFound();

		if (c.req.header("if-none-match") === item.etag) {
			return c.body(null, 304, { ETag: item.etag, "Cache-Control": "no-cache" });
		}

		return c.body(item.body as unknown as ArrayBuffer, 200, {
			"Content-Type": item.contentType,
			"Cache-Control": "no-cache",
			ETag: item.etag,
		});
	});
}

export default app;
