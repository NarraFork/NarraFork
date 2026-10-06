/**
 * Guards for the Fast Refresh boundary at the top of the app.
 *
 * THE FAILURE THIS PREVENTS
 * ------------------------
 * `@vitejs/plugin-react` turns any module that defines components into a Fast Refresh
 * boundary and injects `import.meta.hot.accept` there. The boundary is only VALID when
 * every export of that module is a component; otherwise the runtime calls
 * `hot.invalidate()`, Vite walks up to the next accepting importer, and for the ENTRY
 * module there is none — so it falls back to a full page reload.
 *
 * `main.tsx` can never be a valid boundary: it runs bootstrap side effects at module
 * scope. While the provider tree lived there it was a boundary anyway, and because it
 * statically imports the app's highest fan-in modules, editing almost anything reloaded
 * the whole page:
 *
 *     hmr invalidate /main.tsx  Could not Fast Refresh ("true" export is incompatible)
 *     page reload main.tsx
 *
 * WHY A SOURCE-TEXT TEST
 * ---------------------
 * The regression is invisible: adding one helper export to `App.tsx`, or moving a small
 * component back into `main.tsx`, leaves the app building, passing every other test, and
 * behaving correctly at runtime. The only symptom is that dev reloads get slower and lose
 * state — which reads as "Vite being Vite" rather than as a defect in this repo. Nothing
 * else in the test suite can observe it, so the invariant is asserted on the source.
 *
 * Reading source text as a guard for a cross-file invariant is the established pattern
 * here (see `pinch-zoom-guard.test.ts` and `tests/frontend/branding-boot.test.ts`).
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const FRONTEND_ROOT = join(import.meta.dir, "..");
const REPO_ROOT = join(FRONTEND_ROOT, "..");
const APP_TSX = readFileSync(join(FRONTEND_ROOT, "App.tsx"), "utf8");
const MAIN_TSX = readFileSync(join(FRONTEND_ROOT, "main.tsx"), "utf8");

/**
 * Names exported as runtime values, ignoring `export type` / `export interface`.
 *
 * Type-only exports are erased before the browser sees the module, so they cannot
 * affect the boundary and must not be flagged. `export default` is excluded too: it is
 * not part of this repo's style here and would need its own naming rule.
 */
function runtimeExportNames(source: string): string[] {
	const names: string[] = [];

	// `export function Foo`, `export const foo`, `export class Foo`, and the async form.
	const declarations =
		/^export\s+(?:async\s+)?(?:function|const|class|let|var)\s+([A-Za-z0-9_$]+)/gm;
	for (const match of source.matchAll(declarations)) names.push(match[1]);

	// `export { a, b as c }` — skipping any entry marked `type`, which is erased.
	const lists = /^export\s*\{([^}]*)\}/gm;
	for (const match of source.matchAll(lists)) {
		for (const raw of match[1].split(",")) {
			const entry = raw.trim();
			if (!entry || /^type\s/.test(entry)) continue;
			const exposed = entry
				.split(/\s+as\s+/)
				.pop()
				?.trim();
			if (exposed && exposed !== "default") names.push(exposed);
		}
	}

	return names;
}

/**
 * plugin-react's own heuristic, restated: it registers an export for Fast Refresh when
 * the VALUE looks like a component, and at build time the only signal available is the
 * capitalised name. So a lowercase export is what breaks the boundary.
 */
function isComponentName(name: string): boolean {
	return /^[A-Z]/.test(name);
}

describe("App.tsx is a valid Fast Refresh boundary", () => {
	it("exports at least one component, so it IS the boundary main.tsx used to be", () => {
		const exports = runtimeExportNames(APP_TSX);
		expect(exports).toContain("App");
	});

	it("exports nothing but components", () => {
		const offenders = runtimeExportNames(APP_TSX).filter((name) => !isComponentName(name));
		expect(
			offenders,
			"App.tsx must export components only. A non-component export invalidates the " +
				"Fast Refresh boundary, and because main.tsx (its only importer) cannot accept " +
				"updates, every propagated change becomes a FULL PAGE RELOAD. Move helpers, " +
				`hooks and constants into a separate module. Offending exports: ${offenders.join(", ")}`,
		).toEqual([]);
	});
});

describe("main.tsx stays a component-free entry", () => {
	it("defines no components, so it is never treated as a boundary", () => {
		// Capitalised function declarations are what plugin-react's transform looks for.
		// JSX in `bootstrap()` is fine — it renders a component, it does not define one.
		const declaredComponents = [...MAIN_TSX.matchAll(/^\s*function\s+([A-Z][A-Za-z0-9_$]*)/gm)].map(
			(match) => match[1],
		);
		expect(
			declaredComponents,
			"A component defined in the entry makes main.tsx a Fast Refresh boundary. It can " +
				"never be a VALID one (the module runs bootstrap side effects), and the entry has " +
				"no accepting importer above it, so every update ends in location.reload(). Put " +
				`the component in App.tsx instead. Found: ${declaredComponents.join(", ")}`,
		).toEqual([]);
	});

	it("renders the tree from App.tsx rather than inlining it", () => {
		expect(MAIN_TSX).toContain('from "./App"');
		expect(MAIN_TSX).toContain("<App history={history} />");
	});

	it("owns the history, so a Fast Refresh of App.tsx cannot detach the router", () => {
		// A history created inside App would be rebuilt on every refresh of that module,
		// resetting the URL bar's session entries and the back/forward stack.
		expect(MAIN_TSX).toContain("createBrowserHistory()");
		expect(APP_TSX).not.toContain("createBrowserHistory");
	});
});

/**
 * Resolve an import specifier the way the app's Vite aliases do, or `null` for a bare
 * package specifier (which has no HMR boundary of ours and is not walked).
 */
function resolveLocalSpecifier(specifier: string, importer: string): string | null {
	let base: string | null = null;
	if (specifier.startsWith("@frontend/")) {
		base = resolve(FRONTEND_ROOT, specifier.slice("@frontend/".length));
	} else if (specifier.startsWith("@shared/")) {
		base = resolve(REPO_ROOT, "shared", specifier.slice("@shared/".length));
	} else if (specifier.startsWith("@server/")) {
		base = resolve(REPO_ROOT, "server", specifier.slice("@server/".length));
	} else if (specifier.startsWith("./") || specifier.startsWith("../")) {
		base = resolve(dirname(importer), specifier);
	} else {
		return null;
	}

	for (const suffix of ["", ".ts", ".tsx", "/index.ts", "/index.tsx", ".css"]) {
		const candidate = base + suffix;
		if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
	}
	return null;
}

/**
 * Every local module statically reachable from `main.tsx`, EXCLUDING the `App.tsx`
 * subtree (which is a valid boundary and stops propagation) and CSS (handled by Vite's
 * own CSS HMR, which never reloads the page).
 *
 * Static imports only — a dynamic `import()` creates its own boundary, so it does not
 * put the target on the entry's propagation path.
 */
function modulesReachableFromEntry(): string[] {
	const appTsx = resolve(FRONTEND_ROOT, "App.tsx");
	const seen = new Set<string>();

	const walk = (file: string) => {
		if (seen.has(file)) return;
		seen.add(file);
		if (file.endsWith(".css")) return;

		let source: string;
		try {
			source = readFileSync(file, "utf8");
		} catch {
			return;
		}

		// `import x from "y"` / `export … from "y"` (barrels re-export, which counts), and
		// bare side-effect `import "y"`.
		const patterns = [
			/(?:^|\n)\s*(?:import|export)\b[^;\n]*?from\s+["']([^"']+)["']/g,
			/(?:^|\n)\s*import\s+["']([^"']+)["']/g,
		];
		for (const pattern of patterns) {
			for (const match of source.matchAll(pattern)) {
				const resolved = resolveLocalSpecifier(match[1], file);
				if (resolved && resolved !== appTsx) walk(resolved);
			}
		}
	};

	walk(resolve(FRONTEND_ROOT, "main.tsx"));
	seen.delete(resolve(FRONTEND_ROOT, "main.tsx"));
	return [...seen]
		.filter((file) => !file.endsWith(".css"))
		.map((file) => relative(REPO_ROOT, file))
		.sort();
}

/**
 * Component modules `App.tsx` mounts DIRECTLY.
 *
 * These sit on the app shell's own propagation path: an invalid boundary in any of them
 * turns edits anywhere upstream into full page reloads. Each one listed here had exactly
 * that defect (`useConfirmDialog`, `useImageViewer`, `usePluginUiRuntime` …), and each is
 * now paired with a `*-context.ts` sibling holding the non-component exports.
 *
 * Paths are relative to `frontend/`.
 */
const APP_SHELL_COMPONENT_MODULES = [
	"components/AppNotifications.tsx",
	"components/common/ConfirmDialogProvider.tsx",
	"components/common/ImageViewerProvider.tsx",
	"components/common/RouteChunkErrorBoundary.tsx",
	"components/plugins/PluginThemeInjector.tsx",
	"components/plugins/PluginUiRuntimeProvider.tsx",
] as const;

describe("app-shell component modules are valid Fast Refresh boundaries", () => {
	it("is checking modules that App.tsx actually mounts", () => {
		// Without this, renaming or removing a provider would leave the list below silently
		// asserting over files the shell no longer uses.
		//
		// Matched by RENDERED COMPONENT NAME, not import path: several of these arrive through
		// the `components/plugins` barrel, so App.tsx never names their file. The component
		// name is also the thing that must still be mounted for the boundary to matter.
		for (const modulePath of APP_SHELL_COMPONENT_MODULES) {
			const source = readFileSync(join(FRONTEND_ROOT, modulePath), "utf8");
			const components = runtimeExportNames(source).filter(isComponentName);
			expect(components.length, `${modulePath} exports no component`).toBeGreaterThan(0);
			// Two usage forms count. Most are rendered as JSX, but the route error/pending
			// components are handed to `createRouter` as plain option values
			// (`defaultErrorComponent: RouteChunkErrorBoundary`) — still mounted by the shell,
			// just not through a tag.
			const used = components.some(
				(name) => APP_TSX.includes(`<${name}`) || APP_TSX.includes(`: ${name},`),
			);
			expect(
				used,
				`App.tsx does not use any component from ${modulePath} (looked for ${components
					.map((name) => `<${name}`)
					.join(", ")}, or a router option referencing it). Either it moved, or this ` +
					"list is stale.",
			).toBe(true);
		}
	});

	for (const modulePath of APP_SHELL_COMPONENT_MODULES) {
		it(`${modulePath} exports only components`, () => {
			const source = readFileSync(join(FRONTEND_ROOT, modulePath), "utf8");
			const offenders = runtimeExportNames(source).filter((name) => !isComponentName(name));
			expect(
				offenders,
				`${modulePath} is mounted directly by App.tsx, so a non-component export here ` +
					"invalidates its Fast Refresh boundary and downgrades app-shell edits to FULL " +
					"PAGE RELOADS. Move hooks, helpers and constants to a sibling module (see " +
					`image-viewer-context.ts for the pattern). Offending exports: ${offenders.join(", ")}`,
			).toEqual([]);
		});
	}
});

/** The raw specifiers `main.tsx` imports, so assertions cannot match its own comments. */
function entrySpecifiers(): string[] {
	const patterns = [
		/(?:^|\n)\s*import\b[^;\n]*?from\s+["']([^"']+)["']/g,
		/(?:^|\n)\s*import\s+["']([^"']+)["']/g,
	];
	const specifiers: string[] = [];
	for (const pattern of patterns) {
		for (const match of MAIN_TSX.matchAll(pattern)) specifiers.push(match[1]);
	}
	return specifiers;
}

describe("the entry's import graph stays small", () => {
	/**
	 * A budget, not an exact list, because the modules themselves are allowed to change.
	 *
	 * What must NOT change quietly is the SIZE. `main.tsx` cannot accept an HMR update
	 * (module-scope bootstrap side effects) and, being the entry, has no importer above it
	 * to accept one instead — so every module here is one whose edit ends in a full page
	 * reload. Measured before the split: 73. After routing the two offenders
	 * (`hooks/usePluginThemes` → `lib/plugin-theme-pref-store`, and the
	 * `components/plugins` barrel → `components/plugins/registry`): 17.
	 *
	 * The headroom is deliberately small. A convenience import of a barrel or a hook
	 * module adds dozens at once, and nothing about that is visible at runtime.
	 */
	const BUDGET = 25;

	it(`keeps at most ${BUDGET} local modules on the reload path`, () => {
		const reachable = modulesReachableFromEntry();
		expect(
			reachable.length,
			"Editing ANY of these reloads the whole page instead of hot-updating, because " +
				"main.tsx cannot accept HMR and nothing imports it. Something new was added to " +
				"the entry's static graph — most likely a barrel (`components/plugins`) or a " +
				"React Query hook module. Import the specific module instead, and if the " +
				`dependency is genuinely required, raise BUDGET deliberately.\n\n${reachable.join("\n")}`,
		).toBeLessThanOrEqual(BUDGET);
	});

	it("does not reach React Query, whose hook modules pull in the whole api barrel", () => {
		// The regression that motivated the split: `readActivePluginThemeKey` was imported
		// from `hooks/usePluginThemes`, which needs React Query, which reaches `lib/api/*`.
		// One localStorage read at bootstrap put 53 extra modules on the reload path.
		const reachable = modulesReachableFromEntry();
		const apiModules = reachable.filter((file) => file.startsWith("frontend/lib/api/"));
		// `lib/api/client` is expected: `registry.ts` needs the token and fetch wrapper.
		expect(apiModules).toEqual(["frontend/lib/api/client.ts"]);
	});

	it("imports the theme preference from the store, not through the hook module", () => {
		// Asserted on the import SPECIFIERS, not the raw text: the file explains this very
		// split in a comment, so a substring search over the whole source matches the prose
		// and fails on correct code.
		expect(entrySpecifiers()).toContain("@frontend/lib/plugin-theme-pref-store");
		expect(entrySpecifiers()).not.toContain("@frontend/hooks/usePluginThemes");
	});

	it("imports plugin registry functions deeply, not through the barrel", () => {
		// `@frontend/components/plugins` with no trailing path IS the barrel.
		expect(entrySpecifiers()).not.toContain("@frontend/components/plugins");
	});

	/**
	 * The residual set, recorded rather than fixed.
	 *
	 * These modules are needed BEFORE React mounts — the token store for the editor-host
	 * session handoff, i18n so the first paint is localized — so they cannot be moved off
	 * the entry without changing bootstrap semantics. Editing them still costs a full page
	 * reload, and that is a deliberate, bounded exception rather than an oversight.
	 *
	 * The list is asserted so nobody has to rediscover which edits reload the page, and so
	 * that a future change which DOES manage to remove one of them fails here and gets the
	 * comment updated.
	 */
	it("documents the modules that still cost a reload", () => {
		const reachable = new Set(modulesReachableFromEntry());
		for (const modulePath of [
			// Session/token handoff (`installHostBridge`) and the plugin contribution sync.
			"frontend/lib/api/client.ts",
			// `initI18n` is awaited before `createRoot`.
			"frontend/lib/i18n.ts",
		]) {
			expect(reachable.has(modulePath), `${modulePath} left the entry graph — good news`).toBe(
				true,
			);
		}
	});
});
