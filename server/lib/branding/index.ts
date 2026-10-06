/**
 * Server-side entry point for per-instance branding.
 *
 * See `shared/branding.ts` for the resolution rules and `./icons.ts` for how the
 * shipped icon assets are recoloured and cached.
 */

import {
	normalizeBrandIconColor,
	normalizeBrandName,
	type ResolvedBranding,
	resolveBranding,
} from "@shared/branding";
import type { NarraForkSettings } from "../settings/types";
import { clearBrandIconCache } from "./icons";

export {
	BRAND_ASSET_FILES,
	type BrandAsset,
	type BrandAssetName,
	type BrandIconSet,
	clearBrandIconCache,
	getBrandIcons,
} from "./icons";
export { brandManifestJson } from "./manifest";
export { decodeRgbaPng, encodeRgbaPng, recolorBrandPng, recolorRgbaPixels } from "./png-recolor";

/** Branding for the running instance, always resolved to displayable values. */
export function getResolvedBranding(settings: NarraForkSettings): ResolvedBranding {
	return resolveBranding(settings.branding);
}

/**
 * Canonicalize stored branding after a settings patch.
 *
 * Runs on the merged object so the persisted file only ever holds normalized
 * values: a `#ABC` colour becomes `#aabbcc`, and a name/colour that resolves to
 * blank is dropped rather than stored as `""`. Dropping is what makes "clear the
 * field" work — the UI sends an empty string, and an empty string persisted as-is
 * would be indistinguishable from an unset field only by accident.
 *
 * Also drops the whole `branding` object when nothing is left, so an instance that
 * never customized anything has no stray key in `settings.json`.
 */
export function normalizeBrandingSettings(settings: NarraForkSettings): void {
	const branding = settings.branding;
	if (!branding) return;

	const name = normalizeBrandName(branding.name);
	const iconColor = normalizeBrandIconColor(branding.iconColor);

	if (!name && !iconColor) {
		delete settings.branding;
		clearBrandIconCache();
		return;
	}

	const next: NonNullable<NarraForkSettings["branding"]> = {};
	if (name) next.name = name;
	if (iconColor) next.iconColor = iconColor;

	const changed = branding.name !== next.name || branding.iconColor !== next.iconColor;
	settings.branding = next;

	// The icon cache is keyed by colour, so a changed colour would otherwise keep
	// serving the previous icons for the process lifetime.
	if (changed) clearBrandIconCache();
}
