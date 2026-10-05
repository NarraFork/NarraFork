/**
 * branding-manifest.test.ts — Contract for the branded web manifest.
 *
 * The manifest carries the name a user sees on their home screen or in a window
 * switcher, so it is the single most important instance-specific string. Every
 * property here fails silently if broken: an unbranded name looks like the feature
 * was never configured, static icon paths pin the old icon for anyone who already
 * installed the app, and a brand-coloured `theme_color` produces a saturated status
 * bar that does not match the dark UI behind it.
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_BRAND_NAME } from "@shared/branding";
import { brandManifestJson } from "../../server/lib/branding";
import type { NarraForkSettings } from "../../server/lib/settings/types";

/** The manifest VitePWA generates, reduced to the fields under test. */
const STATIC_MANIFEST = JSON.stringify({
	name: "NarraFork",
	short_name: "NarraFork",
	description: "AI-powered collaborative programming with narrative forking",
	start_url: "/",
	display: "standalone",
	display_override: ["window-controls-overlay"],
	background_color: "#1a1b1e",
	theme_color: "#1a1b1e",
	lang: "en",
	scope: "/",
	icons: [
		{ src: "pwa-192x192.png", sizes: "192x192", type: "image/png" },
		{ src: "pwa-512x512.png", sizes: "512x512", type: "image/png" },
		{ src: "pwa-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
	],
});

interface WebManifest {
	name: string;
	short_name: string;
	description?: string;
	theme_color?: string;
	background_color?: string;
	start_url?: string;
	scope?: string;
	display?: string;
	display_override?: string[];
	lang?: string;
	icons: Array<{ src: string; sizes: string; type: string; purpose?: string }>;
}

function brand(branding: NarraForkSettings["branding"]): WebManifest {
	const settings = { branding } as NarraForkSettings;
	return JSON.parse(brandManifestJson(STATIC_MANIFEST, settings)) as WebManifest;
}

describe("brandManifestJson", () => {
	test("substitutes the instance name into both name fields", () => {
		const manifest = brand({ name: "Work Instance" });
		expect(manifest.name).toBe("Work Instance");
		expect(manifest.short_name).toBe("Work Instance");
	});

	test("uses the NarraFork default when no name is configured", () => {
		const manifest = brand(undefined);
		expect(manifest.name).toBe(DEFAULT_BRAND_NAME);
		expect(manifest.short_name).toBe(DEFAULT_BRAND_NAME);
	});

	test("normalizes a stored name rather than passing it through raw", () => {
		const manifest = brand({ name: "  Spaced   Out  " });
		expect(manifest.name).toBe("Spaced Out");
	});

	test("points icons at the branding routes, never the static PNGs", () => {
		// Static paths would be precache-pinned for installed users; the branding routes
		// revalidate, so a colour change reaches them.
		const manifest = brand({ iconColor: "#e64980" });
		expect(manifest.icons.map((icon) => icon.src)).toEqual([
			"api/branding/icon-192.png",
			"api/branding/icon-512.png",
			"api/branding/icon-512.png",
		]);
		for (const icon of manifest.icons) {
			expect(icon.src.startsWith("api/branding/")).toBe(true);
		}
	});

	test("rewrites icons even for a default install, so installing never pins a static path", () => {
		const manifest = brand(undefined);
		for (const icon of manifest.icons) {
			expect(icon.src.startsWith("api/branding/")).toBe(true);
		}
	});

	test("keeps icon paths relative so a prefixed mount resolves them", () => {
		// A rooted `/api/branding/…` addresses the origin root, which is not where the
		// app lives behind a reverse-proxy subpath or code-server's `/proxy/<port>/`.
		// The icons would 404 and an installed app would show a generic placeholder,
		// with nothing in the failure pointing back at the manifest.
		for (const icon of brand({ iconColor: "#e64980" }).icons) {
			expect(icon.src.startsWith("/")).toBe(false);
		}
	});

	test("keeps a maskable variant", () => {
		// Dropping it makes Android render the icon inside a white circle.
		const manifest = brand({ iconColor: "#e64980" });
		expect(manifest.icons.some((icon) => icon.purpose === "maskable")).toBe(true);
	});

	test("keeps both declared sizes", () => {
		const manifest = brand(undefined);
		expect(manifest.icons.map((icon) => icon.sizes)).toContain("192x192");
		expect(manifest.icons.map((icon) => icon.sizes)).toContain("512x512");
	});

	test("leaves theme_color and background_color at the dark UI background", () => {
		// These paint the PWA status bar and splash screen. They describe the app's
		// BACKGROUND, not its accent — setting them to a brand colour produces a
		// launch screen that does not match the app it introduces. Instance identity is
		// carried by the name and icons instead.
		const manifest = brand({ iconColor: "#e64980", name: "Work" });
		expect(manifest.theme_color).toBe("#1a1b1e");
		expect(manifest.background_color).toBe("#1a1b1e");
	});

	test("preserves every unrelated field", () => {
		const manifest = brand({ name: "Work" });
		expect(manifest.description).toBe(
			"AI-powered collaborative programming with narrative forking",
		);
		expect(manifest.start_url).toBe("/");
		expect(manifest.scope).toBe("/");
		expect(manifest.display).toBe("standalone");
		// WCO opt-in must survive branding verbatim — the frontend layout adapts to
		// it (styles/wco.css), so a rewrite that dropped it would desync the two.
		expect(manifest.display_override).toEqual(["window-controls-overlay"]);
		expect(manifest.lang).toBe("en");
	});

	test("returns unparseable input untouched instead of guessing", () => {
		// A manifest we cannot read is still one the browser might accept; replacing it
		// with a synthesized guess would be strictly worse than serving it unbranded.
		const settings = { branding: { name: "Work" } } as NarraForkSettings;
		expect(brandManifestJson("not json at all", settings)).toBe("not json at all");
		expect(brandManifestJson("[1,2,3]", settings)).toBe("[1,2,3]");
		expect(brandManifestJson("null", settings)).toBe("null");
	});
});
