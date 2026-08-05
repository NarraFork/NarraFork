/**
 * legacy-builtins.guard.test.ts — Keeps post-ES2020 built-ins from silently
 * shipping to the Safari 14 target.
 *
 * WHY A STATIC GUARD
 * ------------------
 * `frontend/vite.config.ts` builds for `["es2020", "safari14"]`, and a build target
 * DOWN-LEVELS SYNTAX ONLY — it never injects runtime APIs. So `arr.at(-1)` compiles
 * to `arr.at(-1)`, type-checks clean, passes every test on Bun/Chrome, and throws
 * `TypeError` on the actual target. Nothing in the normal pipeline can see it: the
 * type-checker reads `tsconfig` (`target: ESNext`), and the test runner is Bun.
 *
 * The failure this prevents already shipped once. `Array.prototype.at` (ES2022,
 * Safari 15.4+) sat in `shared/pretext-layout/parse-markdown.ts`, which measures
 * every markdown body in the narrator virtual list. On Safari 14 the measure threw,
 * the throw escaped `usePretextDocument`'s effect through a synchronous
 * `coordinator.rebuild()`, the route's CatchBoundary remounted the subtree, the
 * effect re-ran, and it threw again — the list flickered forever showing no
 * messages at all. One method reference, and the whole renderer was unusable.
 *
 * HOW IT WORKS
 * ------------
 * Scan `frontend/` + `shared/` for the built-ins listed in `GUARDED_BUILTINS`. Each
 * is either POLYFILLED (shimmed in `legacy-browser-polyfills.ts`, so calling it is
 * fine) or FORBIDDEN (no shim — the call site must avoid it). A forbidden hit fails
 * the test with the reason and the suggested alternative.
 *
 * PLUS the `@server/` files those two trees actually pull in. `server/` is a Bun
 * process and its own code is irrelevant to Safari — but a `@server/` import from a
 * frontend component drags that module INTO the client bundle, target and all. So
 * instead of scanning `server/` wholesale (thousands of files that never ship, i.e.
 * noise that would get the guard disabled), the import graph is followed: the scan
 * surface equals the real bundle surface. Today that set is EMPTY — the only
 * `@server/` importers are test files, which never bundle — and the machinery exists
 * for the day someone lifts a helper out of `server/lib/agent/` into a component.
 *
 * Scope note: this covers OUR source. A dependency calling an unpolyfilled built-in
 * internally is invisible here — that is exactly how `Object.hasOwn` first arrived
 * (via @xyflow/react) and it is why the polyfill module shims some things no file
 * below calls directly.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";

const FRONTEND_ROOT = resolve(import.meta.dir, "..");
const REPO_ROOT = resolve(FRONTEND_ROOT, "..");
const SHARED_ROOT = join(REPO_ROOT, "shared");
const SERVER_ROOT = join(REPO_ROOT, "server");
const POLYFILL_MODULE = join(FRONTEND_ROOT, "lib", "legacy-browser-polyfills.ts");

const SCAN_EXTENSIONS = new Set([".ts", ".tsx"]);

/**
 * Directories skipped ANYWHERE in the tree, by name: third-party or build output,
 * none of which we author.
 */
const SKIP_DIR_NAMES: ReadonlySet<string> = new Set(["node_modules", "dist", "public", ".git"]);

/**
 * Directories skipped only at a SPECIFIC PATH, relative to a scan root.
 *
 * ⚠️ Matched by path, not by name, because a name-only skip is unbounded: `generated`
 * was meant to exempt `frontend/generated` (build output) but silently exempted every
 * directory called `generated` at any depth — including one holding hand-written code
 * that ships to the browser. `build` has the same hazard and it is not hypothetical:
 * `frontend/build/` is authored by us and `frontend/lib/shiki-language-aliases.ts`
 * imports from it, so those files DO reach the client bundle and must be scanned.
 */
const SKIP_DIR_PATHS: readonly string[] = ["generated"];

/** Whether to skip `entry` inside `dir`, given the root this walk started from. */
function shouldSkipDir(root: string, dir: string, entry: string): boolean {
	if (SKIP_DIR_NAMES.has(entry)) return true;
	const relativePath = relative(root, join(dir, entry)).split(sep).join("/");
	return SKIP_DIR_PATHS.includes(relativePath);
}

/**
 * Files exempt from the scan.
 *
 * `legacy-browser-polyfills.ts` necessarily NAMES every built-in it installs, and
 * this test file quotes them in its own fixtures. Both would otherwise flag
 * themselves. `routeTree.gen.ts` is generated.
 */
const EXEMPT_FILES: ReadonlySet<string> = new Set([
	POLYFILL_MODULE,
	resolve(import.meta.dir, "legacy-builtins.guard.test.ts"),
	join(FRONTEND_ROOT, "routeTree.gen.ts"),
]);

/**
 * How a post-ES2020 API is allowed to appear in our source.
 *
 *  - `shimmed`  — `legacy-browser-polyfills.ts` installs it; call sites are fine,
 *                 and the module is asserted to actually mention it.
 *  - `degrades` — absent on the target but harmless: the call still succeeds and
 *                 only loses a non-essential extra (e.g. `Error`'s `cause`, which
 *                 older engines drop because `Error` ignores surplus arguments).
 *                 Listed for discoverability, never shimmed.
 *  - `banned`   — no shim and not safe to degrade; the call site must change.
 */
type BuiltinDisposition = "shimmed" | "degrades" | "banned";

interface GuardedBuiltin {
	/** Human-readable API name used in failure output. */
	readonly name: string;
	/** First engine version that shipped it, for the failure message. */
	readonly availableFrom: string;
	/** Detects a call site in source text. */
	readonly pattern: RegExp;
	/** Whether call sites are allowed, and why. */
	readonly disposition: BuiltinDisposition;
	/** What to do instead, shown when a banned API is found. */
	readonly alternative?: string;
}

const GUARDED_BUILTINS: readonly GuardedBuiltin[] = [
	{
		name: "Array.prototype.at / String.prototype.at",
		availableFrom: "Safari 15.4",
		// `.at(` preceded by an identifier/bracket, i.e. a method call rather than a
		// property named `at` in an object literal.
		//
		// ⚠️ `?` is in the class for OPTIONAL CHAINING: in `foo?.at(-1)` the character
		// before `.at(` is `?`, so without it the call was invisible. Harmless for `at`
		// (it is shimmed), but this character class is the shape every entry below
		// copies — the same omission on a `banned` entry (`items?.toSorted()`) would
		// ship the very TypeError this file exists to catch.
		pattern: /[\w\])"'`?]\s*\.at\s*\(/g,
		disposition: "shimmed",
	},
	{
		name: "Array.prototype.findLast / findLastIndex",
		availableFrom: "Safari 15.4",
		pattern: /\.findLast(?:Index)?\s*\(/g,
		disposition: "shimmed",
	},
	{
		name: "Object.hasOwn",
		availableFrom: "Safari 15.4",
		pattern: /\bObject\s*\.\s*hasOwn\s*\(/g,
		disposition: "shimmed",
	},
	{
		name: "structuredClone",
		availableFrom: "Safari 15.4",
		pattern: /\bstructuredClone\s*\(/g,
		disposition: "shimmed",
	},
	{
		name: "Array.prototype.toSorted / toReversed / toSpliced / with",
		availableFrom: "Safari 16",
		pattern: /\.(?:toSorted|toReversed|toSpliced)\s*\(/g,
		disposition: "banned",
		alternative: "copy first, then mutate: `[...items].sort(…)` / `[...items].reverse()`",
	},
	{
		name: "Object.groupBy / Map.groupBy",
		availableFrom: "Safari 17.4",
		pattern: /\b(?:Object|Map)\s*\.\s*groupBy\s*\(/g,
		disposition: "banned",
		alternative: "build the grouping with an explicit `for` loop into a Map",
	},
	{
		name: "Array.prototype.group",
		availableFrom: "not standardized",
		pattern: /\.group\s*\(/g,
		disposition: "banned",
		alternative: "build the grouping with an explicit `for` loop into a Map",
	},
	{
		name: "AbortSignal.timeout",
		availableFrom: "Safari 16",
		pattern: /\bAbortSignal\s*\.\s*timeout\s*\(/g,
		disposition: "banned",
		alternative: "`const c = new AbortController(); setTimeout(() => c.abort(), ms)`",
	},
	{
		name: "Error cause option",
		availableFrom: "Safari 15",
		// `new Error("…", { cause })`. Verified harmless on older engines: `Error`
		// ignores surplus constructor arguments, so the call succeeds and only the
		// `cause` link is lost. Listed so the compatibility footprint stays
		// discoverable in one place.
		pattern: /new\s+\w*Error\s*\([^)]*\{\s*cause\s*[:}]/g,
		disposition: "degrades",
	},
];

/**
 * NOT DETECTED HERE, on purpose: the RegExp `d` (hasIndices) flag.
 *
 * Telling a regex literal's flags from an ordinary string needs real tokenization —
 * a pattern loose enough to catch `/x/d` also matches string literals like
 * `"/a/b/d.ts"`, which is precisely the false positive that made the first version
 * of this guard fail on an unrelated test fixture. The flag is rare enough that a
 * noisy check would cost more than it catches.
 */

/**
 * Recursively collect .ts/.tsx files, skipping the directories above.
 *
 * `root` is threaded through the recursion so `SKIP_DIR_PATHS` can be resolved
 * against the scan root rather than against the current directory.
 */
function collectSourceFiles(root: string, dir: string = root, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		const stats = statSync(full);
		if (stats.isDirectory()) {
			if (shouldSkipDir(root, dir, entry)) continue;
			collectSourceFiles(root, full, out);
			continue;
		}
		const dot = entry.lastIndexOf(".");
		if (dot >= 0 && SCAN_EXTENSIONS.has(entry.slice(dot))) out.push(full);
	}
	return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// `@server/` reachability — the bundle surface, not the server tree
// ─────────────────────────────────────────────────────────────────────────────

/** Static and dynamic `@server/...` specifiers, in that capture group. */
const SERVER_IMPORT_PATTERN = /(?:from\s*|import\s*\(\s*)["'](@server\/[^"']+)["']/g;

/** Extensions tried, in order, when a specifier carries none (Vite/tsc resolution). */
const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"] as const;

/**
 * Resolve a `@server/x/y` specifier to a real file, mirroring the `@server/*` →
 * `./server/*` alias. Extensionless specifiers try the extensions above and then an
 * `index.*` barrel — the two shapes the repo actually uses. Returns null when nothing
 * exists, which keeps a stale import from failing the guard for the wrong reason
 * (tsgo is the tool that reports an unresolvable import).
 */
function resolveServerSpecifier(specifier: string): string | null {
	const relativePath = specifier.slice("@server/".length);
	if (relativePath.length === 0 || relativePath.includes("\0")) return null;
	const base = join(SERVER_ROOT, relativePath);
	// Refuse anything that escapes server/ via `..` — a resolved path outside the
	// tree is not a server module and must not widen the scan.
	if (!base.startsWith(SERVER_ROOT + sep)) return null;
	const candidates = [
		base,
		...RESOLVE_EXTENSIONS.map((ext) => base + ext),
		...RESOLVE_EXTENSIONS.map((ext) => join(base, `index${ext}`)),
	];
	for (const candidate of candidates) {
		if (!existsSync(candidate)) continue;
		if (!statSync(candidate).isFile()) continue;
		const dot = basename(candidate).lastIndexOf(".");
		if (dot < 0 || !SCAN_EXTENSIONS.has(basename(candidate).slice(dot))) continue;
		return candidate;
	}
	return null;
}

/** A test file never reaches the browser bundle, whichever tree it lives in. */
function isTestFile(file: string): boolean {
	const name = basename(file);
	return name.includes(".test.") || name.includes(".spec.");
}

/**
 * `server/` files reachable from NON-TEST code in `frontend/` + `shared/`.
 *
 * Transitive on purpose: once a server module is in the bundle, everything IT imports
 * is too. Following only the first hop would leave the actual offender — a util two
 * levels down — invisible, which is the same "scanning an empty shell" mistake the
 * pretext guards had to fix. Only `@server/` specifiers are followed; a relative
 * import between two server files also stays inside `server/`, but resolving those
 * needs a real module resolver (extensions, directory barrels, `#` imports), so the
 * boundary here is: aliased hops are followed, relative hops are not. The set is
 * empty today, so this is a tripwire rather than a live scan.
 */
function collectBundledServerFiles(
	entryFiles: readonly string[] = [
		...collectSourceFiles(FRONTEND_ROOT),
		...collectSourceFiles(SHARED_ROOT),
	],
): string[] {
	const queue: string[] = [];
	const seen = new Set<string>();
	const enqueue = (source: string) => {
		const code = stripComments(source);
		const pattern = new RegExp(SERVER_IMPORT_PATTERN.source, SERVER_IMPORT_PATTERN.flags);
		let match: RegExpExecArray | null;
		// biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex exec loop
		while ((match = pattern.exec(code)) !== null) {
			const specifier = match[1];
			if (!specifier) continue;
			const resolved = resolveServerSpecifier(specifier);
			if (!resolved || seen.has(resolved)) continue;
			seen.add(resolved);
			queue.push(resolved);
		}
	};
	for (const file of entryFiles) {
		if (isTestFile(file)) continue;
		enqueue(readFileSync(file, "utf8"));
	}
	// Breadth-first over the reachable server modules. `queue` only grows through
	// `enqueue`, which dedupes via `seen`, so this terminates on cyclic imports.
	for (let i = 0; i < queue.length; i++) {
		const file = queue[i];
		if (!file) continue;
		enqueue(readFileSync(file, "utf8"));
	}
	return [...seen].sort();
}

/**
 * Strip line and block comments so prose mentioning an API is not flagged.
 *
 * These files document their own compatibility reasoning heavily (this very
 * repository comments on `.at(-1)` in several headers), so without this the guard
 * would be dominated by false positives from its own documentation.
 *
 * Replaces with spaces rather than deleting, keeping byte offsets stable so a
 * reported line number still matches the real file.
 */
function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
		.replace(/\/\/[^\n]*/g, (match) => " ".repeat(match.length));
}

interface Hit {
	readonly file: string;
	readonly line: number;
	readonly builtin: GuardedBuiltin;
	readonly snippet: string;
}

function scanFile(file: string, source: string): Hit[] {
	const code = stripComments(source);
	const hits: Hit[] = [];
	for (const builtin of GUARDED_BUILTINS) {
		const pattern = new RegExp(builtin.pattern.source, builtin.pattern.flags);
		let match: RegExpExecArray | null;
		// biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex exec loop
		while ((match = pattern.exec(code)) !== null) {
			const line = code.slice(0, match.index).split("\n").length;
			const snippet = source.split("\n")[line - 1]?.trim() ?? match[0];
			hits.push({ file, line, builtin, snippet });
		}
	}
	return hits;
}

function scanRoots(): Hit[] {
	const files = [
		...collectSourceFiles(FRONTEND_ROOT),
		...collectSourceFiles(SHARED_ROOT),
		// Server modules only get scanned when the client bundle actually contains them.
		...collectBundledServerFiles(),
	];
	const hits: Hit[] = [];
	for (const file of files) {
		if (EXEMPT_FILES.has(file)) continue;
		hits.push(...scanFile(file, readFileSync(file, "utf8")));
	}
	return hits;
}

function formatHits(hits: readonly Hit[]): string {
	return hits
		.map(
			(hit) =>
				`  ${relative(REPO_ROOT, hit.file)}:${hit.line}\n` +
				`    ${hit.builtin.name} (${hit.builtin.availableFrom})\n` +
				`    ${hit.snippet}` +
				(hit.builtin.alternative ? `\n    → use instead: ${hit.builtin.alternative}` : ""),
		)
		.join("\n");
}

describe("legacy built-ins guard (Safari 14 build target)", () => {
	it("uses no post-ES2020 built-in that lacks a polyfill", () => {
		const banned = scanRoots().filter((hit) => hit.builtin.disposition === "banned");

		if (banned.length > 0) {
			throw new Error(
				"Post-ES2020 built-ins found with no polyfill. Vite's `safari14` target down-levels " +
					"SYNTAX only, so these throw TypeError on the target instead of failing the build.\n" +
					"Either rewrite the call site, or add a shim to " +
					'frontend/lib/legacy-browser-polyfills.ts and set the entry to `disposition: "shimmed"` ' +
					"in this test's GUARDED_BUILTINS.\n\n" +
					`${formatHits(banned)}\n`,
			);
		}
		expect(banned).toHaveLength(0);
	});

	it("polyfill module is imported before anything else in main.tsx", () => {
		const main = readFileSync(join(FRONTEND_ROOT, "main.tsx"), "utf8");
		const importLines = main
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => /^import\b/.test(line));
		const first = importLines[0] ?? "";

		// Load order is load-bearing: a shim installed after another module's
		// top-level code has run is too late for that module.
		expect(first).toContain("legacy-browser-polyfills");
	});

	it("polyfill module installs every built-in marked as shimmed", () => {
		const source = readFileSync(POLYFILL_MODULE, "utf8");
		for (const builtin of GUARDED_BUILTINS) {
			if (builtin.disposition !== "shimmed") continue;
			// Each shim feature-detects the API it installs, so the module must at
			// least name it. Catches an entry marked "shimmed" with no shim behind it.
			const [primary] = builtin.name.split(" / ");
			const bareName = (primary ?? builtin.name).split(".").pop() ?? "";
			expect(source).toContain(bareName);
		}
	});

	it("skips build output by PATH, so a nested `generated` stays scanned", () => {
		// A name-only skip is unbounded: `generated` was meant to exempt the one build
		// directory at a scan root, but exempted every directory of that name at any
		// depth — hand-written code included. `frontend/build` was the same hazard with
		// a live case behind it (`frontend/lib/shiki-language-aliases.ts` imports from
		// `frontend/build/`, so those files ship to the browser).
		expect(shouldSkipDir(FRONTEND_ROOT, FRONTEND_ROOT, "generated")).toBe(true);
		expect(shouldSkipDir(FRONTEND_ROOT, join(FRONTEND_ROOT, "components"), "generated")).toBe(
			false,
		);
		expect(shouldSkipDir(FRONTEND_ROOT, FRONTEND_ROOT, "build")).toBe(false);

		// Third-party / output trees stay name-matched at any depth.
		expect(shouldSkipDir(FRONTEND_ROOT, join(FRONTEND_ROOT, "lib"), "node_modules")).toBe(true);
		expect(shouldSkipDir(FRONTEND_ROOT, join(FRONTEND_ROOT, "lib"), "dist")).toBe(true);

		// And the widened scan actually reaches the authored build helpers.
		const scanned = collectSourceFiles(FRONTEND_ROOT);
		expect(scanned).toContain(join(FRONTEND_ROOT, "build", "shiki-language-aliases.ts"));
	});

	it("scans the `@server/` modules the client bundle actually pulls in", () => {
		// The set is expected to be EMPTY: the only `@server/` importers in
		// frontend/+shared/ are test files, which never bundle. Asserting emptiness (not
		// just "no violations") is what makes a NEW production `@server/` import visible
		// — it would land here and then be scanned like any client file.
		const bundled = collectBundledServerFiles();
		expect(bundled.map((file) => relative(REPO_ROOT, file))).toEqual([]);

		// Test-file imports are excluded on purpose, and there are real ones today —
		// so an "everything is empty" pass could also mean the pattern never matches.
		// Prove the reachability walk sees them when tests are not filtered out.
		const testImporter = join(
			FRONTEND_ROOT,
			"components",
			"plugins-admin",
			"config-schema.test.ts",
		);
		expect(readFileSync(testImporter, "utf8")).toContain("@server/services/");
	});

	it("guard self-check: reachability is TRANSITIVE, so a helper two hops in is scanned", () => {
		// Driven from a real server file used as a synthetic entry point (the production
		// set is empty, so the walk needs a stand-in to prove it works at all).
		// `server/routes/usage-history.ts` imports `@server/services/credential-usage-totals`,
		// which in turn imports `@server/lib/id` — the second hop is the one a single-level
		// walk would miss, and it is exactly where a `toSorted()` would hide.
		const bundled = collectBundledServerFiles([join(SERVER_ROOT, "routes", "usage-history.ts")]);
		const relatives = bundled.map((file) => relative(REPO_ROOT, file));
		expect(relatives).toContain("server/services/credential-usage-totals.ts");
		expect(relatives).toContain("server/lib/id.ts");
	});

	it("guard self-check: `@server/` specifiers resolve to real files, and only inside server/", () => {
		// Extensionless + explicit + barrel, the three shapes the repo uses.
		expect(resolveServerSpecifier("@server/lib/id")).toBe(join(SERVER_ROOT, "lib", "id.ts"));
		expect(resolveServerSpecifier("@server/lib/agent")).toBe(
			join(SERVER_ROOT, "lib", "agent", "index.ts"),
		);
		expect(resolveServerSpecifier("@server/services/plugin-provider-registry.ts")).toBe(
			join(SERVER_ROOT, "services", "plugin-provider-registry.ts"),
		);

		// A directory with no barrel is not a module, and a traversal must not widen the
		// scan to files outside `server/`.
		expect(resolveServerSpecifier("@server/lib")).toBeNull();
		expect(resolveServerSpecifier("@server/../frontend/main")).toBeNull();
		expect(resolveServerSpecifier("@server/does-not-exist")).toBeNull();
	});

	it("guard self-check: flags a banned built-in and ignores comments", () => {
		const fake = join(FRONTEND_ROOT, "fake-source.ts");

		// A banned API in live code is caught.
		expect(scanFile(fake, "const sorted = items.toSorted();")).toHaveLength(1);
		expect(scanFile(fake, "const g = Object.groupBy(items, keyFn);")).toHaveLength(1);

		// The same API named in a comment is not.
		expect(scanFile(fake, "// avoid items.toSorted() here")).toHaveLength(0);
		expect(scanFile(fake, "/**\n * Do not call Object.groupBy().\n */")).toHaveLength(0);

		// A shimmed API is detected but classified as allowed.
		const atHits = scanFile(fake, "const last = items.at(-1);");
		expect(atHits).toHaveLength(1);
		expect(atHits[0]?.builtin.disposition).toBe("shimmed");

		// An OPTIONAL-CHAINED call is still a call. The character before `.at(` is `?`,
		// which the original character class omitted — so `foo?.at(-1)` matched nothing.
		// The `at` entry is shimmed so nothing broke, but every entry here shares this
		// pattern shape, and `items?.toSorted()` slipping through is a shipped TypeError.
		const optionalAt = scanFile(fake, "const last = items?.at(-1);");
		expect(optionalAt).toHaveLength(1);
		expect(optionalAt[0]?.builtin.disposition).toBe("shimmed");
		expect(scanFile(fake, "const sorted = items?.toSorted();")).toHaveLength(1);

		// A property literally named `at` is not a method call.
		expect(scanFile(fake, "const meta = { at: 1, by: 2 };")).toHaveLength(0);

		// `Error`'s cause option is recorded as a safe degradation, not a failure.
		const causeHits = scanFile(fake, 'throw new Error("x", { cause });');
		expect(causeHits).toHaveLength(1);
		expect(causeHits[0]?.builtin.disposition).toBe("degrades");
	});
});
