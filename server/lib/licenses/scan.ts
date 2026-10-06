/**
 * scan.ts — Build the license manifest by walking the real dependency graph.
 *
 * The previous implementation listed `Object.keys({...dependencies, ...devDependencies})`
 * — 97 packages. The released binary actually contains 864: every transitive
 * dependency is compiled in by `bun build --compile`, and MIT/BSD/Apache all
 * require their copyright notice to travel with the distribution. So the walk here
 * is recursive, and the runtime/development split is computed from reachability
 * rather than from which `package.json` field a name appeared in.
 *
 * Measured on this repo: ~70 ms for the whole graph (43 ms of `package.json`
 * reads, 14 ms of `readdir`, 12 ms to read 1.66 MB of license text). Cheap enough
 * to do once per process and cache — see `manifest.ts`.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getLicenseOverride, resolveSelectedLicense } from "./dual-license";
import { deriveCopyrightHolder, renderSpdxTemplate } from "./spdx-templates";
import {
	LICENSE_TEXT_ID_LENGTH,
	type LicenseEntry,
	type LicenseEntryKind,
	type LicenseManifest,
	type LicenseProblem,
	MAX_LICENSE_TEXT_BYTES,
} from "./types";

/**
 * Matches license/copying files in any case, with any extension or suffix.
 *
 * Replaces a fixed list of ten candidate names, which missed 23 packages —
 * `LICENSE-MIT.txt`, `License.md`, `COPYING`, and other variants. A missed file
 * is invisible: the entry still renders, just with no text to show.
 */
const LICENSE_FILE_RE = /^(licen[cs]e|copying)([._-].*)?$/i;

/**
 * Matches NOTICE files. Tracked separately because Apache-2.0 §4(d) requires
 * redistributing NOTICE contents *in addition to* the license, so folding it into
 * the license text would lose the distinction.
 */
const NOTICE_FILE_RE = /^notice([._-].*)?$/i;

/** Directory entries that are never packages. */
const SKIPPED_NODE_MODULES_ENTRIES = new Set([".bin", ".cache", ".package-lock.json", ".vite"]);

interface RawPackageJson {
	name?: unknown;
	version?: unknown;
	license?: unknown;
	/** Deprecated pre-SPDX format, still used by e.g. `format`. */
	licenses?: unknown;
	author?: unknown;
	repository?: unknown;
	homepage?: unknown;
	dependencies?: unknown;
	optionalDependencies?: unknown;
	devDependencies?: unknown;
}

export interface ScanOptions {
	/** Repository root containing `package.json` and `node_modules`. */
	root: string;
	/** Entries to merge in (hand-declared native components). */
	extraEntries?: LicenseEntry[];
	/** Texts keyed by id, for the extra entries. */
	extraTexts?: Record<string, string>;
}

/** Stable content-addressed id, so identical texts collapse to a single copy. */
export function licenseTextId(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex").slice(0, LICENSE_TEXT_ID_LENGTH);
}

function readJsonFile(path: string): RawPackageJson | null {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as RawPackageJson;
	} catch {
		return null;
	}
}

function depNames(value: unknown): string[] {
	if (!value || typeof value !== "object" || Array.isArray(value)) return [];
	return Object.keys(value as Record<string, unknown>);
}

/**
 * Normalize a `repository` field into a browsable https URL.
 *
 * Handles the object form, `git+`/`git://` prefixes, `.git` suffixes and the
 * `user/repo` shorthand. Used for links and, when a template is rendered, to
 * point the reader at upstream's actual license.
 */
export function normalizeRepositoryUrl(pkg: RawPackageJson): string {
	const raw = pkg.repository ?? pkg.homepage ?? "";
	const value =
		typeof raw === "string"
			? raw
			: typeof (raw as { url?: unknown }).url === "string"
				? ((raw as { url: string }).url satisfies string)
				: "";
	if (!value) return "";

	let url = value
		.replace(/^git\+/, "")
		.replace(/^git:\/\//, "https://")
		.replace(/^ssh:\/\/git@/, "https://")
		.replace(/\.git$/, "");
	if (url && !url.includes("://")) {
		// npm shorthand: "user/repo", "github:user/repo", "gitlab:user/repo".
		const shorthand = url.match(/^(?:(github|gitlab|bitbucket):)?([\w.-]+\/[\w.-]+)$/);
		if (shorthand) {
			const host = shorthand[1] ?? "github";
			const domain =
				host === "github" ? "github.com" : host === "gitlab" ? "gitlab.com" : "bitbucket.org";
			url = `https://${domain}/${shorthand[2]}`;
		} else {
			return "";
		}
	}
	return url;
}

function readAuthor(pkg: RawPackageJson): string {
	const author = pkg.author;
	if (typeof author === "string") return author;
	if (author && typeof author === "object") {
		const name = (author as { name?: unknown }).name;
		if (typeof name === "string") return name;
	}
	return "";
}

/**
 * Read the declared license, including the deprecated `licenses` array form.
 *
 * Without the legacy branch, `format` (and anything else predating SPDX fields)
 * renders as UNKNOWN despite clearly declaring MIT.
 */
export function readDeclaredLicense(pkg: RawPackageJson, name: string): string {
	const license = pkg.license;
	if (typeof license === "string" && license.trim()) return license.trim();
	// Some very old packages use `license: { type, url }`.
	if (license && typeof license === "object" && !Array.isArray(license)) {
		const type = (license as { type?: unknown }).type;
		if (typeof type === "string" && type.trim()) return type.trim();
	}
	// Deprecated: `licenses: [{ type, url }]`.
	const legacy = pkg.licenses;
	if (Array.isArray(legacy)) {
		const types = legacy
			.map((item) =>
				item && typeof item === "object" ? (item as { type?: unknown }).type : undefined,
			)
			.filter((type): type is string => typeof type === "string" && type.trim().length > 0);
		if (types.length === 1) return types[0].trim();
		// Multiple entries in the legacy format mean the same thing as a disjunction.
		if (types.length > 1) return types.map((t) => t.trim()).join(" OR ");
	}
	if (legacy && typeof legacy === "object" && !Array.isArray(legacy)) {
		const type = (legacy as { type?: unknown }).type;
		if (typeof type === "string" && type.trim()) return type.trim();
	}

	return getLicenseOverride(name) ?? "";
}

interface CollectedText {
	text: string;
	notice?: string;
}

/**
 * Read a package's license text(s) and NOTICE, if any.
 *
 * Multiple license files (`LICENSE-MIT` alongside `LICENSE-APACHE`) are all
 * collected and concatenated with a separator: a dual-licensed package that ships
 * both texts is telling us both apply to the offer, and showing only the
 * alphabetically-first one would misrepresent it.
 */
function collectPackageTexts(
	dir: string,
	name: string,
	problems: LicenseProblem[],
): CollectedText | null {
	let files: string[];
	try {
		files = readdirSync(dir);
	} catch {
		return null;
	}

	const licenseFiles = files.filter((file) => LICENSE_FILE_RE.test(file)).sort();
	const noticeFile = files.find((file) => NOTICE_FILE_RE.test(file));

	const parts: string[] = [];
	for (const file of licenseFiles) {
		const path = join(dir, file);
		try {
			// Skip directories named e.g. `licenses/` — readFileSync on those throws,
			// but checking is cheaper than relying on the catch and hides real errors less.
			if (!statSync(path).isFile()) continue;
			const size = statSync(path).size;
			if (size > MAX_LICENSE_TEXT_BYTES) {
				problems.push({
					severity: "warn",
					name,
					message: `License file ${file} is ${size} bytes, exceeding the ${MAX_LICENSE_TEXT_BYTES}-byte cap; skipped.`,
				});
				continue;
			}
			const text = readFileSync(path, "utf8").trim();
			if (text) parts.push(licenseFiles.length > 1 ? `===== ${file} =====\n\n${text}` : text);
		} catch {
			problems.push({
				severity: "warn",
				name,
				message: `Could not read license file ${file}.`,
			});
		}
	}

	let notice: string | undefined;
	if (noticeFile) {
		try {
			const path = join(dir, noticeFile);
			if (statSync(path).isFile() && statSync(path).size <= MAX_LICENSE_TEXT_BYTES) {
				const text = readFileSync(path, "utf8").trim();
				if (text) notice = text;
			}
		} catch {
			problems.push({ severity: "warn", name, message: `Could not read ${noticeFile}.` });
		}
	}

	if (!parts.length && !notice) return null;
	return { text: parts.join("\n\n"), notice };
}

/** One installed copy of a package: where it is, and what it calls itself. */
export interface PackageLocation {
	dir: string;
	name: string;
	version: string;
}

/**
 * Resolve `name` the way Node does from a package whose search path is `searchPaths`:
 * nearest `node_modules` first, then each ancestor's, ending at the root's.
 *
 * Resolving by name against the root `node_modules` alone — which is what this scanner
 * did — silently attributes the hoisted copy's license to a dependent that actually links
 * a nested one. In this repo that mislabels seven packages outright (`d3-sankey` links
 * `d3-array@2` under BSD-3-Clause while the hoisted `d3-array@3` is ISC) and reports the
 * wrong version for 130 more.
 */
function resolveDependencyDir(name: string, searchPaths: string[]): string | null {
	for (const base of searchPaths) {
		const candidate = join(base, name);
		if (existsSync(join(candidate, "package.json"))) return candidate;
	}
	return null;
}

/**
 * Every installed copy reachable from `startNames`, resolved per Node's algorithm.
 *
 * `optionalDependencies` are included: they are absent from this machine's
 * `node_modules` when they target another platform, but the release binary is
 * built for all platforms, so their licenses still apply to what we ship.
 * Unresolvable names are collected rather than dropped, so a platform-specific
 * package missing locally is visible instead of silently absent.
 *
 * Keyed by directory rather than by name, because a nested copy is a DIFFERENT
 * distributed artifact with its own version and possibly its own license — see
 * {@link resolveDependencyDir}.
 */
function reachable(
	rootNodeModules: string,
	startNames: string[],
	unresolved: Set<string>,
): PackageLocation[] {
	const found: PackageLocation[] = [];
	const visitedDirs = new Set<string>();
	const queue: Array<{ name: string; searchPaths: string[] }> = startNames.map((name) => ({
		name,
		searchPaths: [rootNodeModules],
	}));

	while (queue.length > 0) {
		const item = queue.pop();
		if (!item) continue;

		const dir = resolveDependencyDir(item.name, item.searchPaths);
		if (!dir) {
			unresolved.add(item.name);
			continue;
		}
		if (visitedDirs.has(dir)) continue;
		visitedDirs.add(dir);

		const pkg = readJsonFile(join(dir, "package.json"));
		if (!pkg) {
			// The directory exists but its manifest is unreadable. Record the location so the
			// caller reports it against a real path instead of dropping the package.
			found.push({ dir, name: item.name, version: "" });
			continue;
		}
		found.push({
			dir,
			name: item.name,
			version: typeof pkg.version === "string" ? pkg.version : "",
		});

		// A package's own `node_modules` shadows everything above it.
		const childSearchPaths = [join(dir, "node_modules"), ...item.searchPaths];
		for (const child of [...depNames(pkg.dependencies), ...depNames(pkg.optionalDependencies)]) {
			queue.push({ name: child, searchPaths: childSearchPaths });
		}
	}

	return found;
}

/** Depth limit for the nested-`node_modules` walk; deeper nesting than this is pathological. */
const MAX_NESTED_NODE_MODULES_DEPTH = 8;

/**
 * Every copy physically present under `nodeModules`, nested ones included.
 *
 * Two reasons this walks rather than reading one directory level:
 *  - a package installed but unreachable from the root manifest (a stale install, a peer
 *    the package manager pulled in) is still attributed rather than omitted;
 *  - a nested copy is a separate distributed artifact, so listing only the hoisted one
 *    would leave the nested version's license unstated.
 */
function listInstalledPackages(nodeModules: string, depth = 0): PackageLocation[] {
	const found: PackageLocation[] = [];
	if (depth > MAX_NESTED_NODE_MODULES_DEPTH) return found;
	let entries: string[];
	try {
		entries = readdirSync(nodeModules);
	} catch {
		return found;
	}

	const visit = (name: string, dir: string) => {
		const pkg = readJsonFile(join(dir, "package.json"));
		// A directory with no readable manifest is not a package (or is broken); either way
		// the caller reports it via the reachability path, not from here.
		if (pkg) {
			found.push({ dir, name, version: typeof pkg.version === "string" ? pkg.version : "" });
		}
		const nested = join(dir, "node_modules");
		if (existsSync(nested)) found.push(...listInstalledPackages(nested, depth + 1));
	};

	for (const entry of entries) {
		if (SKIPPED_NODE_MODULES_ENTRIES.has(entry) || entry.startsWith(".")) continue;
		if (entry.startsWith("@")) {
			try {
				for (const scoped of readdirSync(join(nodeModules, entry))) {
					if (scoped.startsWith(".")) continue;
					visit(`${entry}/${scoped}`, join(nodeModules, entry, scoped));
				}
			} catch {
				// Unreadable scope directory; nothing to attribute.
			}
			continue;
		}
		visit(entry, join(nodeModules, entry));
	}
	return found;
}

/**
 * Identity of a distributed artifact: name plus version.
 *
 * Deliberately NOT the directory. The same name@version installed at three paths is one
 * artifact with one license, so collapsing them keeps the page from listing a package three
 * times; two different versions are two artifacts and stay separate even when one shadows
 * the other.
 */
function packageKey(name: string, version: string): string {
	return version ? `${name}@${version}` : name;
}

/**
 * Scan the repository and produce the manifest.
 *
 * Pure with respect to the filesystem it is pointed at, which is what makes the
 * tests able to drive it against a fixture tree.
 */
export function scanLicenseManifest(options: ScanOptions): LicenseManifest {
	const { root, extraEntries = [], extraTexts = {} } = options;
	const problems: LicenseProblem[] = [];
	const texts: Record<string, string> = { ...extraTexts };
	const nodeModules = join(root, "node_modules");

	const rootPkg = readJsonFile(join(root, "package.json"));
	if (!rootPkg) {
		problems.push({
			severity: "error",
			message: `No readable package.json at ${root}; the dependency graph cannot be determined.`,
		});
		return { entries: [...extraEntries], texts, problems, generatedAt: Date.now() };
	}

	const unresolvedRuntime = new Set<string>();
	const unresolvedDev = new Set<string>();
	const runtime = reachable(nodeModules, depNames(rootPkg.dependencies), unresolvedRuntime);
	const dev = reachable(nodeModules, depNames(rootPkg.devDependencies), unresolvedDev);

	// Keyed by name@version, so a nested copy with a different version is its own entry
	// while the same version installed at several paths collapses to one.
	const located = new Map<string, PackageLocation>();
	const kindByKey = new Map<string, LicenseEntryKind>();
	const remember = (location: PackageLocation, kind: LicenseEntryKind) => {
		const key = packageKey(location.name, location.version);
		if (!located.has(key)) located.set(key, location);
		// A package reachable from BOTH trees is runtime: it ships, and that is what decides
		// our obligations.
		if (kind === "runtime" || !kindByKey.has(key)) kindByKey.set(key, kind);
	};

	for (const location of dev) remember(location, "development");
	for (const location of runtime) remember(location, "runtime");

	// Installed-but-unreachable copies are attributed as development: they are present in
	// the tree but nothing in the graph pulls them into the binary. Being wrong in this
	// direction only over-reports, which is the safe side.
	for (const location of listInstalledPackages(nodeModules)) {
		remember(location, "development");
	}

	for (const name of [...unresolvedRuntime].sort()) {
		problems.push({
			severity: "warn",
			name,
			message:
				"Declared as a dependency but not installed locally (usually a platform-specific " +
				"optional package). Its license is not listed. Run the scan on a machine where it " +
				"installs, or declare it in licenses/extra/.",
		});
	}

	const entries: LicenseEntry[] = [...extraEntries];

	for (const key of [...located.keys()].sort()) {
		const location = located.get(key);
		if (!location) continue;
		const { name, dir } = location;
		const kind = kindByKey.get(key) ?? "development";
		const pkg = readJsonFile(join(dir, "package.json"));
		if (!pkg) {
			problems.push({
				severity: kind === "development" ? "warn" : "error",
				name,
				message: `Installed at ${dir} but its package.json could not be read; license unknown.`,
			});
			continue;
		}

		const declared = readDeclaredLicense(pkg, name);
		const author = readAuthor(pkg);
		const repository = normalizeRepositoryUrl(pkg);
		const version = typeof pkg.version === "string" ? pkg.version : "";

		const resolved = declared
			? resolveSelectedLicense(name, declared, problems, kind)
			: { license: "UNKNOWN" };

		if (!declared) {
			problems.push({
				severity: kind === "development" ? "warn" : "error",
				name,
				message:
					"No license declared in package.json (and no override in dual-license.ts). " +
					"Determine the license from the package and add an override, or remove the dependency.",
			});
		}

		const collected = collectPackageTexts(dir, name, problems);

		const entry: LicenseEntry = {
			name,
			version,
			license: resolved.license,
			author,
			repository,
			kind,
			textSource: "missing",
		};
		if (resolved.declaredLicense) entry.declaredLicense = resolved.declaredLicense;
		if (resolved.selectionReason) entry.selectionReason = resolved.selectionReason;

		if (collected?.text) {
			const id = licenseTextId(collected.text);
			texts[id] = collected.text;
			entry.textId = id;
			entry.textSource = "package";
		} else {
			// Upstream shipped no license file. Render the standard text for the
			// declared identifier and mark it as a template so the page can say so.
			const rendered = renderSpdxTemplate(resolved.license, deriveCopyrightHolder(name, author));
			if (rendered) {
				const id = licenseTextId(rendered);
				texts[id] = rendered;
				entry.textId = id;
				entry.textSource = "spdx-template";
			} else {
				problems.push({
					severity: kind === "development" ? "warn" : "error",
					name,
					message:
						`Ships no license file and no SPDX template exists for "${resolved.license}". ` +
						"No license text can be shown; obtain the text from upstream and declare it.",
				});
			}
		}

		if (collected?.notice) {
			const id = licenseTextId(collected.notice);
			texts[id] = collected.notice;
			entry.noticeTextId = id;
		}

		entries.push(entry);
	}

	// `bundled` first (heaviest obligations, hand-maintained, easiest to forget),
	// then runtime, then development; alphabetical within each group.
	const kindOrder: Record<LicenseEntryKind, number> = { bundled: 0, runtime: 1, development: 2 };
	entries.sort((a, b) => {
		const byKind = kindOrder[a.kind] - kindOrder[b.kind];
		if (byKind !== 0) return byKind;
		const byName = a.name.localeCompare(b.name);
		if (byName !== 0) return byName;
		// Two versions of one package are two entries; keep them adjacent and in version order
		// so the page does not appear to list the same component twice at random. `numeric`
		// because a plain string compare puts 10.4.3 before 7.18.3.
		return a.version.localeCompare(b.version, undefined, { numeric: true });
	});

	// Drop texts nothing references, which can happen if an extra text table is
	// passed in with stale ids.
	const referenced = new Set<string>();
	for (const entry of entries) {
		if (entry.textId) referenced.add(entry.textId);
		if (entry.noticeTextId) referenced.add(entry.noticeTextId);
	}
	for (const id of Object.keys(texts)) {
		if (!referenced.has(id)) delete texts[id];
	}

	return { entries, texts, problems, generatedAt: Date.now() };
}

/** True when the manifest has a defect that must block a release build. */
export function hasBlockingProblem(manifest: LicenseManifest): boolean {
	return manifest.problems.some((problem) => problem.severity === "error");
}

/** Convenience for build scripts: `node_modules` present and non-empty. */
export function canScanFilesystem(root: string): boolean {
	return existsSync(join(root, "node_modules")) && existsSync(join(root, "package.json"));
}
