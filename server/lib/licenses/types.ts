/**
 * types.ts — The shape of the third-party license manifest.
 *
 * One manifest describes every third-party component NarraFork ships, whether it
 * came from `node_modules` or from a hand-maintained entry under `licenses/extra/`
 * (native binaries, Go modules, the Bun runtime itself). The page at `/licenses`
 * renders exactly this, so anything missing here is missing from our attribution.
 *
 * License texts are stored OUT of line, keyed by content hash: 1052 of the 1184
 * packages ship a license file, but only 488 of those texts are distinct — the
 * same MIT boilerplate appears 85 times. Keeping texts in a side table means the
 * summary list (~135 KB) can be fetched by the page while the 874 KB of text is
 * pulled one entry at a time, and the compiled binary embeds each text once.
 */

/**
 * How a component reaches the user, which is what actually determines our
 * obligations — not whether it sits in `dependencies` or `devDependencies`.
 *
 * The old page split on `isDev`, which gave the false impression the distinction
 * had been made: `better-sqlite3` is a devDependency that never ships, while 785
 * transitive runtime packages that DO ship were absent entirely.
 */
export type LicenseEntryKind =
	/**
	 * Shipped inside the published artifacts but not resolvable from
	 * `node_modules` — static `zstd`, the Bun runtime, the Go executor and its
	 * modules, the `@parcel/watcher` native `.node` files that
	 * `scripts/download-parcel-watcher.ts` fetches straight from the registry.
	 * These carry the heaviest obligations and are the easiest to forget, so they
	 * are declared by hand and listed first.
	 */
	| "bundled"
	/** Reachable from `dependencies`; compiled into the released binary. */
	| "runtime"
	/** Only reachable from `devDependencies`; never distributed. */
	| "development";

/** Where an entry's license text came from, so the UI never implies more than it knows. */
export type LicenseTextSource =
	/** Verbatim from the package/component itself. */
	| "package"
	/**
	 * Rendered from an SPDX boilerplate because upstream shipped no license file.
	 * 38 packages are in this state (26 MIT, 6 Apache-2.0, …). The UI must say so
	 * and link upstream rather than passing the template off as upstream's wording.
	 */
	| "spdx-template"
	/** No text at all: neither a file nor a template for the declared identifier. */
	| "missing";

export interface LicenseEntry {
	/** Package name, or a stable slug like `zstd` for hand-declared components. */
	name: string;
	version: string;
	/**
	 * The license we are relying on. For dual-licensed components this is the
	 * single branch we selected, not upstream's disjunction.
	 */
	license: string;
	/**
	 * Upstream's raw declaration when it differs from `license` — i.e. the
	 * disjunction a selection was made from (`"MPL-2.0 OR Apache-2.0"`). Absent
	 * when there was nothing to choose. The UI surfaces it so the choice is
	 * auditable instead of looking like a misreading of upstream.
	 */
	declaredLicense?: string;
	author: string;
	repository: string;
	kind: LicenseEntryKind;
	/**
	 * Key into the text table. Absent only when `textSource` is `"missing"`.
	 * A 16-hex-character content hash, so identical texts collapse to one entry.
	 */
	textId?: string;
	textSource: LicenseTextSource;
	/**
	 * Present when the component ships a NOTICE file. Apache-2.0 §4(d) requires
	 * redistributing it alongside the license, so it is tracked separately rather
	 * than concatenated into the license text.
	 */
	noticeTextId?: string;
	/** Why a selection was made, for dual-licensed components. Auditable, not decorative. */
	selectionReason?: string;
	/**
	 * How a hand-declared component reaches the user ("static binaries at vendor/zstd,
	 * shipped for delta updates").
	 *
	 * Only set for `bundled` entries, where it is the answer to the obvious question: these
	 * components are invisible in `package.json`, so without it a reader cannot tell why
	 * `musl libc` is on the page or check whether the claim is still true.
	 */
	distributedVia?: string;
}

/** A defect found while building the manifest. Never silently swallowed. */
export interface LicenseProblem {
	/**
	 * `error` fails the release build: a distributed component whose license we
	 * cannot state is a compliance gap, and the previous silent `catch {}` meant a
	 * change in package layout could quietly shrink the page with no signal.
	 */
	severity: "error" | "warn";
	/** Component the problem concerns, when known. */
	name?: string;
	message: string;
}

export interface LicenseManifest {
	entries: LicenseEntry[];
	/** Content-hash → license text. Shared by `textId` and `noticeTextId`. */
	texts: Record<string, string>;
	problems: LicenseProblem[];
	/** Epoch ms the manifest was produced. */
	generatedAt: number;
}

/** The per-entry payload the summary API returns — deliberately without text. */
export type LicenseSummary = Omit<LicenseEntry, never>;

/** Hard cap on a single license text, enforced when reading and when serving. */
export const MAX_LICENSE_TEXT_BYTES = 1024 * 1024;

/** Length of the hex content hash used for `textId`. */
export const LICENSE_TEXT_ID_LENGTH = 16;

/** Validates a `textId` before it is used as a lookup key. */
export function isLicenseTextId(value: string): boolean {
	return new RegExp(`^[0-9a-f]{${LICENSE_TEXT_ID_LENGTH}}$`).test(value);
}
