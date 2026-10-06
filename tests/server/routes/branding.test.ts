/**
 * branding.test.ts — Contract for the public branding API.
 *
 * The properties asserted here are the ones whose violation would be invisible in
 * normal use: the endpoint quietly becoming authenticated (breaking the login page
 * and the tab title for anyone not signed in), the payload growing to leak other
 * settings, or ETags that do not change when the colour does — which would leave
 * users on the previous icon with nothing to indicate it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_BRAND_ICON_COLOR, DEFAULT_BRAND_NAME } from "@shared/branding";
import { Hono } from "hono";
import { clearBrandIconCache } from "../../../server/lib/branding";
import { settings } from "../../../server/lib/settings";
import brandingRoutes from "../../../server/routes/branding";

const app = new Hono().route("/api/branding", brandingRoutes);

const ICON_PATHS = [
	"/api/branding/favicon.svg",
	"/api/branding/icon-192.png",
	"/api/branding/icon-512.png",
	"/api/branding/apple-touch-icon.png",
] as const;

function setBranding(branding: { name?: string; iconColor?: string } | undefined): void {
	if (branding) settings.branding = branding;
	else delete settings.branding;
	clearBrandIconCache();
}

afterEach(() => {
	setBranding(undefined);
});

describe("GET /api/branding", () => {
	test("serves without authentication", async () => {
		// This is the whole reason the route is mounted before the session gate: the
		// login page heading and the browser tab both need the name before a session
		// exists. Auth here would silently revert every pre-login surface to the
		// default brand.
		const response = await app.request("/api/branding");
		expect(response.status).toBe(200);
	});

	test("returns the NarraFork defaults when nothing is configured", async () => {
		setBranding(undefined);
		const body = await (await app.request("/api/branding")).json();
		expect(body).toEqual({
			name: DEFAULT_BRAND_NAME,
			iconColor: DEFAULT_BRAND_ICON_COLOR,
			customized: false,
		});
	});

	test("reflects the configured name and colour", async () => {
		setBranding({ name: "Work Instance", iconColor: "#e64980" });
		const body = await (await app.request("/api/branding")).json();
		expect(body).toEqual({
			name: "Work Instance",
			iconColor: "#e64980",
			customized: true,
		});
	});

	test("exposes only the three branding fields, whatever else settings hold", async () => {
		// The response is built field-by-field rather than spread, so this asserts the
		// shape cannot grow by accident on an UNAUTHENTICATED endpoint.
		setBranding({ name: "Home", iconColor: "#12b886" });
		const body = (await (await app.request("/api/branding")).json()) as Record<string, unknown>;
		expect(Object.keys(body).sort()).toEqual(["customized", "iconColor", "name"]);
	});

	test("normalizes a stored short-form colour before returning it", async () => {
		setBranding({ iconColor: "#ABC" });
		const body = (await (await app.request("/api/branding")).json()) as { iconColor: string };
		expect(body.iconColor).toBe("#aabbcc");
	});

	test("falls back rather than surfacing an invalid stored colour", async () => {
		setBranding({ iconColor: "not-a-colour" });
		const body = (await (await app.request("/api/branding")).json()) as {
			iconColor: string;
			customized: boolean;
		};
		expect(body.iconColor).toBe(DEFAULT_BRAND_ICON_COLOR);
		expect(body.customized).toBe(false);
	});

	test("is not cached, so a colour change is visible on the next load", async () => {
		const response = await app.request("/api/branding");
		expect(response.headers.get("cache-control")).toBe("no-cache");
	});
});

describe("brand icon routes", () => {
	test("serve without authentication", async () => {
		for (const path of ICON_PATHS) {
			const response = await app.request(path);
			expect(response.status).toBe(200);
		}
	});

	test("return the right content types", async () => {
		const expected: Record<string, string> = {
			"/api/branding/favicon.svg": "image/svg+xml",
			"/api/branding/icon-192.png": "image/png",
			"/api/branding/icon-512.png": "image/png",
			"/api/branding/apple-touch-icon.png": "image/png",
		};
		for (const path of ICON_PATHS) {
			const response = await app.request(path);
			expect(response.headers.get("content-type")).toBe(expected[path]);
		}
	});

	test("carry no-cache plus an ETag", async () => {
		// Fixed URLs with changing content: correctness rests on revalidation, and the
		// ETag is what keeps that revalidation cheap.
		for (const path of ICON_PATHS) {
			const response = await app.request(path);
			expect(response.headers.get("cache-control")).toBe("no-cache");
			expect(response.headers.get("etag")).toBeTruthy();
		}
	});

	test("honour If-None-Match with a 304 and no body", async () => {
		const first = await app.request("/api/branding/icon-192.png");
		const etag = first.headers.get("etag");
		expect(etag).toBeTruthy();
		if (!etag) return;

		const second = await app.request("/api/branding/icon-192.png", {
			headers: { "If-None-Match": etag },
		});
		expect(second.status).toBe(304);
		expect((await second.arrayBuffer()).byteLength).toBe(0);
	});

	test("change their ETag when the configured colour changes", async () => {
		// Without this, a browser holding the previous icon would never refetch — the
		// colour setting would appear to do nothing.
		setBranding({ iconColor: "#e64980" });
		const pink = await app.request("/api/branding/icon-512.png");
		const pinkEtag = pink.headers.get("etag");

		setBranding({ iconColor: "#12b886" });
		const teal = await app.request("/api/branding/icon-512.png");

		expect(pinkEtag).toBeTruthy();
		expect(teal.headers.get("etag")).not.toBe(pinkEtag);
	});

	test("do not vary with the instance NAME", async () => {
		// Names never reach an icon; a name-sensitive ETag would invalidate every
		// cached icon on an unrelated edit.
		setBranding({ iconColor: "#e64980", name: "One" });
		const first = (await app.request("/api/branding/icon-192.png")).headers.get("etag");
		setBranding({ iconColor: "#e64980", name: "Two" });
		const second = (await app.request("/api/branding/icon-192.png")).headers.get("etag");
		expect(second).toBe(first);
	});

	test("serve a recoloured SVG for a custom colour", async () => {
		setBranding({ iconColor: "#e64980" });
		const body = await (await app.request("/api/branding/favicon.svg")).text();
		expect(body).toContain("#e64980");
		expect(body).not.toContain(DEFAULT_BRAND_ICON_COLOR);
		// White strokes must survive: they are what makes the mark readable.
		expect(body).toContain('stroke="#fff"');
	});

	test("serve the untouched default asset when no colour is configured", async () => {
		setBranding(undefined);
		const body = await (await app.request("/api/branding/favicon.svg")).text();
		const shipped = await Bun.file("frontend/public/favicon.svg").text();
		expect(body).toBe(shipped);
	});

	test("serve valid PNG bytes", async () => {
		setBranding({ iconColor: "#e64980" });
		for (const path of ["/api/branding/icon-192.png", "/api/branding/icon-512.png"]) {
			const bytes = new Uint8Array(await (await app.request(path)).arrayBuffer());
			expect([...bytes.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
			expect(bytes.byteLength).toBeGreaterThan(500);
		}
	});

	test("declare the sizes their names promise", async () => {
		setBranding({ iconColor: "#e64980" });
		const cases: Array<[string, number]> = [
			["/api/branding/icon-192.png", 192],
			["/api/branding/icon-512.png", 512],
			["/api/branding/apple-touch-icon.png", 180],
		];
		for (const [path, size] of cases) {
			const bytes = new Uint8Array(await (await app.request(path)).arrayBuffer());
			const view = new DataView(bytes.buffer);
			// IHDR width/height live at byte 16 and 20 of a PNG.
			expect(view.getUint32(16)).toBe(size);
			expect(view.getUint32(20)).toBe(size);
		}
	});
});
