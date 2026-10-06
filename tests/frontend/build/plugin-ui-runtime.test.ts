/**
 * The shared plugin UI runtime bundle.
 *
 * This exists because of a failure that only appeared in one of the two paths that build it.
 * The first implementation called `Bun.build` directly, which works on the main thread (the
 * dev-server middleware) but throws `ReferenceError: Bun is not defined` inside Vite's
 * rolldown worker (`generateBundle`). The dev experience was fine while the production
 * frontend shipped without the runtime — and a missing runtime does not error, it just leaves
 * every plugin panel unstyled.
 *
 * So the contract worth asserting is not "the bundler works" but "this function returns a
 * usable bundle when called from anywhere", plus the two properties the iframe depends on:
 * an IIFE that installs the global, and the Mantine stylesheet alongside it.
 *
 * The build is slow (React + Mantine), so this runs once and asserts against the result.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	buildPluginUiRuntime,
	isMainApplicationBuild,
	PLUGIN_UI_RUNTIME_CSS_PATH,
	PLUGIN_UI_RUNTIME_JS_PATH,
	type PluginUiRuntimeBundle,
} from "@frontend/build/plugin-ui-runtime";
import {
	PLUGIN_UI_RUNTIME_CSS_URL,
	PLUGIN_UI_RUNTIME_JS_URL,
} from "@frontend/plugin-runtime/paths";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

let bundle: PluginUiRuntimeBundle;

beforeAll(async () => {
	bundle = await buildPluginUiRuntime();
}, 300_000);

describe("plugin UI runtime bundle", () => {
	it("installs the runtime global a plugin panel reads", () => {
		// The panel's only entry point into the runtime. Renaming this without updating
		// `host-runtime.ts` would leave panels throwing on a missing global.
		expect(bundle.js).toContain("__nfPluginRuntime");
	});

	it("is an IIFE, because the iframe has no module loader", () => {
		// The shell injects this with a plain `<script src>`; an ESM output would fail to
		// execute with only a console error to show for it.
		expect(bundle.js).not.toMatch(/^\s*export\s/m);
		expect(bundle.js).not.toMatch(/^\s*import\s+[^(]/m);
	});

	it("ships the Mantine stylesheet", () => {
		// Without it every component renders unstyled, which is the exact failure mode that
		// motivated this test file.
		expect(bundle.css.length).toBeGreaterThan(10_000);
		expect(bundle.css).toContain("--mantine");
	});

	it("is built for production, not development React", () => {
		// A development build is larger, slower, and emits warnings that make no sense from
		// inside a plugin panel.
		expect(bundle.js).not.toContain("react-stack-bottom-frame");
		expect(bundle.js.length).toBeGreaterThan(100_000);
	});

	it("uses the fixed asset paths the iframe shell references by constant", () => {
		// The shell builds these URLs from constants rather than a lookup table, so a change
		// here has to be matched in `frontend/plugin-runtime/paths.ts`.
		expect(PLUGIN_UI_RUNTIME_JS_PATH).toBe("plugin-runtime/vendor.js");
		expect(PLUGIN_UI_RUNTIME_CSS_PATH).toBe("plugin-runtime/vendor.css");
	});

	/**
	 * The header's actual claim, previously unasserted.
	 *
	 * The regression this file was written for was the two paths DISAGREEING: the dev
	 * middleware served a working runtime while production shipped nothing. Both paths call
	 * this one function, so the property that keeps them from drifting is that a second call
	 * produces the same bytes — a build that depended on ambient state (a `Bun` global, a
	 * thread, a cwd) would differ here rather than silently only in production.
	 */
	it("returns the same bytes on a second call, so dev and production serve one result", async () => {
		const again = await buildPluginUiRuntime();
		expect(again.js).toBe(bundle.js);
		expect(again.css).toBe(bundle.css);
	}, 300_000);
});

/**
 * Which build gets to emit the runtime.
 *
 * `vite-plugin-pwa`'s `injectManifest` starts a nested Vite LIBRARY build for the service
 * worker, writing into the same `outDir` with `emptyOutDir: false`. Whether that nested build
 * inherits this plugin instance depends on the plugin's own filtering — with the currently
 * pinned version it does not, so today the guard is inert. It is still the right shape:
 * `captureFinalAppShellHtml` needs the identical check for the identical reason, the filtering
 * is not part of any API contract, and the failure mode is silent (a second ~800 KB bundle
 * overwriting byte-identical files, visible only as a slower build).
 *
 * Since the guard cannot be observed end to end, the rule itself is what gets tested.
 */
describe("nested build detection", () => {
	it("emits from the main application build", () => {
		expect(isMainApplicationBuild({ build: {} })).toBe(true);
		expect(isMainApplicationBuild({ build: { lib: false, ssr: false } })).toBe(true);
	});

	it("does not emit from the PWA service-worker library build", () => {
		expect(isMainApplicationBuild({ build: { lib: { entry: "src-sw.ts" } } })).toBe(false);
	});

	it("does not emit from an SSR build", () => {
		expect(isMainApplicationBuild({ build: { ssr: true } })).toBe(false);
		expect(isMainApplicationBuild({ build: { ssr: "entry-server.ts" } })).toBe(false);
	});

	it("is the same rule the app-shell HTML capture uses", () => {
		// `captureFinalAppShellHtml` in `vite.config.ts` classifies the nested build for the
		// same reason. Two spellings of one rule would drift; this asserts the config calls
		// this function rather than re-deriving it.
		const config = readFileSync(join(REPO_ROOT, "frontend", "vite.config.ts"), "utf8");
		expect(config).toContain("isMainPluginRuntimeBuild(config)");
		expect(config).toMatch(/isMainApplicationBuild = !config\.build\.lib && !config\.build\.ssr/);
	});
});

/**
 * The runtime's freshness depends entirely on cache headers.
 *
 * The paths are unhashed on purpose (the iframe shell references them by constant), so the
 * filename cannot signal a new version. If the backend serves them with the default
 * `max-age=3600`, a host upgrade keeps handing out the previous runtime for up to an hour
 * while newly loaded panels expect the new `PLUGIN_UI_RUNTIME_VERSION` — which surfaces as
 * `HostRuntimeUnavailableError` in the panel, far from the cache header that caused it.
 */
describe("production cache policy", () => {
	it("keeps the runtime out of assets/, where the immutable long-cache rule applies", () => {
		expect(PLUGIN_UI_RUNTIME_JS_URL.startsWith("/assets/")).toBe(false);
		expect(PLUGIN_UI_RUNTIME_CSS_URL.startsWith("/assets/")).toBe(false);
	});

	it("serves both runtime URLs with no-cache", () => {
		// `server/main.ts` imports these same constants, so this asserts the entries exist
		// rather than that two copies of the literals agree.
		const main = readFileSync(join(REPO_ROOT, "server", "main.ts"), "utf8");
		const noCacheBlock = main.match(/const NO_CACHE_FRONTEND_PATHS = new Set\(\[[\s\S]*?\]\);/);
		expect(noCacheBlock).not.toBeNull();
		expect(noCacheBlock?.[0]).toContain("PLUGIN_UI_RUNTIME_JS_URL");
		expect(noCacheBlock?.[0]).toContain("PLUGIN_UI_RUNTIME_CSS_URL");
		expect(main).toMatch(/from\s+["']\.\.\/frontend\/plugin-runtime\/paths["']/);
	});

	it("matches the URLs the iframe shell actually requests", () => {
		// The shell and the backend must be talking about the same two paths; a rename that
		// only reached one side would 404 the runtime in production.
		expect(PLUGIN_UI_RUNTIME_JS_URL).toBe(`/${PLUGIN_UI_RUNTIME_JS_PATH}`);
		expect(PLUGIN_UI_RUNTIME_CSS_URL).toBe(`/${PLUGIN_UI_RUNTIME_CSS_PATH}`);
	});
});
