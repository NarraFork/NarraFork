/**
 * manifest.ts — Runtime access to the license manifest, in both shapes NarraFork runs in.
 *
 * Development runs from a checkout, so the manifest is scanned from `node_modules`
 * and `licenses/extra/` on first use. A compiled binary has neither, so the
 * manifest is embedded at build time by `scripts/build-cross-platform.ts` — the
 * same dual-mode arrangement `lib/changelog.ts` uses, for the same reason.
 *
 * Cached for the process lifetime: the manifest describes the shipped artifact, so
 * it cannot change under a running binary, and in development a re-scan would only
 * matter after an install (which restarts the server anyway). This keeps the ~120 ms
 * scan off every request without inviting a stale-cache class of bug.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { logger } from "@server/lib/logger";
import { licenseTextId, scanLicenseManifest } from "./scan";
import {
	type LicenseEntry,
	type LicenseEntryKind,
	type LicenseManifest,
	type LicenseProblem,
	type LicenseSummary,
	type LicenseTextSource,
	MAX_LICENSE_TEXT_BYTES,
} from "./types";

/** Repository root when running from a checkout. */
const REPO_ROOT = resolve(import.meta.dir, "../../..");
/** Hand-maintained declarations for components outside `node_modules`, under a given root. */
function extraDirFor(root: string): string {
	return join(root, "licenses", "extra");
}
/** Hand-maintained declarations for this checkout. */
const EXTRA_DIR = extraDirFor(REPO_ROOT);

export type LicenseManifestSource = "filesystem" | "embedded" | "unavailable";

export interface LicenseManifestResult {
	entries: LicenseSummary[];
	problems: LicenseProblem[];
	generatedAt: number;
	source: LicenseManifestSource;
}

let cached: { manifest: LicenseManifest; source: LicenseManifestSource } | null = null;

interface RawExtraEntry {
	name?: unknown;
	version?: unknown;
	license?: unknown;
	declaredLicense?: unknown;
	selectionReason?: unknown;
	author?: unknown;
	repository?: unknown;
	/** File under `licenses/extra/` holding the verbatim license text. */
	textFile?: unknown;
	/** File under `licenses/extra/` holding a NOTICE, when the component has one. */
	noticeFile?: unknown;
	/** What ships this component, shown to explain why it is listed. */
	distributedVia?: unknown;
	/**
	 * Key in {@link EXTRA_VERSION_SOURCES} whose live value this entry's `version` must
	 * match. Present only for components whose version is pinned elsewhere in the repo, so
	 * a moved pin surfaces as a problem rather than as a silently stale attribution.
	 */
	versionSource?: unknown;
	/** Free-form maintenance note; not rendered. */
	note?: unknown;
}

/**
 * Live version sources a hand-declared entry can be checked against.
 *
 * A `version` in `entries.json` is a copy of a number that lives somewhere else, and a copy
 * goes stale with no signal at all: the Bun entry read 1.3.13 while `bun.txt` reproduced the
 * LICENSE.md of 1.3.14. Those are different lists of statically linked libraries, so the
 * page attributed one build's dependencies to another's — and nothing anywhere said so.
 */
const EXTRA_VERSION_SOURCES: Readonly<Record<string, ExtraVersionSource>> = {
	/**
	 * The Bun that is running. This is the authority for what a released binary contains:
	 * `bun build --compile` embeds the runtime of the bun executing it, so the
	 * `packageManager` pin is only a hint about what a developer *should* have installed —
	 * checking against it would pass while shipping a different runtime.
	 */
	"bun-runtime": {
		describe: "the running Bun runtime (what `bun build --compile` embeds)",
		read: () => (typeof Bun === "undefined" ? null : Bun.version),
	},
};

interface ExtraVersionSource {
	describe: string;
	read: (root: string) => string | null;
}

/**
 * How badly a version mismatch misstates the attribution.
 *
 * A minor/major difference changes which libraries are statically linked (and under which
 * licenses), so the reproduced license text describes a build we do not ship — that blocks a
 * release. A patch difference almost never moves that list, and blocking every release on a
 * patch bump nobody controls would train people to ignore the check.
 */
function versionMismatchSeverity(declared: string, actual: string): "error" | "warn" {
	const series = (value: string) => value.split(".").slice(0, 2).join(".");
	return series(declared) === series(actual) ? "warn" : "error";
}

/**
 * Whether `candidate` really lives under `dir`.
 *
 * Compares path *segments*, not the resolved string prefix. A `startsWith` check
 * passes for a sibling whose name merely extends the directory's:
 * `textFile: "../extra-evil.txt"` resolves to `<root>/licenses/extra-evil.txt`,
 * which begins with `<root>/licenses/extra` — so the escape the check exists to
 * stop reads as contained.
 */
function isInsideDir(dir: string, candidate: string): boolean {
	const rel = relative(resolve(dir), resolve(candidate));
	// `rel === ".."` / `"../…"` is the escape; a *file* whose name merely starts with
	// dots (`..weird.txt`) is inside, so the segment boundary is checked rather than
	// the two characters.
	return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function asString(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

/**
 * Load `licenses/extra/entries.json` plus the text files it references.
 *
 * These cover everything that is distributed but unreachable from `node_modules`:
 * the static `zstd` binaries, musl, the Bun runtime compiled into every artifact,
 * the Go executor and its modules, and the `@parcel/watcher` native `.node` files
 * that `scripts/download-parcel-watcher.ts` pulls straight from the registry.
 *
 * A missing or malformed file is reported, never silently skipped: an unlisted
 * bundled component is exactly the gap this directory exists to close.
 */
function loadExtraEntries(root: string = REPO_ROOT): {
	entries: LicenseEntry[];
	texts: Record<string, string>;
	problems: LicenseProblem[];
} {
	const problems: LicenseProblem[] = [];
	const entries: LicenseEntry[] = [];
	const texts: Record<string, string> = {};
	// Resolved from the root under scan, not from this module's location: the build script
	// and the tests both point the scan at a specific tree, and reading declarations from
	// one tree while reading the dependency graph from another would silently mix them.
	const extraDir = extraDirFor(root);

	const indexPath = join(extraDir, "entries.json");
	if (!existsSync(indexPath)) {
		problems.push({
			severity: "warn",
			message:
				`No ${indexPath}; components distributed outside node_modules ` +
				"(zstd, the Bun runtime, the Go executor, native watcher binaries) are not attributed.",
		});
		return { entries, texts, problems };
	}

	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(indexPath, "utf8"));
	} catch (error) {
		problems.push({
			severity: "error",
			message: `licenses/extra/entries.json is not valid JSON: ${String(error)}`,
		});
		return { entries, texts, problems };
	}

	if (!Array.isArray(raw)) {
		problems.push({
			severity: "error",
			message: "licenses/extra/entries.json must be an array of entries.",
		});
		return { entries, texts, problems };
	}

	for (const item of raw as RawExtraEntry[]) {
		const name = asString(item?.name);
		if (!name) {
			problems.push({ severity: "error", message: "An extra entry has no name; skipped." });
			continue;
		}
		const license = asString(item.license);
		if (!license) {
			problems.push({ severity: "error", name, message: "Extra entry declares no license." });
			continue;
		}

		const version = asString(item.version);
		const entry: LicenseEntry = {
			name,
			version,
			license,
			author: asString(item.author),
			repository: asString(item.repository),
			kind: "bundled" satisfies LicenseEntryKind,
			textSource: "missing" satisfies LicenseTextSource,
		};
		const declaredLicense = asString(item.declaredLicense);
		if (declaredLicense) entry.declaredLicense = declaredLicense;
		const selectionReason = asString(item.selectionReason);
		if (selectionReason) entry.selectionReason = selectionReason;
		const distributedVia = asString(item.distributedVia);
		if (distributedVia) entry.distributedVia = distributedVia;

		// A declared version that is a copy of a pin elsewhere is checked against the pin.
		const versionSource = asString(item.versionSource);
		if (versionSource) {
			const source = EXTRA_VERSION_SOURCES[versionSource];
			if (!source) {
				problems.push({
					severity: "error",
					name,
					message:
						`Unknown versionSource "${versionSource}". Valid keys: ` +
						`${Object.keys(EXTRA_VERSION_SOURCES).join(", ")}.`,
				});
			} else {
				const pinned = source.read(root);
				if (pinned === null) {
					problems.push({
						severity: "warn",
						name,
						message: `Could not read ${source.describe} to verify the declared version.`,
					});
				} else if (pinned !== version) {
					problems.push({
						severity: versionMismatchSeverity(version, pinned),
						name,
						message:
							`Declares version "${version}" but ${source.describe} says "${pinned}". ` +
							"The attribution then describes a different build than the one we ship, whose " +
							"statically linked libraries (and their licenses) may differ. Update this entry " +
							"AND re-copy its license text file from the matching upstream tag.",
					});
				}
			}
		}

		const textFile = asString(item.textFile);
		if (textFile) {
			// Names come from a committed file, but resolve-and-verify anyway so a typo
			// (or an edited checkout) can never read outside the directory.
			const textPath = join(extraDir, textFile);
			if (!isInsideDir(extraDir, textPath)) {
				problems.push({
					severity: "error",
					name,
					message: `textFile "${textFile}" resolves outside licenses/extra/.`,
				});
			} else if (!existsSync(textPath)) {
				problems.push({
					severity: "error",
					name,
					message: `textFile "${textFile}" does not exist; no license text can be shown.`,
				});
			} else {
				try {
					const text = readFileSync(textPath, "utf8").trim();
					if (text.length > MAX_LICENSE_TEXT_BYTES) {
						problems.push({
							severity: "warn",
							name,
							message: `textFile "${textFile}" exceeds the size cap; skipped.`,
						});
					} else if (text) {
						const id = licenseTextId(text);
						texts[id] = text;
						entry.textId = id;
						entry.textSource = "package";
					}
				} catch (error) {
					problems.push({
						severity: "error",
						name,
						message: `Could not read textFile "${textFile}": ${String(error)}`,
					});
				}
			}
		} else {
			problems.push({
				severity: "error",
				name,
				message:
					"Extra entry has no textFile; a distributed component must carry its license text.",
			});
		}

		const noticeFile = asString(item.noticeFile);
		if (noticeFile) {
			const noticePath = join(extraDir, noticeFile);
			if (isInsideDir(extraDir, noticePath) && existsSync(noticePath)) {
				try {
					const notice = readFileSync(noticePath, "utf8").trim();
					if (notice && notice.length <= MAX_LICENSE_TEXT_BYTES) {
						const id = licenseTextId(notice);
						texts[id] = notice;
						entry.noticeTextId = id;
					}
				} catch {
					problems.push({
						severity: "warn",
						name,
						message: `Could not read noticeFile "${noticeFile}".`,
					});
				}
			} else {
				problems.push({
					severity: "warn",
					name,
					message: `noticeFile "${noticeFile}" is missing or outside licenses/extra/.`,
				});
			}
		}

		entries.push(entry);
	}

	return { entries, texts, problems };
}

/**
 * Scan from disk. Exported so the build script produces exactly what a checkout
 * would serve, rather than reimplementing the merge.
 */
export function buildLicenseManifestFromDisk(root: string = REPO_ROOT): LicenseManifest {
	const extra = loadExtraEntries(root);
	const manifest = scanLicenseManifest({
		root,
		extraEntries: extra.entries,
		extraTexts: extra.texts,
	});
	manifest.problems.unshift(...extra.problems);
	return manifest;
}

async function loadManifest(): Promise<{
	manifest: LicenseManifest;
	source: LicenseManifestSource;
}> {
	if (cached) return cached;

	// A checkout has node_modules; a compiled binary does not.
	if (existsSync(join(REPO_ROOT, "node_modules")) && existsSync(join(REPO_ROOT, "package.json"))) {
		const started = performance.now();
		const manifest = buildLicenseManifestFromDisk();
		const elapsed = Math.round(performance.now() - started);
		logger.debug("Scanned third-party license manifest from disk", {
			entries: manifest.entries.length,
			texts: Object.keys(manifest.texts).length,
			problems: manifest.problems.length,
			elapsedMs: elapsed,
		});
		cached = { manifest, source: "filesystem" };
		return cached;
	}

	try {
		const embedded = await import("@server/generated/embedded-licenses");
		cached = {
			manifest: {
				entries: [...embedded.embeddedLicenseEntries] as LicenseEntry[],
				texts: embedded.embeddedLicenseTexts,
				problems: [...embedded.embeddedLicenseProblems] as LicenseProblem[],
				generatedAt: embedded.embeddedLicenseGeneratedAt,
			},
			source: "embedded",
		};
		return cached;
	} catch (error) {
		// Neither source available. Report it instead of serving an empty page that
		// looks like "no third-party code".
		logger.error("No license manifest available (no node_modules and no embedded data)", {
			error: String(error),
		});
		cached = {
			manifest: {
				entries: [],
				texts: {},
				problems: [
					{
						severity: "error",
						message:
							"No license manifest is available in this build. This is a packaging defect: " +
							"scripts/build-cross-platform.ts should embed one.",
					},
				],
				generatedAt: Date.now(),
			},
			source: "unavailable",
		};
		return cached;
	}
}

/**
 * Summaries for every distributed component, without license texts.
 *
 * Texts are excluded deliberately: including them would make this a ~1.1 MB
 * response serialized on the main thread, which is exactly the pattern the
 * project's performance rules forbid for list endpoints.
 */
export async function getLicenseSummaries(): Promise<LicenseManifestResult> {
	const { manifest, source } = await loadManifest();
	return {
		entries: manifest.entries,
		problems: manifest.problems,
		generatedAt: manifest.generatedAt,
		source,
	};
}

/**
 * One license text by content id, or null when the id is unknown.
 *
 * Own-property lookup: `texts` is a plain object, so `texts["constructor"]` would
 * otherwise return `Object.prototype.constructor` and this function would hand a
 * *function* to a caller typed to receive a string. The route guards ids with
 * `isLicenseTextId` (hex-only) so the API cannot reach this, but the guarantee
 * belongs to the exported function rather than to one of its callers.
 */
export async function getLicenseText(id: string): Promise<string | null> {
	const { manifest } = await loadManifest();
	if (!Object.hasOwn(manifest.texts, id)) return null;
	const text = manifest.texts[id];
	return typeof text === "string" ? text : null;
}

/** Test seam: forget the cached manifest. */
export function resetLicenseManifestCache(): void {
	cached = null;
}

/**
 * Names of the text files under `licenses/extra/`, for the build script's
 * reporting. Kept here so the directory layout has one owner.
 */
export function listExtraTextFiles(): string[] {
	if (!existsSync(EXTRA_DIR)) return [];
	try {
		return readdirSync(EXTRA_DIR).filter((file) => file.endsWith(".txt"));
	} catch {
		return [];
	}
}
