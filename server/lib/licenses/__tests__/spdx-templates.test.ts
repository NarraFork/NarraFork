/**
 * spdx-templates.test.ts — Guards the license texts we substitute for packages
 * that ship none.
 *
 * These templates are legal text presented to users as the terms a component is
 * offered under. A paraphrase, a dropped clause, or a warranty disclaimer that
 * lost its "AS IS" would be invisible on the page while misstating the license —
 * so each template is compared against a canonical copy installed in
 * `node_modules`, not merely spot-checked for keywords.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { deriveCopyrightHolder, hasSpdxTemplate, renderSpdxTemplate } from "../spdx-templates";

const REPO_ROOT = join(import.meta.dir, "../../../..");

/** Compare ignoring only trailing whitespace and surrounding blank lines. */
function normalize(text: string): string {
	return text
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.trim();
}

/** Compare ignoring line-wrapping differences, which carry no legal meaning. */
function words(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/**
 * Read the canonical copy, failing loudly when it is gone.
 *
 * Every reference package here is a *transitive* dependency, so the install tree
 * can drop one at any time. The previous `if (!canonical) return;` made that
 * outcome a silent pass: the verbatim comparison — the compliance floor CLAUDE.md
 * states outright — would quietly become a no-op, which is precisely the "silent
 * shrinking" these files argue against elsewhere.
 *
 * A missing reference is therefore a failure demanding a decision: re-point the
 * test at another installed copy, or vendor one. It is not something to shrug off.
 */
function readCanonical(relativePath: string): string {
	const path = join(REPO_ROOT, relativePath);
	expect(
		existsSync(path),
		`canonical copy vanished: ${relativePath}. The verbatim check cannot run; ` +
			"re-point it at an installed copy instead of letting it pass silently.",
	).toBe(true);
	return readFileSync(path, "utf8");
}

describe("templates match canonical installed copies", () => {
	test("Apache-2.0 is the published document, verbatim", () => {
		// b4a ships an unmodified copy, still carrying the `[yyyy]` appendix — i.e. the
		// license as published rather than as applied to one project.
		const canonical = readCanonical("node_modules/b4a/LICENSE");
		expect(normalize(renderSpdxTemplate("Apache-2.0", "irrelevant") ?? "")).toBe(
			normalize(canonical),
		);
	});

	test("MIT matches upstream body", () => {
		const canonical = readCanonical("node_modules/normalize-path/LICENSE");
		const rendered = renderSpdxTemplate("MIT", "2014-2018, Jon Schlinkert.") ?? "";
		// normalize-path uses the older "The MIT License (MIT)" heading.
		expect(normalize(rendered)).toBe(
			normalize(canonical.replace("The MIT License (MIT)", "MIT License")),
		);
	});

	test("ISC matches upstream", () => {
		const canonical = readCanonical("node_modules/y18n/LICENSE");
		expect(normalize(renderSpdxTemplate("ISC", "2015, Contributors") ?? "")).toBe(
			normalize(canonical),
		);
	});

	test("0BSD matches upstream", () => {
		const canonical = readCanonical("node_modules/tslib/LICENSE.txt");
		expect(normalize(renderSpdxTemplate("0BSD", "Microsoft Corporation.") ?? "")).toBe(
			normalize(canonical),
		);
	});

	test("BSD-3-Clause matches upstream", () => {
		const canonical = readCanonical("node_modules/@protobufjs/inquire/LICENSE");
		const rendered = renderSpdxTemplate("BSD-3-Clause", "2016, Daniel Wirtz") ?? "";
		// Upstream folds "All rights reserved." onto the copyright line.
		expect(words(rendered)).toBe(words(canonical.replace("Wirtz  All", "Wirtz\nAll")));
	});

	test("BSD-2-Clause clause body matches upstream", () => {
		const canonical = readCanonical("node_modules/estraverse/LICENSE.BSD");
		const body = (text: string) => text.slice(text.indexOf("Redistribution and use"));
		const rendered = words(body(renderSpdxTemplate("BSD-2-Clause", "X") ?? "")).replace(
			"THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE",
			"<COPYRIGHT HOLDER> BE LIABLE",
		);
		expect(rendered).toBe(words(body(canonical)));
	});

	test("Unlicense matches upstream", () => {
		const canonical = readCanonical("node_modules/robust-predicates/LICENSE");
		expect(normalize(renderSpdxTemplate("Unlicense", "X") ?? "")).toBe(normalize(canonical));
	});

	test("CC0-1.0 matches upstream", () => {
		// Needed by highlightjs-vue. CC0 is a ~3 000-word legal instrument; the only
		// acceptable source is a verbatim copy.
		const canonical = readCanonical("node_modules/type-fest/license-cc0");
		expect(normalize(renderSpdxTemplate("CC0-1.0", "X") ?? "")).toBe(normalize(canonical));
	});
});

describe("substantive clauses survive", () => {
	test("BSD-2-Clause omits BSD-3's non-endorsement clause", () => {
		// Conflating the two would grant or withhold a term upstream did not.
		const text = renderSpdxTemplate("BSD-2-Clause", "X") ?? "";
		expect(text).toContain("Redistributions of source code must retain");
		expect(text).toContain("Redistributions in binary form must reproduce");
		expect(text).not.toContain("endorse or promote");
	});

	test("BSD-3-Clause includes the non-endorsement clause", () => {
		expect(renderSpdxTemplate("BSD-3-Clause", "X")).toContain("endorse or promote");
	});

	test("every template carries a warranty disclaimer", () => {
		for (const license of [
			"MIT",
			"ISC",
			"0BSD",
			"BSD-2-Clause",
			"BSD-3-Clause",
			"Apache-2.0",
			"Unlicense",
			"CC0-1.0",
		]) {
			const text = (renderSpdxTemplate(license, "X") ?? "").toUpperCase();
			// CC0 writes "AS-IS"; the others write "AS IS". Both are the disclaimer.
			expect(
				text.includes("AS IS") || text.includes("AS-IS"),
				`${license} must disclaim warranties`,
			).toBe(true);
			expect(text, `${license} must disclaim warranties`).toContain("WARRANT");
		}
	});

	test("Apache-2.0 keeps the NOTICE and patent clauses", () => {
		const text = renderSpdxTemplate("Apache-2.0", "X") ?? "";
		expect(text).toContain("Grant of Patent License");
		expect(text).toContain('If the Work includes a "NOTICE" text file');
	});
});

describe("copyright interpolation", () => {
	test("inserts the holder into placeholder-bearing templates", () => {
		expect(renderSpdxTemplate("MIT", "Acme Corp")).toContain("Copyright (c) Acme Corp");
	});

	test("leaves no unreplaced placeholder", () => {
		for (const license of ["MIT", "ISC", "0BSD", "BSD-2-Clause", "BSD-3-Clause"]) {
			expect(renderSpdxTemplate(license, "Acme"), license).not.toContain("{{copyright}}");
		}
	});

	test("Apache-2.0 and CC0-1.0 keep their fixed text", () => {
		// Apache's copyright line lives in an appendix as an *example*; CC0 is a waiver
		// of rights. Injecting a holder into either would misrepresent the document.
		expect(renderSpdxTemplate("Apache-2.0", "Acme")).toContain(
			"Copyright [yyyy] [name of copyright owner]",
		);
		expect(renderSpdxTemplate("Apache-2.0", "Acme")).not.toContain("Copyright (c) Acme");
		expect(renderSpdxTemplate("CC0-1.0", "Acme")).not.toContain("Acme");
	});

	test("returns null for an unknown identifier rather than inventing text", () => {
		expect(renderSpdxTemplate("EUPL-1.2", "X")).toBeNull();
		expect(hasSpdxTemplate("EUPL-1.2")).toBe(false);
	});

	test("derives a truthful holder when metadata is absent", () => {
		expect(deriveCopyrightHolder("some-pkg", "")).toBe("The some-pkg authors");
		expect(deriveCopyrightHolder("some-pkg", "  Real Author  ")).toBe("Real Author");
	});
});
