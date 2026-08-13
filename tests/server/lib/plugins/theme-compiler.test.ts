import { describe, expect, test } from "bun:test";
import {
	collectThemeAssets,
	collectThemeImages,
	safeParseManifest,
	THEME_BACKGROUND_REGIONS,
	THEME_BORDER_SURFACES,
	THEME_FRAME_TARGETS,
	THEME_GRADIENT_SURFACES,
	THEME_TEXT_SURFACES,
} from "@server/lib/plugins/manifest";
import {
	buildThemeKey,
	compileThemeContribution,
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
				expect(collectThemeImages(parsed.data.contributes.themes[0])).toEqual([image]);
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

	/**
	 * The container regions were added alongside frames so a theme can paint the
	 * surfaces inside the shell, not just the shell itself. They reuse the same
	 * region machinery, so only the selector mapping needs covering.
	 */
	test.each([
		["card", ".mantine-Card-root"],
		["paper", ".mantine-Paper-root"],
		["modal", ".mantine-Modal-content"],
		["input", ".mantine-Input-input"],
	])("maps the %s container region to %s", (region, selector) => {
		const css = compileThemeTokens(
			{ backgrounds: { [region]: { image: "bg.png" } } },
			pid,
			tid,
			"both",
			ctx,
		);
		expect(css).toContain(`:root[data-plugin-theme="${pid}__${tid}"] ${selector} {`);
		expect(css).toContain("theme-asset/bg.png");
	});

	test("manifest accepts the container regions", () => {
		const parsed = safeParseManifest({
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
						tokens: {
							backgrounds: {
								card: { image: "assets/card.png" },
								paper: { image: "assets/paper.png" },
								modal: { image: "assets/modal.png" },
								input: { image: "assets/input.png" },
							},
						},
					},
				],
			},
			permissions: {
				host: ["ui.theme"],
				network: { mode: "none", allow: [] },
				filesystem: { package: "readOnly", pluginData: "none", workspace: "none" },
				process: { spawn: "none" },
			},
		});
		expect(parsed.success).toBe(true);
	});
});

describe("compileThemeTokens - gradients", () => {
	const pid = "com.example.chrome";
	const tid = "chrome";
	const ctx = { version: "1.0.0", hash: "d".repeat(64) };

	test("assembles a linear-gradient from structured stops", () => {
		const css = compileThemeTokens(
			{ gradients: { header: { from: "#4a90d9", to: "#2f6ba8", angle: 180 } } },
			pid,
			tid,
			"both",
			ctx,
		);
		expect(css).toContain("background-image: linear-gradient(180deg, #4a90d9 0%, #2f6ba8 100%);");
	});

	test("supports an optional middle stop with a position", () => {
		const css = compileThemeTokens(
			{ gradients: { header: { from: "#fff", via: "#d8eaf8", viaAt: 45, to: "#b6d6ef" } } },
			pid,
			tid,
			"both",
			ctx,
		);
		expect(css).toContain("linear-gradient(180deg, #fff 0%, #d8eaf8 45%, #b6d6ef 100%);");
	});

	test("defaults the angle to 180deg and the middle stop to 50%", () => {
		const css = compileThemeTokens(
			{ gradients: { header: { from: "#fff", via: "#eee", to: "#ddd" } } },
			pid,
			tid,
			"both",
			ctx,
		);
		expect(css).toContain("linear-gradient(180deg, #fff 0%, #eee 50%, #ddd 100%);");
	});

	/**
	 * The reason gradients only ever emit `background-image` and never the
	 * `background` shorthand: Mantine's own Button/ActionIcon rules use the
	 * shorthand, which implicitly resets background-image. Emitting only
	 * background-image from a more specific scope selector overrides that while
	 * leaving the component's background-color intact. Verified in a real browser.
	 */
	test("never emits the background shorthand or a background-color", () => {
		const css = compileThemeTokens(
			{
				gradients: {
					button: { from: "#fff", to: "#ccc" },
					buttonHover: { from: "#eee", to: "#bbb" },
					actionIcon: { from: "#fff", to: "#ccc" },
				},
			},
			pid,
			tid,
			"both",
			ctx,
		);
		expect(css).toContain("background-image:");
		expect(css).not.toMatch(/(^|\s)background:/);
		expect(css).not.toContain("background-color:");
	});

	test.each([
		["button", ".mantine-Button-root"],
		["actionIcon", ".mantine-ActionIcon-root"],
		["header", ".mantine-AppShell-header"],
		["navbar", ".mantine-AppShell-navbar"],
		["input", ".mantine-Input-input"],
		["card", ".mantine-Card-root"],
	])("maps the %s gradient surface to %s", (surface, selector) => {
		const css = compileThemeTokens(
			{ gradients: { [surface]: { from: "#fff", to: "#ccc" } } },
			pid,
			tid,
			"both",
			ctx,
		);
		expect(css).toContain(`:root[data-plugin-theme="${pid}__${tid}"] ${selector} {`);
	});

	test("body gradient targets the scope root itself", () => {
		const css = compileThemeTokens(
			{ gradients: { body: { from: "#fff", to: "#ccc" } } },
			pid,
			tid,
			"both",
			ctx,
		);
		expect(css).toContain(`:root[data-plugin-theme="${pid}__${tid}"] {`);
	});

	test("needs no asset context (gradients reference no package files)", () => {
		const css = compileThemeTokens(
			{ gradients: { header: { from: "#fff", to: "#ccc" } } },
			pid,
			tid,
			"both",
		);
		expect(css).toContain("linear-gradient(");
	});

	/**
	 * Gradients and region backgrounds share one CSS property, so they must be
	 * composed into a layer stack. Building them in separate passes would let the
	 * later rule silently erase the earlier one.
	 */
	test("stacks a scrim, image and gradient as layers on one surface", () => {
		const css = compileThemeTokens(
			{
				backgrounds: { main: { image: "bg.png", overlay: "scrim-dark", opacity: 0.5 } },
				gradients: { main: { from: "#ffe1ef", to: "#ff8fc0" } },
			},
			pid,
			tid,
			"both",
			ctx,
		);
		// Exactly one background-image declaration for the surface.
		expect(css.match(/background-image:/g)).toHaveLength(1);
		// Order: scrim above image, gradient below it as the base wash.
		const scrimAt = css.indexOf("color-mix(");
		const imageAt = css.indexOf('url("');
		const gradientAt = css.indexOf("linear-gradient(135deg") + css.indexOf("#ffe1ef");
		expect(scrimAt).toBeLessThan(imageAt);
		expect(imageAt).toBeLessThan(css.indexOf("#ffe1ef"));
		expect(gradientAt).toBeGreaterThan(0);
	});

	test("per-layer size/position slots line up with the layer list", () => {
		const css = compileThemeTokens(
			{
				backgrounds: { main: { image: "bg.png", size: "contain", position: "top" } },
				gradients: { main: { from: "#fff", to: "#ccc" } },
			},
			pid,
			tid,
			"both",
			ctx,
		);
		// Two layers (image, gradient) → two slots each, image slot carries the
		// declared values and the gradient slot stays neutral.
		expect(css).toContain("background-size: contain, cover;");
		expect(css).toContain("background-position: top, center;");
	});

	test("supports different gradients per light/dark variant", () => {
		const css = compileThemeTokens(
			{
				light: { gradients: { header: { from: "#ffffff", to: "#cccccc" } } },
				dark: { gradients: { header: { from: "#222222", to: "#000000" } } },
			},
			pid,
			tid,
			"both",
			ctx,
		);
		expect(css).toContain('[data-mantine-color-scheme="light"] .mantine-AppShell-header {');
		expect(css).toContain("#ffffff 0%");
		expect(css).toContain('[data-mantine-color-scheme="dark"] .mantine-AppShell-header {');
		expect(css).toContain("#222222 0%");
	});
});

describe("compileThemeTokens - gradient security / defense in depth", () => {
	const pid = "com.example.chrome";
	const tid = "chrome";
	const ctx = { version: "1.0.0", hash: "d".repeat(64) };

	test("drops a non-whitelisted gradient surface", () => {
		const css = compileThemeTokens(
			// biome-ignore lint/suspicious/noExplicitAny: unknown surface on purpose
			{ gradients: { sidebar: { from: "#fff", to: "#ccc" } } as any },
			pid,
			tid,
			"both",
			ctx,
		);
		expect(css).toBe("");
	});

	test.each([
		"url(https://evil.example/x)",
		"red; background: url(evil)",
		"var(--secret)",
		"#fff) ; color: red; a:linear-gradient(#000",
		"calc(1px)",
	])("drops an unsafe color value %p", (bad) => {
		const css = compileThemeTokens(
			// biome-ignore lint/suspicious/noExplicitAny: intentionally malformed
			{ gradients: { header: { from: bad as any, to: "#ccc" } } },
			pid,
			tid,
			"both",
			ctx,
		);
		expect(css).toBe("");
	});

	test("drops an unsafe middle-stop color without emitting a partial gradient", () => {
		const css = compileThemeTokens(
			// biome-ignore lint/suspicious/noExplicitAny: intentionally malformed
			{ gradients: { header: { from: "#fff", via: "url(evil)" as any, to: "#ccc" } } },
			pid,
			tid,
			"both",
			ctx,
		);
		expect(css).toBe("");
		expect(css).not.toContain("linear-gradient");
	});

	test.each([
		-1,
		361,
		45.5,
		Number.NaN,
		Number.POSITIVE_INFINITY,
	])("falls back to 180deg for the out-of-policy angle %p", (angle) => {
		const css = compileThemeTokens(
			// biome-ignore lint/suspicious/noExplicitAny: out-of-policy on purpose
			{ gradients: { header: { from: "#fff", to: "#ccc", angle: angle as any } } },
			pid,
			tid,
			"both",
			ctx,
		);
		expect(css).toContain("linear-gradient(180deg,");
		expect(css).not.toContain(String(angle));
	});

	test.each([-5, 101, 50.5])("falls back to 50%% for the out-of-policy viaAt %p", (viaAt) => {
		const css = compileThemeTokens(
			// biome-ignore lint/suspicious/noExplicitAny: out-of-policy on purpose
			{ gradients: { header: { from: "#fff", via: "#eee", to: "#ccc", viaAt: viaAt as any } } },
			pid,
			tid,
			"both",
			ctx,
		);
		expect(css).toContain("#eee 50%");
	});

	describe("manifest validation", () => {
		function manifestWithTokens(tokens: unknown, fonts: readonly unknown[] = []) {
			return {
				schemaVersion: 1,
				pluginId: "com.example.chrome",
				version: "1.0.0",
				displayName: "Chrome",
				engine: { runtime: "bun", hostApi: ">=1.0 <2", rpc: "narrafork.rpc/1" },
				activationEvents: [],
				contributes: {
					themes: [{ id: "chrome", title: "Chrome", colorScheme: "both", fonts, tokens }],
				},
				permissions: {
					host: ["ui.theme"],
					network: { mode: "none", allow: [] },
					filesystem: { package: "readOnly", pluginData: "none", workspace: "none" },
					process: { spawn: "none" },
				},
			};
		}

		test("accepts a well-formed gradient", () => {
			const parsed = safeParseManifest(
				manifestWithTokens({
					gradients: {
						header: { from: "#4a90d9", via: "#3b7dd8", viaAt: 40, to: "#2f6ba8", angle: 170 },
					},
				}),
			);
			expect(parsed.success).toBe(true);
		});

		test.each([
			{ from: "#fff" },
			{ to: "#fff" },
			{ from: "#fff", to: "#ccc", angle: 400 },
			{ from: "#fff", to: "#ccc", viaAt: 120 },
			{ from: "#fff", to: "#ccc", stops: ["#000"] },
			{ from: "url(evil)", to: "#ccc" },
		])("rejects the malformed gradient %p", (gradient) => {
			expect(
				safeParseManifest(manifestWithTokens({ gradients: { header: gradient } })).success,
			).toBe(false);
		});

		test("rejects a raw CSS gradient string", () => {
			expect(
				safeParseManifest(
					manifestWithTokens({ gradients: { header: "linear-gradient(red, blue)" } }),
				).success,
			).toBe(false);
		});

		test("rejects an unknown gradient surface at the schema level", () => {
			expect(
				safeParseManifest(
					manifestWithTokens({ gradients: { sidebar: { from: "#fff", to: "#ccc" } } }),
				).success,
			).toBe(false);
		});

		test("accepts declared WOFF2 fonts and collects them as theme assets", () => {
			const parsed = safeParseManifest(
				manifestWithTokens(
					{
						fontFamily: { font: "brand", fallback: "system-ui" },
						fontFamilyMonospace: { font: "mono", fallback: "monospace" },
					},
					[
						{
							id: "brand",
							source: "assets/brand.woff2",
							weight: { min: 100, max: 900 },
						},
						{ id: "mono", source: "assets/mono.woff2" },
					],
				),
			);
			expect(parsed.success).toBe(true);
			if (!parsed.success) return;
			const theme = parsed.data.contributes.themes[0];
			// One collector covers every asset kind, so fonts land in the same
			// whitelist the asset route already enforces for images.
			expect(collectThemeAssets(theme)).toEqual(["assets/brand.woff2", "assets/mono.woff2"]);
			expect(collectThemeImages(theme)).toEqual([]);
		});

		test.each([
			{ fonts: [{ id: "brand", source: "https://example.com/font.woff2" }] },
			{ fonts: [{ id: "brand", source: "assets/font.ttf" }] },
			{ fonts: [{ id: "brand", source: "../font.woff2" }] },
			{
				fonts: [{ id: "brand", source: "assets/font.woff2", weight: { min: 900, max: 100 } }],
			},
		])("rejects an unsafe theme font declaration %p", ({ fonts }) => {
			expect(safeParseManifest(manifestWithTokens({}, fonts)).success).toBe(false);
		});

		test("rejects duplicate font IDs and missing font references", () => {
			expect(
				safeParseManifest(
					manifestWithTokens({ fontFamily: { font: "missing", fallback: "system-ui" } }, [
						{ id: "brand", source: "assets/brand.woff2" },
						{ id: "brand", source: "assets/brand-2.woff2" },
					]),
				).success,
			).toBe(false);
		});

		test("rejects more than four font faces per theme", () => {
			const fonts = Array.from({ length: 5 }, (_, index) => ({
				id: `font-${index}`,
				source: `assets/font-${index}.woff2`,
			}));
			expect(safeParseManifest(manifestWithTokens({}, fonts)).success).toBe(false);
		});
	});
});

describe("compileThemeTokens - fonts, shadows and per-surface text colors", () => {
	const pid = "com.example.chrome";
	const tid = "chrome";

	test("emits generic font-family keywords", () => {
		const css = compileThemeTokens(
			{ fontFamily: "serif", fontFamilyHeadings: "system-ui", fontFamilyMonospace: "monospace" },
			pid,
			tid,
			"both",
		);
		expect(css).toContain("--mantine-font-family: serif;");
		expect(css).toContain("--mantine-font-family-headings: system-ui;");
		expect(css).toContain("--mantine-font-family-monospace: monospace;");
	});

	test("compiles package-declared WOFF2 faces into generated family names", () => {
		const hash = "a".repeat(64);
		const contribution = {
			id: tid,
			title: "Chrome",
			colorScheme: "both" as const,
			fonts: [
				{
					id: "brand-sans",
					source: "assets/brand.woff2",
					weight: { min: 100, max: 900 },
					style: "normal" as const,
					display: "swap" as const,
				},
			],
			tokens: {
				fontFamily: { font: "brand-sans", fallback: "system-ui" as const },
				fontFamilyHeadings: { font: "brand-sans", fallback: "sans-serif" as const },
			},
		};
		const css = compileThemeContribution(contribution, pid, { version: "1.1.0", hash });
		expect(css).toContain('@font-face{font-family:"nf-theme-aaaaaaaaaaaaaaaa-chrome-brand-sans";');
		expect(css).toContain(
			`src:url("/api/plugins/ui/${pid}/1.1.0/${hash}/theme-asset/assets/brand.woff2") format("woff2")`,
		);
		expect(css).toContain("font-weight:100 900;font-display:swap;");
		expect(css).toContain(
			'--mantine-font-family: "nf-theme-aaaaaaaaaaaaaaaa-chrome-brand-sans", system-ui;',
		);
		expect(css).toContain(
			'--mantine-font-family-headings: "nf-theme-aaaaaaaaaaaaaaaa-chrome-brand-sans", sans-serif;',
		);
	});

	/**
	 * A concrete font name would both enlarge the attack surface (platform text
	 * engine parsing) and let a theme probe which fonts a user has installed, which
	 * is a fingerprinting vector. Only the generic keywords are expressible.
	 */
	test.each([
		"Comic Sans MS",
		'"Segoe UI", sans-serif',
		"serif; color: red",
		"url(evil.woff2)",
		"SimSun",
	])("drops the non-keyword font family %p", (family) => {
		const css = compileThemeTokens(
			// biome-ignore lint/suspicious/noExplicitAny: intentionally malformed
			{ fontFamily: family as any },
			pid,
			tid,
			"both",
		);
		expect(css).toBe("");
	});

	test("manifest rejects a font name and accepts a keyword", () => {
		const base = {
			schemaVersion: 1,
			pluginId: "com.example.chrome",
			version: "1.0.0",
			displayName: "Chrome",
			engine: { runtime: "bun", hostApi: ">=1.0 <2", rpc: "narrafork.rpc/1" },
			activationEvents: [],
			permissions: {
				host: ["ui.theme"],
				network: { mode: "none", allow: [] },
				filesystem: { package: "readOnly", pluginData: "none", workspace: "none" },
				process: { spawn: "none" },
			},
		};
		const withFamily = (fontFamily: string) => ({
			...base,
			contributes: {
				themes: [{ id: "c", title: "C", colorScheme: "both", tokens: { fontFamily } }],
			},
		});
		expect(safeParseManifest(withFamily("serif")).success).toBe(true);
		expect(safeParseManifest(withFamily("SimSun")).success).toBe(false);
	});

	test("derives an xs..xl shadow ladder from a clamped strength", () => {
		const css = compileThemeTokens({ shadow: 12 }, pid, tid, "both");
		for (const key of ["xs", "sm", "md", "lg", "xl"]) {
			expect(css).toContain(`--mantine-shadow-${key}:`);
		}
		// md is the 1.0 rung, so the blur equals the declared strength.
		expect(css).toContain("--mantine-shadow-md: 0 4.2px 12px rgba(0, 0, 0, 0.18);");
	});

	/**
	 * The host owns the shadow geometry and alpha. A theme supplying a raw
	 * `box-shadow` could paint far outside its element or fake host chrome.
	 */
	test.each([
		-1,
		49,
		8.5,
		"12px",
		"0 0 40px red",
	])("drops the out-of-policy shadow %p", (shadow) => {
		const css = compileThemeTokens(
			// biome-ignore lint/suspicious/noExplicitAny: out-of-policy on purpose
			{ shadow: shadow as any },
			pid,
			tid,
			"both",
		);
		expect(css).toBe("");
	});

	test("shadow alpha is host-fixed and never plugin-supplied", () => {
		const css = compileThemeTokens({ shadow: 20 }, pid, tid, "both");
		expect(css).toContain("rgba(0, 0, 0, 0.18)");
		expect(css).not.toContain("box-shadow:");
	});

	test("emits per-surface text colors with the Mantine variable", () => {
		const css = compileThemeTokens(
			{ textColors: { header: "#ffffff", navbar: "#eaf2ff" } },
			pid,
			tid,
			"both",
		);
		expect(css).toContain(
			`:root[data-plugin-theme="${pid}__${tid}"] .mantine-AppShell-header {\n\tcolor: #ffffff;\n\t--mantine-color-text: #ffffff;\n}`,
		);
		expect(css).toContain("color: #eaf2ff;");
	});

	test("drops a non-whitelisted text surface and an unsafe color", () => {
		expect(
			compileThemeTokens(
				// biome-ignore lint/suspicious/noExplicitAny: unknown surface on purpose
				{ textColors: { body: "#fff" } as any },
				pid,
				tid,
				"both",
			),
		).toBe("");
		expect(
			compileThemeTokens(
				// biome-ignore lint/suspicious/noExplicitAny: intentionally malformed
				{ textColors: { header: "url(evil)" as any } },
				pid,
				tid,
				"both",
			),
		).toBe("");
	});

	test("supports per-scheme fonts, shadows and text colors", () => {
		const css = compileThemeTokens(
			{
				light: { fontFamily: "serif", shadow: 8, textColors: { header: "#111111" } },
				dark: { fontFamily: "monospace", shadow: 16, textColors: { header: "#ffffff" } },
			},
			pid,
			tid,
			"both",
		);
		expect(css).toContain('[data-mantine-color-scheme="light"] {');
		expect(css).toContain("--mantine-font-family: serif;");
		expect(css).toContain("--mantine-font-family: monospace;");
		expect(css).toContain('[data-mantine-color-scheme="dark"] .mantine-AppShell-header {');
	});
});

describe("compileThemeTokens - borders and corners", () => {
	const pid = "com.example.chrome";
	const tid = "chrome";

	test("emits a real border with a clamped width", () => {
		const css = compileThemeTokens(
			{ borders: { button: { width: 1, style: "solid", color: "#7ba7d7" } } },
			pid,
			tid,
			"both",
		);
		expect(css).toContain("border: 1px solid #7ba7d7;");
	});

	test("restricts a border to declared edges in a fixed order", () => {
		const css = compileThemeTokens(
			{ borders: { header: { width: 2, color: "#1a4e85", edges: ["bottom", "top"] } } },
			pid,
			tid,
			"both",
		);
		expect(css).toContain("border-top: 2px solid #1a4e85;");
		expect(css).toContain("border-bottom: 2px solid #1a4e85;");
		// Output order is pinned, not input order.
		expect(css.indexOf("border-top:")).toBeLessThan(css.indexOf("border-bottom:"));
		expect(css).not.toContain("border-left:");
	});

	/**
	 * The layout-neutral escape hatch. A real border reflows (measured: a 1px
	 * border on a content-box element grows its outer width by 2px), so a theme
	 * that wants a stroke without touching layout sets `inset`, which emits an
	 * inset box-shadow ring instead.
	 */
	test("inset routes the stroke through an inset box-shadow, never a border", () => {
		const css = compileThemeTokens(
			{ borders: { code: { width: 1, color: "#a8c8e4", inset: true } } },
			pid,
			tid,
			"both",
		);
		expect(css).toContain("box-shadow: inset 0 0 0 1px #a8c8e4;");
		expect(css).not.toContain("border: 1px");
	});

	/**
	 * `box-shadow` can only draw a solid ring. Honoring `inset` for a patterned
	 * style would silently render a declared `dashed` as a solid line, so the
	 * compiler falls back to a real border rather than quietly lying about it. The
	 * author loses layout-neutrality, not the pattern they asked for.
	 */
	test.each([
		["solid", true],
		["double", true],
		["dashed", false],
		["dotted", false],
	])("inset with style %s uses an inset ring: %p", (style, expectInset) => {
		const css = compileThemeTokens(
			// biome-ignore lint/suspicious/noExplicitAny: style is a validated enum
			{ borders: { card: { width: 1, style: style as any, color: "#ffb3d1", inset: true } } },
			pid,
			tid,
			"both",
		);
		expect(css.includes("box-shadow: inset")).toBe(expectInset);
		// A patterned stroke must still appear, as a real border carrying the pattern.
		if (!expectInset) expect(css).toContain(`border: 1px ${style} #ffb3d1;`);
	});

	test("supports per-corner radii and the uniform shorthand", () => {
		const perCorner = compileThemeTokens(
			{ borders: { navLinkActive: { radiusTopLeft: 8, radiusTopRight: 8 } } },
			pid,
			tid,
			"both",
		);
		expect(perCorner).toContain("border-top-left-radius: 8px;");
		expect(perCorner).toContain("border-top-right-radius: 8px;");
		expect(perCorner).not.toContain("border-bottom-left-radius:");

		const uniform = compileThemeTokens({ borders: { card: { radius: 12 } } }, pid, tid, "both");
		expect(uniform).toContain("border-radius: 12px 12px 12px 12px;");
	});

	test("a per-corner value overrides the uniform radius", () => {
		const css = compileThemeTokens(
			{ borders: { card: { radius: 4, radiusTopLeft: 16 } } },
			pid,
			tid,
			"both",
		);
		expect(css).toContain("border-radius: 16px 4px 4px 4px;");
	});

	test("style none explicitly removes a host border", () => {
		const css = compileThemeTokens({ borders: { card: { style: "none" } } }, pid, tid, "both");
		expect(css).toContain("border: 0 solid transparent;");
	});

	test.each([
		["width", 9],
		["width", -1],
		["width", 1.5],
		["radius", 49],
		["radius", -2],
	])("drops the out-of-policy %s value %p", (field, value) => {
		const css = compileThemeTokens(
			// biome-ignore lint/suspicious/noExplicitAny: out-of-policy on purpose
			{ borders: { card: { [field]: value, color: "#000000" } as any } },
			pid,
			tid,
			"both",
		);
		// Nothing usable remains, so no rule is emitted for the surface.
		expect(css).toBe("");
	});

	test("drops an unsafe border color and a bogus style", () => {
		expect(
			compileThemeTokens(
				// biome-ignore lint/suspicious/noExplicitAny: intentionally malformed
				{ borders: { card: { width: 1, color: "red; content: url(evil)" as any } } },
				pid,
				tid,
				"both",
			),
		).toBe("");
		const bogusStyle = compileThemeTokens(
			// biome-ignore lint/suspicious/noExplicitAny: bogus enum on purpose
			{ borders: { card: { width: 1, color: "#000000", style: "url(evil)" as any } } },
			pid,
			tid,
			"both",
		);
		expect(bogusStyle).toContain("border: 1px solid #000000;");
		expect(bogusStyle).not.toContain("evil");
	});

	test("drops a non-whitelisted border surface", () => {
		expect(
			compileThemeTokens(
				// biome-ignore lint/suspicious/noExplicitAny: unknown surface on purpose
				{ borders: { sidebar: { width: 1, color: "#000000" } } as any },
				pid,
				tid,
				"both",
			),
		).toBe("");
	});

	test("manifest rejects malformed borders and accepts well-formed ones", () => {
		const base = {
			schemaVersion: 1,
			pluginId: "com.example.chrome",
			version: "1.0.0",
			displayName: "Chrome",
			engine: { runtime: "bun", hostApi: ">=1.0 <2", rpc: "narrafork.rpc/1" },
			activationEvents: [],
			permissions: {
				host: ["ui.theme"],
				network: { mode: "none", allow: [] },
				filesystem: { package: "readOnly", pluginData: "none", workspace: "none" },
				process: { spawn: "none" },
			},
		};
		const withBorders = (borders: unknown) => ({
			...base,
			contributes: {
				themes: [{ id: "c", title: "C", colorScheme: "both", tokens: { borders } }],
			},
		});
		expect(
			safeParseManifest(withBorders({ card: { width: 1, color: "#123456", radius: 8 } })).success,
		).toBe(true);
		// Raw CSS, out-of-range values and unknown fields are all rejected.
		expect(safeParseManifest(withBorders({ card: "1px solid red" })).success).toBe(false);
		expect(safeParseManifest(withBorders({ card: { width: 99 } })).success).toBe(false);
		expect(safeParseManifest(withBorders({ card: { radius: 200 } })).success).toBe(false);
		expect(safeParseManifest(withBorders({ card: { outline: "1px" } })).success).toBe(false);
		expect(safeParseManifest(withBorders({ card: { edges: ["diagonal"] } })).success).toBe(false);
		expect(safeParseManifest(withBorders({ unknownSurface: { width: 1 } })).success).toBe(false);
	});

	test("supports per-scheme borders", () => {
		const css = compileThemeTokens(
			{
				light: { borders: { card: { width: 1, color: "#cccccc" } } },
				dark: { borders: { card: { width: 1, color: "#333333" } } },
			},
			pid,
			tid,
			"both",
		);
		expect(css).toContain('[data-mantine-color-scheme="light"] .mantine-Card-root {');
		expect(css).toContain("#cccccc");
		expect(css).toContain('[data-mantine-color-scheme="dark"] .mantine-Card-root {');
		expect(css).toContain("#333333");
	});
});

describe("surface contract consistency", () => {
	/**
	 * Five token groups now share one surface vocabulary. They used to be five
	 * hand-written key lists that drifted — `input` was missing from the text-color
	 * list until a rendering bug surfaced it. The schemas are now derived from these
	 * arrays, and this test locks the compiler's selector table to them, so adding a
	 * surface cannot half-land.
	 */
	test("every declared surface has a selector in the compiler", () => {
		const declared = new Set<string>([
			...THEME_BACKGROUND_REGIONS,
			...THEME_GRADIENT_SURFACES,
			...THEME_TEXT_SURFACES,
			...THEME_BORDER_SURFACES,
			...THEME_FRAME_TARGETS,
		]);
		const missing = [...declared].filter((surface) => {
			// A surface is reachable if the compiler emits a rule for it.
			const css = compileThemeTokens(
				{ gradients: { [surface]: { from: "#ffffff", to: "#000000" } } },
				"com.example.probe",
				"probe",
				"both",
			);
			// `body` maps to the scope root (empty descendant selector), still valid.
			return css.length === 0;
		});
		expect(missing).toEqual([]);
	});

	test("frames cover every gradient surface except the page root", () => {
		expect([...THEME_FRAME_TARGETS].sort()).toEqual(
			[...THEME_GRADIENT_SURFACES].filter((s) => s !== "body").sort(),
		);
	});

	test("background regions are a subset of gradient surfaces", () => {
		const gradients = new Set<string>(THEME_GRADIENT_SURFACES);
		expect(THEME_BACKGROUND_REGIONS.filter((r) => !gradients.has(r))).toEqual([]);
	});
});

describe("compileThemeTokens - repaint-only guarantee", () => {
	const pid = "com.example.chrome";
	const tid = "chrome";
	const ctx = { version: "1.0.0", hash: "f".repeat(64) };

	/**
	 * Gradients, backgrounds, frames, per-surface text colors and shadows are
	 * *repaint-only*: none of them may emit a property that participates in layout,
	 * so applying them can never reflow the host. Verified in a real browser too
	 * (content boxes measured identical before/after applying a theme).
	 *
	 * `fontSize`/`fontFamily`/`spacing`/`radius` are deliberately excluded from this
	 * guarantee — changing text metrics and spacing is their entire purpose, exactly
	 * like the pre-existing `fontSize` token.
	 */
	test("the repaint-only token groups emit no layout-affecting property", () => {
		const css = compileThemeTokens(
			{
				gradients: {
					header: { from: "#ffffff", to: "#cccccc" },
					button: { from: "#ffffff", to: "#cccccc" },
					card: { from: "#ffffff", to: "#cccccc" },
				},
				backgrounds: { main: { image: "bg.png", overlay: "scrim-dark" } },
				frames: { card: { image: "f.png", slice: 16, width: 10 } },
				textColors: { header: "#ffffff", input: "#eeeeee" },
				shadow: 12,
				primaryColor: "#4a90d9",
				body: "#ffffff",
				text: "#111111",
			},
			pid,
			tid,
			"both",
			ctx,
		);
		expect(css.length).toBeGreaterThan(0);
		// `border-image-width` is the frame thickness and paints inside the existing
		// border box, so it is not a layout property despite the name.
		const layoutProperty =
			/(?:^|[\s{;])(width|height|padding|padding-[a-z]+|margin|margin-[a-z]+|inset|top|left|right|bottom|gap|flex|display|position|font-size|font-family|line-height|transform)\s*:/;
		const offenders = css
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => layoutProperty.test(line) && !line.startsWith("border-image-width"));
		expect(offenders).toEqual([]);
	});

	test("shadow and text colors never emit a raw box-shadow or font declaration", () => {
		const css = compileThemeTokens(
			{ shadow: 20, textColors: { card: "#ffffff" } },
			pid,
			tid,
			"both",
		);
		expect(css).not.toContain("box-shadow:");
		expect(css).not.toMatch(/(?:^|[\s{;])font\s*:/);
	});
});

describe("compileThemeTokens - nine-slice frames", () => {
	const pid = "com.example.framed";
	const tid = "framed";
	const ctx = { version: "1.0.0", hash: "b".repeat(64) };

	test("emits border-image with a same-origin url for a target", () => {
		const css = compileThemeTokens(
			{ frames: { button: { image: "assets/btn.png", slice: 12, repeat: "round" } } },
			pid,
			tid,
			"light",
			ctx,
		);
		expect(css).toContain(
			`:root[data-plugin-theme="${pid}__${tid}"][data-mantine-color-scheme="light"] .mantine-Button-root {`,
		);
		expect(css).toContain(
			`border-image-source: url("/api/plugins/ui/${pid}/1.0.0/${ctx.hash}/theme-asset/assets/btn.png")`,
		);
		expect(css).toContain("border-image-slice: 12;");
		expect(css).toContain("border-image-repeat: round;");
	});

	/**
	 * The layout guarantee of the whole feature: a frame must repaint without
	 * reserving layout space. Only `border-width: 0` may be emitted, and
	 * `border-image-outset` (clipped by any `overflow: hidden` ancestor) must never
	 * appear. If this ever regresses, themes could reflow the host.
	 */
	test("never emits a non-zero border-width or any outset", () => {
		const css = compileThemeTokens(
			{
				frames: {
					button: { image: "b.png", slice: 20, width: 24 },
					card: { image: "c.png", slice: 8 },
					modal: { image: "m.png", slice: 64, fill: true },
				},
			},
			pid,
			tid,
			"both",
			ctx,
		);
		expect(css).toContain("border-width: 0;");
		expect(css).not.toContain("border-image-outset");
		// The only border-width declaration anywhere is the zero one.
		expect(css.match(/border-width:\s*[^;]+;/g)).toEqual([
			"border-width: 0;",
			"border-width: 0;",
			"border-width: 0;",
		]);
		// Visual thickness travels through border-image-width instead.
		expect(css).toContain("border-image-width: 24px;");
	});

	test("width defaults to the slice size when omitted", () => {
		const css = compileThemeTokens(
			{ frames: { card: { image: "c.png", slice: 16 } } },
			pid,
			tid,
			"both",
			ctx,
		);
		expect(css).toContain("border-image-slice: 16;");
		expect(css).toContain("border-image-width: 16px;");
	});

	test("fill adds the keyword so the middle region paints the background", () => {
		const filled = compileThemeTokens(
			{ frames: { card: { image: "c.png", slice: 10, fill: true } } },
			pid,
			tid,
			"both",
			ctx,
		);
		expect(filled).toContain("border-image-slice: 10 fill;");
		const unfilled = compileThemeTokens(
			{ frames: { card: { image: "c.png", slice: 10 } } },
			pid,
			tid,
			"both",
			ctx,
		);
		expect(unfilled).toContain("border-image-slice: 10;");
		expect(unfilled).not.toContain("fill");
	});

	test("defaults repeat to stretch", () => {
		const css = compileThemeTokens(
			{ frames: { paper: { image: "p.png", slice: 6 } } },
			pid,
			tid,
			"both",
			ctx,
		);
		expect(css).toContain("border-image-repeat: stretch;");
	});

	test.each([
		["button", ".mantine-Button-root"],
		["actionIcon", ".mantine-ActionIcon-root"],
		["card", ".mantine-Card-root"],
		["paper", ".mantine-Paper-root"],
		["modal", ".mantine-Modal-content"],
		["navbar", ".mantine-AppShell-navbar"],
		["header", ".mantine-AppShell-header"],
		["input", ".mantine-Input-input"],
	])("maps the %s target to %s", (target, selector) => {
		const css = compileThemeTokens(
			{ frames: { [target]: { image: "f.png", slice: 8 } } },
			pid,
			tid,
			"both",
			ctx,
		);
		expect(css).toContain(`:root[data-plugin-theme="${pid}__${tid}"] ${selector} {`);
	});

	test("buttonHover targets the interactive state and excludes disabled", () => {
		const css = compileThemeTokens(
			{ frames: { buttonHover: { image: "h.png", slice: 8 } } },
			pid,
			tid,
			"both",
			ctx,
		);
		expect(css).toContain(".mantine-Button-root:hover:not(:disabled):not([data-disabled]) {");
	});

	test("emits button before buttonHover so hover wins on source order", () => {
		const css = compileThemeTokens(
			{
				frames: {
					buttonHover: { image: "h.png", slice: 8 },
					button: { image: "b.png", slice: 8 },
				},
			},
			pid,
			tid,
			"both",
			ctx,
		);
		expect(css.indexOf("theme-asset/b.png")).toBeLessThan(css.indexOf("theme-asset/h.png"));
	});

	test("emits paper before card so a card frame can override it", () => {
		const css = compileThemeTokens(
			{
				frames: {
					card: { image: "c.png", slice: 8 },
					paper: { image: "p.png", slice: 8 },
				},
			},
			pid,
			tid,
			"both",
			ctx,
		);
		expect(css.indexOf("theme-asset/p.png")).toBeLessThan(css.indexOf("theme-asset/c.png"));
	});

	test("supports different frames per light/dark variant", () => {
		const css = compileThemeTokens(
			{
				light: { frames: { button: { image: "day.png", slice: 8 } } },
				dark: { frames: { button: { image: "night.png", slice: 8 } } },
			},
			pid,
			tid,
			"both",
			ctx,
		);
		expect(css).toContain('[data-mantine-color-scheme="light"] .mantine-Button-root {');
		expect(css).toContain("theme-asset/day.png");
		expect(css).toContain('[data-mantine-color-scheme="dark"] .mantine-Button-root {');
		expect(css).toContain("theme-asset/night.png");
	});

	test("emits nothing without an asset context (frames need version/hash)", () => {
		const css = compileThemeTokens(
			{ frames: { button: { image: "b.png", slice: 8 } } },
			pid,
			tid,
			"both",
		);
		expect(css).toBe("");
	});
});

describe("compileThemeTokens - frame security / defense in depth", () => {
	const pid = "com.example.framed";
	const tid = "framed";
	const ctx = { version: "1.0.0", hash: "b".repeat(64) };

	test("drops a non-whitelisted target", () => {
		const css = compileThemeTokens(
			// biome-ignore lint/suspicious/noExplicitAny: unknown target on purpose
			{ frames: { sidebar: { image: "f.png", slice: 8 } } as any },
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
				{ frames: { button: { image: bad, slice: 8 } } },
				pid,
				tid,
				"both",
				ctx,
			);
			expect(css).toBe("");
		}
	});

	test.each([
		0,
		-4,
		65,
		1024,
		8.5,
		Number.NaN,
		Number.POSITIVE_INFINITY,
	])("drops an out-of-policy slice value %p", (slice) => {
		const css = compileThemeTokens(
			// biome-ignore lint/suspicious/noExplicitAny: out-of-policy on purpose
			{ frames: { button: { image: "b.png", slice: slice as any } } },
			pid,
			tid,
			"both",
			ctx,
		);
		expect(css).toBe("");
	});

	test("falls back to the slice size when width is out of policy", () => {
		const css = compileThemeTokens(
			// biome-ignore lint/suspicious/noExplicitAny: out-of-policy width on purpose
			{ frames: { button: { image: "b.png", slice: 10, width: 999 as any } } },
			pid,
			tid,
			"both",
			ctx,
		);
		expect(css).toContain("border-image-width: 10px;");
		expect(css).not.toContain("999");
	});

	test("drops a repeat value outside the enum", () => {
		const css = compileThemeTokens(
			// biome-ignore lint/suspicious/noExplicitAny: bogus enum on purpose
			{ frames: { button: { image: "b.png", slice: 8, repeat: "url(evil)" as any } } },
			pid,
			tid,
			"both",
			ctx,
		);
		// The bogus value never reaches CSS; the default is used instead.
		expect(css).toContain("border-image-repeat: stretch;");
		expect(css).not.toContain("evil");
	});

	test("a frame image cannot smuggle a quote out of the url()", () => {
		const css = compileThemeTokens(
			{ frames: { button: { image: 'b.png") ; color: red; a:url("x', slice: 8 } } },
			pid,
			tid,
			"both",
			ctx,
		);
		expect(css).toBe("");
	});

	/**
	 * The host serves declared frame images unauthenticated and same-origin with a
	 * Content-Type derived from the extension, exactly like backgrounds, so the
	 * manifest must reject any non-raster extension before install.
	 */
	describe("manifest validation", () => {
		function manifestWithFrame(frame: unknown) {
			return {
				schemaVersion: 1,
				pluginId: "com.example.framed",
				version: "1.0.0",
				displayName: "Framed",
				engine: { runtime: "bun", hostApi: ">=1.0 <2", rpc: "narrafork.rpc/1" },
				activationEvents: [],
				contributes: {
					themes: [
						{
							id: "framed",
							title: "Framed",
							colorScheme: "both",
							tokens: { frames: { button: frame } },
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
			"assets/frame.svg",
			"assets/data.json",
			"assets/theme.css",
			"assets/noextension",
		])("rejects the non-raster frame image %s", (image) => {
			const parsed = safeParseManifest(manifestWithFrame({ image, slice: 8 }));
			expect(parsed.success).toBe(false);
		});

		test("rejects a frame without a slice", () => {
			expect(safeParseManifest(manifestWithFrame({ image: "a.png" })).success).toBe(false);
		});

		test.each([0, 65, 8.5, "12"])("rejects the out-of-policy slice %p", (slice) => {
			expect(safeParseManifest(manifestWithFrame({ image: "a.png", slice })).success).toBe(false);
		});

		test("rejects border-image-outset as an unknown field", () => {
			const parsed = safeParseManifest(manifestWithFrame({ image: "a.png", slice: 8, outset: 12 }));
			expect(parsed.success).toBe(false);
		});

		test("accepts a well-formed frame and exposes its image for serving", () => {
			const parsed = safeParseManifest(
				manifestWithFrame({ image: "assets/btn.png", slice: 12, width: 8, repeat: "round" }),
			);
			expect(parsed.success).toBe(true);
			if (parsed.success) {
				expect(collectThemeImages(parsed.data.contributes.themes[0])).toEqual(["assets/btn.png"]);
			}
		});

		test("collects frame and background images together, across variants", () => {
			const parsed = safeParseManifest({
				schemaVersion: 1,
				pluginId: "com.example.framed",
				version: "1.0.0",
				displayName: "Framed",
				engine: { runtime: "bun", hostApi: ">=1.0 <2", rpc: "narrafork.rpc/1" },
				activationEvents: [],
				contributes: {
					themes: [
						{
							id: "framed",
							title: "Framed",
							colorScheme: "both",
							tokens: {
								backgrounds: { main: { image: "assets/bg.png" } },
								frames: { button: { image: "assets/btn.png", slice: 8 } },
								dark: { frames: { button: { image: "assets/btn-dark.png", slice: 8 } } },
							},
						},
					],
				},
				permissions: {
					host: ["ui.theme"],
					network: { mode: "none", allow: [] },
					filesystem: { package: "readOnly", pluginData: "none", workspace: "none" },
					process: { spawn: "none" },
				},
			});
			expect(parsed.success).toBe(true);
			if (parsed.success) {
				expect(collectThemeImages(parsed.data.contributes.themes[0]).sort()).toEqual([
					"assets/bg.png",
					"assets/btn-dark.png",
					"assets/btn.png",
				]);
			}
		});
	});

	test("a maximal frame + background theme still fits the size cap", () => {
		const frame = { image: "assets/frame.png", slice: 24, width: 24, fill: true } as const;
		const background = { image: "assets/bg.png", overlay: "scrim-dark", opacity: 0.6 } as const;
		const allFrames = {
			button: frame,
			buttonHover: frame,
			actionIcon: frame,
			card: frame,
			paper: frame,
			modal: frame,
			navbar: frame,
			header: frame,
			input: frame,
		};
		const allBackgrounds = {
			body: background,
			app: background,
			main: background,
			navbar: background,
			header: background,
			card: background,
			paper: background,
			modal: background,
			input: background,
		};
		const scheme = { frames: allFrames, backgrounds: allBackgrounds, primaryColor: "#3b7dd8" };
		const css = compileThemeTokens(
			{ ...scheme, light: scheme, dark: scheme },
			pid,
			tid,
			"both",
			ctx,
		);
		// Non-empty means it was not dropped for exceeding the cap.
		expect(css.length).toBeGreaterThan(0);
		expect(css.length).toBeLessThanOrEqual(MAX_COMPILED_THEME_CSS_LENGTH);
	});
});
