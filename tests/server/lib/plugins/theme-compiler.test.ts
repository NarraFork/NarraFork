import { describe, expect, test } from "bun:test";
import { collectThemeBackgroundImages, safeParseManifest } from "@server/lib/plugins/manifest";
import {
	buildThemeKey,
	compileThemeTokens,
	generateShades,
	MAX_COMPILED_THEME_CSS_LENGTH,
} from "@server/lib/plugins/theme-compiler";

describe("generateShades", () => {
	test("returns exactly 10 valid hex shades running light to dark", () => {
		const shades = generateShades("#e8590c");
		expect(shades).toHaveLength(10);
		for (const shade of shades) {
			expect(shade).toMatch(/^#[0-9a-f]{6}$/);
		}
		// Perceived lightness should trend downward (shade 0 lighter than shade 9).
		const lightnessOf = (hex: string) => {
			const n = Number.parseInt(hex.slice(1), 16);
			return ((n >> 16) & 0xff) + ((n >> 8) & 0xff) + (n & 0xff);
		};
		expect(lightnessOf(shades[0])).toBeGreaterThan(lightnessOf(shades[9]));
	});

	test("accepts shorthand hex and rgb() forms", () => {
		expect(generateShades("#fff")).toHaveLength(10);
		expect(generateShades("rgb(232, 89, 12)")).toHaveLength(10);
	});
});

describe("compileThemeTokens - happy path", () => {
	test("compiles a primary color into a scoped rule with primary aliases", () => {
		const css = compileThemeTokens(
			{ primaryColor: "#e8590c" },
			"com.example.theme",
			"sunset",
			"dark",
		);
		expect(css).toContain(
			':root[data-plugin-theme="com.example.theme__sunset"][data-mantine-color-scheme="dark"]',
		);
		expect(css).toContain("--mantine-primary-color-6:");
		expect(css).toContain("--mantine-primary-color-filled:");
		expect(css).toContain("--mantine-color-primary-0:");
	});

	test("compiles body/text colors", () => {
		const css = compileThemeTokens(
			{ body: "#1a1512", text: "#f0f0f0" },
			"com.example.theme",
			"night",
			"both",
		);
		expect(css).toContain("--mantine-color-body: #1a1512;");
		expect(css).toContain("--mantine-color-text: #f0f0f0;");
		// "both" scheme omits the color-scheme attribute selector.
		expect(css).not.toContain("data-mantine-color-scheme");
	});

	test("expands a named single color into a 10-shade scale", () => {
		const css = compileThemeTokens(
			{ colors: { brand: "#2f9e44" } },
			"com.example.theme",
			"forest",
			"light",
		);
		for (let i = 0; i < 10; i++) {
			expect(css).toContain(`--mantine-color-brand-${i}:`);
		}
	});

	test("accepts a full 10-shade scale as provided", () => {
		const scale: [string, string, string, string, string, string, string, string, string, string] =
			[
				"#f1f8ff",
				"#d0e7ff",
				"#a8d0ff",
				"#7cb8ff",
				"#57a3ff",
				"#3d94ff",
				"#2f8cff",
				"#1f79e6",
				"#0f6bce",
				"#005cb8",
			];
		const css = compileThemeTokens(
			{ colors: { ocean: scale } },
			"com.example.theme",
			"ocean",
			"dark",
		);
		expect(css).toContain(`--mantine-color-ocean-0: ${scale[0]};`);
		expect(css).toContain(`--mantine-color-ocean-9: ${scale[9]};`);
	});

	test("derives an xs..xl ladder for box-model tokens", () => {
		const css = compileThemeTokens(
			{ spacing: "16px", fontSize: "14px", radius: "8px" },
			"com.example.theme",
			"comfy",
			"both",
		);
		expect(css).toContain("--mantine-spacing-md: 16px;");
		expect(css).toContain("--mantine-font-size-md: 14px;");
		expect(css).toContain("--mantine-radius-md: 8px;");
		// Ladder produces xs and xl variants too.
		expect(css).toContain("--mantine-spacing-xs:");
		expect(css).toContain("--mantine-spacing-xl:");
	});
});

describe("compileThemeTokens - security / defense in depth", () => {
	test("drops a color smuggling url()", () => {
		const css = compileThemeTokens(
			// biome-ignore lint/suspicious/noExplicitAny: intentionally malformed input
			{ body: "url(https://evil.example/x)" as any },
			"com.example.theme",
			"evil",
			"dark",
		);
		expect(css).not.toContain("url(");
		// No other tokens → no rule at all.
		expect(css).toBe("");
	});

	test("drops a color smuggling @import / closing tag / expression", () => {
		for (const malicious of [
			'@import "https://evil.example/x.css"',
			"</style><script>alert(1)</script>",
			"expression(alert(1))",
			"#fff;} :root{--mantine-color-body:red",
			"var(--x)",
		]) {
			const css = compileThemeTokens(
				// biome-ignore lint/suspicious/noExplicitAny: intentionally malformed input
				{ primaryColor: malicious as any },
				"com.example.theme",
				"x",
				"dark",
			);
			expect(css).toBe("");
		}
	});

	test("rejects out-of-range and expression dimensions", () => {
		for (const bad of ["0px", "9999px", "10%", "calc(1px + 2px)", "1vh", "-5px"]) {
			const css = compileThemeTokens(
				// biome-ignore lint/suspicious/noExplicitAny: intentionally malformed input
				{ spacing: bad as any },
				"com.example.theme",
				"x",
				"both",
			);
			expect(css).toBe("");
		}
	});

	test("clamps oversize font-size out of policy", () => {
		// 64px exceeds fontSize max (32px) → dropped.
		const css = compileThemeTokens({ fontSize: "64px" }, "com.example.theme", "x", "both");
		expect(css).toBe("");
	});

	test("drops a malformed named color scale (wrong length)", () => {
		const css = compileThemeTokens(
			// biome-ignore lint/suspicious/noExplicitAny: intentionally malformed input
			{ colors: { short: ["#fff", "#000"] as any } },
			"com.example.theme",
			"x",
			"dark",
		);
		expect(css).toBe("");
	});

	test("drops a named color with an unsafe shade in the scale", () => {
		const scale = Array.from({ length: 10 }, () => "#ffffff");
		scale[5] = "url(x)";
		const css = compileThemeTokens(
			// biome-ignore lint/suspicious/noExplicitAny: intentionally malformed input
			{ colors: { mixed: scale as any } },
			"com.example.theme",
			"x",
			"dark",
		);
		expect(css).toBe("");
	});

	test("returns empty for tokens that produce no declarations", () => {
		expect(compileThemeTokens({}, "com.example.theme", "empty", "both")).toBe("");
	});

	test("compiled output never exceeds the size cap", () => {
		const scale = Array.from({ length: 10 }, () => "#ffffff");
		const colors: Record<string, string[]> = {};
		for (let i = 0; i < 40; i++) colors[`c${i}`] = scale;
		const css = compileThemeTokens(
			// biome-ignore lint/suspicious/noExplicitAny: bulk fixture uses plain arrays
			{ primaryColor: "#e8590c", body: "#000", colors: colors as any },
			"com.example.theme",
			"big",
			"both",
		);
		// Either it fits under the cap, or it is dropped to empty — never oversize.
		expect(css.length).toBeLessThanOrEqual(MAX_COMPILED_THEME_CSS_LENGTH);
	});
});

describe("buildThemeKey", () => {
	test("joins pluginId and themeId with a double underscore", () => {
		expect(buildThemeKey("com.example.theme", "sunset")).toBe("com.example.theme__sunset");
	});
});

describe("compileThemeTokens - dual (light/dark) themes", () => {
	const pid = "com.example.duo";
	const tid = "duo";

	test("emits a base rule plus per-scheme override rules for both variants", () => {
		const css = compileThemeTokens(
			{
				radius: "6px", // shared base
				light: { primaryColor: "#e8590c", body: "#fff4d6" },
				dark: { primaryColor: "#ff1f8f", body: "#12060f" },
			},
			pid,
			tid,
			"both",
		);
		// Base rule (scheme-agnostic) carries the shared radius.
		expect(css).toContain(`:root[data-plugin-theme="${pid}__${tid}"] {`);
		expect(css).toContain("--mantine-radius-md: 6px;");
		// Light override rule.
		expect(css).toContain(
			`:root[data-plugin-theme="${pid}__${tid}"][data-mantine-color-scheme="light"]`,
		);
		expect(css).toContain("--mantine-color-body: #fff4d6;");
		// Dark override rule.
		expect(css).toContain(
			`:root[data-plugin-theme="${pid}__${tid}"][data-mantine-color-scheme="dark"]`,
		);
		expect(css).toContain("--mantine-color-body: #12060f;");
	});

	test("supports only one variant being present", () => {
		const css = compileThemeTokens(
			{ primaryColor: "#888888", dark: { body: "#000000" } },
			pid,
			tid,
			"both",
		);
		// Base rule with shared primary.
		expect(css).toContain(`:root[data-plugin-theme="${pid}__${tid}"] {`);
		expect(css).toContain("--mantine-primary-color-filled:");
		// Dark override present, no light-specific rule.
		expect(css).toContain('[data-mantine-color-scheme="dark"]');
		expect(css).not.toContain('[data-mantine-color-scheme="light"]');
	});

	test("ignores variants when colorScheme is not 'both'", () => {
		// A single-scheme theme should not split into per-scheme rules.
		const css = compileThemeTokens(
			{ body: "#101010", light: { body: "#ffffff" } },
			pid,
			tid,
			"dark",
		);
		expect(css).toContain('[data-mantine-color-scheme="dark"]');
		// The light sub-token is not emitted for a dark-only theme.
		expect(css).not.toContain("--mantine-color-body: #ffffff;");
		expect(css).toContain("--mantine-color-body: #101010;");
	});

	test("drops malicious values inside a variant (defense in depth)", () => {
		const css = compileThemeTokens(
			{
				light: { body: "#ffffff" },
				// biome-ignore lint/suspicious/noExplicitAny: intentionally malformed
				dark: { body: "url(https://evil.example/x)" as any },
			},
			pid,
			tid,
			"both",
		);
		expect(css).not.toContain("url(");
		// Light variant still compiles; dark variant contributes nothing.
		expect(css).toContain("--mantine-color-body: #ffffff;");
	});

	test("dual output still respects the size cap", () => {
		const bigColors: Record<string, string> = {};
		for (let i = 0; i < 40; i++) bigColors[`c${i}`] = "#ffffff";
		const css = compileThemeTokens(
			// biome-ignore lint/suspicious/noExplicitAny: bulk fixture
			{ light: { colors: bigColors as any }, dark: { colors: bigColors as any } },
			pid,
			tid,
			"both",
		);
		expect(css.length).toBeLessThanOrEqual(MAX_COMPILED_THEME_CSS_LENGTH);
	});
});

describe("compileThemeTokens - background images", () => {
	const pid = "com.example.scenic";
	const tid = "scenic";
	const ctx = { version: "1.0.0", hash: "a".repeat(64) };

	test("emits a same-origin url and background props for a region", () => {
		const css = compileThemeTokens(
			{
				backgrounds: {
					main: { image: "assets/bg.jpg", size: "cover", position: "center", repeat: "no-repeat" },
				},
			},
			pid,
			tid,
			"light",
			ctx,
		);
		// Region maps to the stable host class under the theme scope.
		expect(css).toContain(
			`:root[data-plugin-theme="${pid}__${tid}"][data-mantine-color-scheme="light"] .nf-app-shell-main {`,
		);
		// Host-built same-origin URL, not a raw plugin url.
		expect(css).toContain(
			`background-image: url("/api/plugins/ui/${pid}/1.0.0/${ctx.hash}/theme-asset/assets/bg.jpg")`,
		);
		expect(css).toContain("background-size: cover;");
		expect(css).toContain("background-position: center;");
		expect(css).toContain("background-repeat: no-repeat;");
	});

	test("maps body region to the scope root (no descendant selector)", () => {
		const css = compileThemeTokens(
			{ backgrounds: { body: { image: "bg.png" } } },
			pid,
			tid,
			"both",
			ctx,
		);
		// body target is "" so the rule is just the scope selector.
		expect(css).toContain(`:root[data-plugin-theme="${pid}__${tid}"] {`);
		expect(css).toContain("theme-asset/bg.png");
	});

	test("emits an overlay scrim layered above the image", () => {
		const css = compileThemeTokens(
			{ backgrounds: { app: { image: "bg.jpg", overlay: "scrim-dark" } } },
			pid,
			tid,
			"light",
			ctx,
		);
		expect(css).toContain("linear-gradient(");
		expect(css).toContain("var(--mantine-color-body)");
		// scrim comes before the image in the layer list.
		expect(css.indexOf("linear-gradient(")).toBeLessThan(css.indexOf('url("'));
	});

	test("opacity controls the scrim strength (percentage in the wash)", () => {
		const css = compileThemeTokens(
			{ backgrounds: { main: { image: "bg.jpg", overlay: "scrim-dark", opacity: 0.4 } } },
			pid,
			tid,
			"both",
			ctx,
		);
		// 0.4 → 40% body-color wash in the scrim gradient.
		expect(css).toContain("var(--mantine-color-body) 40%");
	});

	test("out-of-range opacity falls back to the default scrim strength", () => {
		const css = compileThemeTokens(
			// biome-ignore lint/suspicious/noExplicitAny: out-of-range on purpose
			{ backgrounds: { main: { image: "bg.jpg", overlay: "scrim-dark", opacity: 5 as any } } },
			pid,
			tid,
			"both",
			ctx,
		);
		// 5 is out of [0,1] → default 60% wash, never a raw "500%" etc.
		expect(css).toContain("var(--mantine-color-body) 60%");
		expect(css).not.toContain("500%");
	});

	test("drops a non-whitelisted region", () => {
		const css = compileThemeTokens(
			// biome-ignore lint/suspicious/noExplicitAny: unknown region on purpose
			{ backgrounds: { sidebar: { image: "bg.jpg" } } as any },
			pid,
			tid,
			"both",
			ctx,
		);
		expect(css).toBe("");
	});

	test("drops a traversal / absolute / external image path", () => {
		for (const bad of ["../secret.png", "/etc/passwd", "https://evil.example/x.png"]) {
			const css = compileThemeTokens(
				{ backgrounds: { main: { image: bad } } },
				pid,
				tid,
				"both",
				ctx,
			);
			expect(css).toBe("");
		}
	});

	test("emits nothing without an asset context (backgrounds need version/hash)", () => {
		const css = compileThemeTokens(
			{ backgrounds: { main: { image: "bg.jpg" } } },
			pid,
			tid,
			"both",
		);
		expect(css).toBe("");
	});

	/**
	 * The host serves declared background images unauthenticated and same-origin,
	 * with the Content-Type derived from the extension. A non-raster extension
	 * would therefore become same-origin script/markup delivery, so the manifest
	 * schema must reject it before the package is ever installed.
	 */
	describe("manifest rejects non-raster background images", () => {
		function manifestWithBackground(image: string) {
			return {
				schemaVersion: 1,
				pluginId: "com.example.scenic",
				version: "1.0.0",
				displayName: "Scenic",
				engine: { runtime: "bun", hostApi: ">=1.0 <2", rpc: "narrafork.rpc/1" },
				activationEvents: [],
				contributes: {
					themes: [
						{
							id: "scenic",
							title: "Scenic",
							colorScheme: "both",
							tokens: { backgrounds: { body: { image } } },
						},
					],
				},
				permissions: {
					host: ["ui.theme"],
					network: { mode: "none", allow: [] },
					filesystem: { package: "readOnly", pluginData: "none", workspace: "none" },
					process: { spawn: "none" },
				},
			};
		}

		test.each([
			"assets/xss.html",
			"assets/steal.js",
			"assets/bg.svg",
			"assets/data.json",
			"assets/theme.css",
			"assets/noextension",
		])("rejects %s", (image) => {
			const parsed = safeParseManifest(manifestWithBackground(image));
			expect(parsed.success).toBe(false);
		});

		test.each([
			"assets/bg.png",
			"assets/bg.JPG",
			"assets/bg.jpeg",
			"assets/bg.webp",
		])("still accepts the raster image %s", (image) => {
			const parsed = safeParseManifest(manifestWithBackground(image));
			expect(parsed.success).toBe(true);
			if (parsed.success) {
				expect(collectThemeBackgroundImages(parsed.data.contributes.themes[0])).toEqual([image]);
			}
		});
	});

	test("supports different backgrounds per light/dark variant", () => {
		const css = compileThemeTokens(
			{
				light: { backgrounds: { body: { image: "day.jpg" } } },
				dark: { backgrounds: { body: { image: "night.jpg" } } },
			},
			pid,
			tid,
			"both",
			ctx,
		);
		expect(css).toContain('[data-mantine-color-scheme="light"] {');
		expect(css).toContain("theme-asset/day.jpg");
		expect(css).toContain('[data-mantine-color-scheme="dark"] {');
		expect(css).toContain("theme-asset/night.jpg");
	});
});
