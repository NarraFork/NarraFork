import type { ElectrobunConfig } from "electrobun";

/**
 * Electrobun desktop shell configuration.
 *
 * The shell is a thin launcher: `desktop/main.ts` starts the existing NarraFork server
 * in-process and points a window at it. No server logic is duplicated here.
 *
 * `mainProcess: "bun"` packages the real Bun runtime rather than Cottontail. NarraFork depends
 * on Bun-specific APIs throughout (`bun:sqlite`, `Bun.serve`, `Bun.spawn`, `bun-pty`), so
 * matching the runtime that `bun run start` already uses keeps desktop behaviour identical to
 * the server build instead of relying on a compatibility layer.
 *
 * Copy targets are chosen so the server's existing path resolution works unchanged:
 *   - the static file handler resolves `<import.meta.dir>/../dist/frontend`, and the bundled
 *     main process lives in `Resources/app/bun/`, so the frontend must land in
 *     `Resources/app/dist/frontend`.
 *   - migrations are looked up at the cwd-relative `./drizzle`, and `desktop/main.ts` sets the
 *     cwd to `Resources/app`, so they must land in `Resources/app/drizzle`.
 *
 * Native `.node` addons and the tree-sitter `.wasm` files are NOT copied here: they are declared
 * with `import ... with { type: "file" }`, which the bundler follows and emits next to the
 * bundled entrypoint. Their loaders resolve the returned specifier against `import.meta.dir`,
 * which is what makes the bundle-relative form work.
 *
 * `bundleCEF: false` uses the system webview (WebKitGTK on Linux, WebView2 on Windows). The
 * frontend is standard React with no CEF-specific requirements, and skipping CEF keeps the
 * package substantially smaller.
 */
export default {
	app: {
		name: "NarraFork",
		identifier: "sh.narrafork.desktop",
		// Keep in sync with package.json's version.
		version: "0.5.23",
	},
	build: {
		mainProcess: "bun",
		bun: {
			entrypoint: "desktop/main.ts",
		},
		copy: {
			"dist/frontend": "dist/frontend",
			drizzle: "drizzle",
			// bun-pty loads librust_pty through Bun FFI, an edge no bundler can follow. The
			// libraries are copied verbatim and located at runtime via BUN_PTY_LIB, which
			// desktop/main.ts points at this directory. Required for the Windows terminal
			// backend; unused on Linux/macOS, where Bun.Terminal is the default.
			"node_modules/bun-pty/rust-pty/target/release": "native/bun-pty",
		},
		watchIgnore: ["dist/**", "build/**", "artifacts/**"],
		mac: { bundleCEF: false },
		linux: { bundleCEF: false },
		win: { bundleCEF: false },
	},
} satisfies ElectrobunConfig;
