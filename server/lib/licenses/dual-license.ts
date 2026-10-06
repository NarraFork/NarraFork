/**
 * dual-license.ts — Which branch of a multi-licensed component we rely on, and
 * metadata overrides for packages whose `package.json` does not state a license.
 *
 * Both tables are maintained by hand, deliberately. A disjunction like
 * `"MPL-2.0 OR Apache-2.0"` is an offer: the redistributor picks a branch and
 * takes on that branch's obligations. No scanner can make that choice, and
 * rendering the raw disjunction on the page would leave the reader unable to tell
 * which obligations we actually accepted — including, for MPL, whether source
 * disclosure applies.
 *
 * Adding a dependency with a disjunctive license and NOT adding it here is
 * reported as a problem rather than silently displayed, so this file cannot
 * quietly fall behind `package.json`.
 */

import type { LicenseProblem } from "./types";

interface LicenseSelection {
	/** The branch we rely on. Must be one of the alternatives upstream offers. */
	selected: string;
	/** Why, in one line. Shown in the UI so the choice is auditable. */
	reason: string;
}

/**
 * Selections keyed by exact package name.
 *
 * Names are matched literally; a scoped family like `@biomejs/*` is listed per
 * package rather than by pattern, so a new member of the family surfaces as an
 * unresolved disjunction instead of inheriting a decision nobody reviewed.
 */
const SELECTIONS: Readonly<Record<string, LicenseSelection>> = {
	// Ships to the browser via mermaid. Apache-2.0 avoids MPL-2.0's file-level
	// source disclosure obligation, which would otherwise attach to a component we
	// distribute in the frontend bundle.
	dompurify: {
		selected: "Apache-2.0",
		reason: "Permissive branch; avoids MPL-2.0 source disclosure for a component we redistribute.",
	},
	// AFL-2.1 is unusual and carries its own patent/termination terms; BSD-3-Clause
	// is the well-understood branch.
	"json-schema": {
		selected: "BSD-3-Clause",
		reason: "Permissive, widely understood branch; avoids AFL-2.1's distinct terms.",
	},
	"type-fest": {
		selected: "MIT",
		reason: "MIT chosen over CC0-1.0; attribution is straightforward to satisfy.",
	},
	"expand-template": { selected: "MIT", reason: "MIT chosen over WTFPL." },
	rc: { selected: "MIT", reason: "MIT chosen among BSD-2-Clause / MIT / Apache-2.0." },
	"@biomejs/biome": { selected: "MIT", reason: "MIT chosen over Apache-2.0. Development-only." },
	"@biomejs/cli-linux-x64": {
		selected: "MIT",
		reason: "MIT chosen over Apache-2.0. Development-only.",
	},
	"@biomejs/cli-linux-x64-musl": {
		selected: "MIT",
		reason: "MIT chosen over Apache-2.0. Development-only.",
	},
	"@biomejs/cli-linux-arm64": {
		selected: "MIT",
		reason: "MIT chosen over Apache-2.0. Development-only.",
	},
	"@biomejs/cli-linux-arm64-musl": {
		selected: "MIT",
		reason: "MIT chosen over Apache-2.0. Development-only.",
	},
	"@biomejs/cli-darwin-arm64": {
		selected: "MIT",
		reason: "MIT chosen over Apache-2.0. Development-only.",
	},
	"@biomejs/cli-darwin-x64": {
		selected: "MIT",
		reason: "MIT chosen over Apache-2.0. Development-only.",
	},
	"@biomejs/cli-win32-x64": {
		selected: "MIT",
		reason: "MIT chosen over Apache-2.0. Development-only.",
	},
	"@biomejs/cli-win32-arm64": {
		selected: "MIT",
		reason: "MIT chosen over Apache-2.0. Development-only.",
	},
};

/**
 * License identifiers for packages whose `package.json` omits `license`.
 *
 * Each was established by reading the package's own license file, cited below.
 * This is a transcription of what upstream shipped, not a guess: a wrong entry
 * here would attribute terms upstream never granted.
 */
const LICENSE_OVERRIDES: Readonly<Record<string, { license: string; evidence: string }>> = {
	// `package.json` has no `license` field; `node_modules/khroma/license` is the
	// MIT text, "Copyright (c) 2019-present Fabio Spampinato, Andrew Maney".
	khroma: { license: "MIT", evidence: "khroma/license contains the MIT text" },
};

/** True when `license` is a disjunction requiring a documented selection. */
export function isDisjunctiveLicense(license: string): boolean {
	// SPDX uses " OR "; npm metadata in the wild also wraps it in parentheses.
	return /\bOR\b/.test(license);
}

export interface ResolvedLicense {
	license: string;
	/** Set only when a selection narrowed a disjunction. */
	declaredLicense?: string;
	selectionReason?: string;
}

/**
 * Whether `declared` actually offers `selected` as one of its alternatives.
 *
 * Compares SPDX identifiers as whole tokens. A substring test is wrong in the
 * direction that matters: `"MIT"` is contained in `"MIT-0"` and
 * `"BSD-3-Clause"` in `"BSD-3-Clause-Clear"`, so if upstream moved to a
 * near-identical identifier, the drift guard below would pass and the page would
 * claim a branch upstream never granted — the exact failure the guard exists to
 * report.
 */
function declaredOffersBranch(declared: string, selected: string): boolean {
	// Split on whitespace and parentheses: npm metadata writes disjunctions as
	// `"(MIT OR Apache-2.0)"` as often as bare `"MIT OR Apache-2.0"`.
	const tokens = declared.split(/[\s()]+/).filter(Boolean);
	return tokens.includes(selected);
}

/**
 * Resolve the license we rely on for `name`.
 *
 * Disjunctions with no table entry are returned unchanged AND reported, because
 * displaying `"MPL-2.0 OR Apache-2.0"` silently would hide an unmade decision
 * behind text that looks like a complete answer.
 */
export function resolveSelectedLicense(
	name: string,
	declared: string,
	problems: LicenseProblem[],
	kind: "bundled" | "runtime" | "development",
): ResolvedLicense {
	if (!isDisjunctiveLicense(declared)) return { license: declared };

	const selection = SELECTIONS[name];
	if (!selection) {
		problems.push({
			// Only distributed components block a release: an undocumented choice for
			// a dev-only tool is untidy, not a compliance gap.
			severity: kind === "development" ? "warn" : "error",
			name,
			message:
				`Multi-licensed as "${declared}" with no documented selection. ` +
				"Add an entry to server/lib/licenses/dual-license.ts stating which branch we rely on.",
		});
		return { license: declared };
	}

	// Guard against the table drifting from upstream: if a package changes its
	// offer and no longer includes the branch we picked, our stated license would
	// be one upstream never granted.
	if (!declaredOffersBranch(declared, selection.selected)) {
		problems.push({
			severity: kind === "development" ? "warn" : "error",
			name,
			message:
				`Selected "${selection.selected}" is not among upstream's "${declared}". ` +
				"Upstream changed its licensing; revisit server/lib/licenses/dual-license.ts.",
		});
		return { license: declared };
	}

	return {
		license: selection.selected,
		declaredLicense: declared,
		selectionReason: selection.reason,
	};
}

/** Hand-verified license identifier for a package that declares none. */
export function getLicenseOverride(name: string): string | undefined {
	return LICENSE_OVERRIDES[name]?.license;
}
