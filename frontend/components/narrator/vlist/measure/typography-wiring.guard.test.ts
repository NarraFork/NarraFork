/**
 * typography-wiring.guard.test.ts — Keeps the measure/render layers reading their
 * typography from ONE place, and keeps role names honest.
 *
 * ## Why a guard rather than trust
 *
 * The height model only works while measurement and paint agree on the font. Both
 * sides now read `typographyMetrics()`, but nothing in the type system stops a new
 * module from doing what every module here used to do — capture a size at import
 * time:
 *
 *     const LABEL_LINE = lineBoxHeight(FONT_SIZE.xs, LINE_HEIGHT.xs); // frozen
 *
 * That compiles, passes review, and produces a row measured at the default scale
 * inside a document painted at the reader's scale. Nothing throws; the text simply
 * overlaps. This file fails instead.
 *
 * ## The collision this file exists because of
 *
 * `BODY_LINE_HEIGHT` meant `xs` (17px) in `measure-system-text.ts` and `sm` (20px)
 * in `measure-message-bubble.ts`. A name-keyed migration mapped both to the same
 * role and silently made 13 system cards 3px too tall per line. The second test
 * below pins that no two modules disagree about a shared name again.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const MEASURE_DIR = new URL(".", import.meta.url).pathname;
const RENDER_DIR = join(dirname(MEASURE_DIR.replace(/\/$/, "")), "render");

/** Non-test sources in a directory. */
function sources(dir: string, suffix: string): string[] {
	return readdirSync(dir)
		.filter((f) => f.endsWith(suffix) && !f.includes(".test."))
		.sort();
}

/** Strip comment-only lines so prose about a constant is not read as code. */
function codeLines(src: string): string[] {
	return src.split("\n").filter((line) => {
		const t = line.trimStart();
		return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
	});
}

/**
 * A declaration that BAKES a text metric into a module-level binding.
 *
 * Matches the two shapes that carry a font size: a `lineBoxHeight(...)` call and a
 * font shorthand template literal. Both are fine as documented BASELINE constants —
 * what must not happen is measurement reading them, which the next test checks.
 */
const BAKED_DECL =
	/^(?:export )?const ([A-Z_0-9]+) = (lineBoxHeight\([^)]*\)|`[^`]*\$\{?[A-Z_]*FONT[^`]*`)/;

/**
 * Every sanctioned way to resolve a text metric against the LIVE typography.
 *
 * Listed rather than hardcoding the two commonest names: `measure-misc` reads
 * `scaledLineBoxHeight` and nothing else, and an earlier version of this guard
 * reported it as an offender purely because it used a different (equally correct)
 * accessor. A guard that cries wolf gets suppressed, which is worse than no guard.
 */
const LIVE_TYPOGRAPHY_READS = [
	"typographyMetrics()",
	"bareRowMetrics()",
	"traceMetrics()",
	"headingMetrics(",
	"scaledLineBoxHeight(",
	"scaledFont(",
] as const;

function readsLiveTypography(src: string): boolean {
	return LIVE_TYPOGRAPHY_READS.some((token) => src.includes(token));
}

describe("typography wiring", () => {
	it("has every measure module reading typography at measure time", () => {
		// A module that derives a text metric must also consult the live snapshot.
		// Deriving one without ever calling it is the frozen-at-import defect.
		const offenders: string[] = [];
		for (const file of sources(MEASURE_DIR, ".ts")) {
			if (!file.startsWith("measure-")) continue;
			const src = readFileSync(join(MEASURE_DIR, file), "utf8");
			const lines = codeLines(src);
			const derives = lines.some((l) => BAKED_DECL.test(l.trim()));
			if (derives && !readsLiveTypography(src)) offenders.push(file);
		}
		expect(
			offenders,
			"these modules derive a text metric but never read the live typography",
		).toEqual([]);
	});

	it("never lets two modules disagree about what a shared constant name means", () => {
		// The BODY_LINE_HEIGHT collision (see the file header). Two modules may share a
		// name only if they compute it identically; otherwise one of them is lying to
		// every reader — and to any future mechanical migration keyed on the name.
		const byName = new Map<string, Map<string, string[]>>();
		for (const file of sources(MEASURE_DIR, ".ts")) {
			if (!file.startsWith("measure-")) continue;
			for (const raw of codeLines(readFileSync(join(MEASURE_DIR, file), "utf8"))) {
				const match = BAKED_DECL.exec(raw.trim());
				if (!match?.[1] || !match[2]) continue;
				const variants = byName.get(match[1]) ?? new Map<string, string[]>();
				const files = variants.get(match[2]) ?? [];
				files.push(file);
				variants.set(match[2], files);
				byName.set(match[1], variants);
			}
		}
		const conflicts = [...byName.entries()]
			.filter(([, variants]) => variants.size > 1)
			.map(([name, variants]) => ({
				name,
				definitions: [...variants.entries()].map(
					([init, files]) => `${init} in ${files.join(", ")}`,
				),
			}));
		expect(conflicts, "same constant name, different definition").toEqual([]);
	});

	it("keeps the render layer off the frozen baseline constants", () => {
		// The render side must paint with the same value measurement used. It may import
		// a baseline constant for documentation, but a metric that reaches a style must
		// come from the live snapshot — so any render module that mentions a text metric
		// has to read the snapshot too.
		const offenders: string[] = [];
		for (const file of sources(RENDER_DIR, ".tsx")) {
			const src = readFileSync(join(RENDER_DIR, file), "utf8");
			const mentionsMetric = /\b(?:FONT_SIZE|LINE_HEIGHT|lineBoxHeight)\b/.test(
				codeLines(src).join("\n"),
			);
			if (!mentionsMetric) continue;
			if (!readsLiveTypography(src)) offenders.push(file);
		}
		expect(offenders, "these render modules use a text metric without the live typography").toEqual(
			[],
		);
	});

	/**
	 * Per-DECLARATION check: a baked constant may be declared, but nothing may USE it.
	 *
	 * The two checks above ask "does this file mention the live typography anywhere?",
	 * which is satisfied by a single unrelated call. That let three real defects through
	 * while this file was green, all of the same shape — a frozen font paired with a
	 * scaled line box, in a module that also read `typographyMetrics()` elsewhere:
	 *
	 *   - `RenderTurnUsage` painted `400 ${FONT_SIZE.xs}px` into a scaled line box;
	 *   - `measure-permission` measured option labels at frozen sizes while the question
	 *     header above them scaled;
	 *   - `measure-tool-call` wrapped diff/detail bodies at the frozen `DETAIL_BODY_FONT`
	 *     but multiplied by the scaled `detailContentLineHeight()`.
	 *
	 * Each is invisible at 100% and each fails the same way: the reserved box and the
	 * painted text disagree, with no error. So the rule is per binding, not per file.
	 */
	it("lets no module USE a baked constant, only declare it", () => {
		const offenders: string[] = [];
		const scan = (dir: string, suffix: string) => {
			for (const file of sources(dir, suffix)) {
				const lines = codeLines(readFileSync(join(dir, file), "utf8"));
				const baked = new Set<string>();
				for (const line of lines) {
					const match = BAKED_DECL.exec(line.trim());
					if (match?.[1]) baked.add(match[1]);
				}
				if (baked.size === 0) continue;
				for (const name of baked) {
					const mention = new RegExp(`\\b${name}\\b`);
					for (const line of lines) {
						const t = line.trim();
						if (!mention.test(t)) continue;
						// Its own declaration.
						const decl = BAKED_DECL.exec(t);
						if (decl?.[1] === name) continue;
						// Re-export shapes: `NAME,` in an object literal, and `ALIAS: NAME,`.
						// Publishing a baseline constant is allowed — consuming it is not.
						if (/^[A-Z_0-9]+,$/.test(t)) continue;
						if (/^[A-Z_0-9]+:\s*[A-Z_0-9]+,$/.test(t)) continue;
						// Deriving one documented baseline from another stays baseline. Covers both
						// the baked shapes and any other module-level `const NAME = ...` built from
						// one — e.g. `const CARD_ROW_CONTENT = Math.max(16, XS_LINE_HEIGHT)`, which
						// exists purely so tests can assert the neutral value and has a live
						// `cardRowContent()` beside it for measurement. What the rule forbids is a
						// baked constant reaching a MEASUREMENT or a STYLE, not documentation.
						if (BAKED_DECL.test(t)) continue;
						if (/^(?:export )?const [A-Z_0-9]+ =/.test(t)) continue;
						if (/^export (?:const|type|interface)\b/.test(t)) continue;
						offenders.push(`${file}: ${name} used in \`${t.slice(0, 60)}\``);
					}
				}
			}
		};
		scan(MEASURE_DIR, ".ts");
		scan(RENDER_DIR, ".tsx");
		expect(
			offenders,
			"a baked baseline constant must never be USED; read the live typography instead",
		).toEqual([]);
	});

	it("routes every fragment paint site through fragmentTextStyle", () => {
		// The shipped defect this guards: letter spacing is NOT part of the `font`
		// shorthand, so a paint site that hand-writes `font: frag.font` emits size and
		// weight but silently drops spacing — measurement moves the wrap points while
		// the visible text stays tight. `fragmentTextStyle` is the only place that
		// emits the spacing pair (and the negative margin that keeps the painted
		// advance equal to the measured one), so hand-rolled style objects are banned.
		//
		// Detected structurally: a style object that sets BOTH a fragment font and the
		// fragment's own `gapBefore` margin is a fragment paint site by definition.
		const HAND_ROLLED = /marginLeft:\s*\w+\.gapBefore/;
		const offenders: string[] = [];
		const searchDirs = [RENDER_DIR, join(dirname(dirname(dirname(RENDER_DIR))), "chat")];
		for (const dir of searchDirs) {
			for (const file of sources(dir, ".tsx")) {
				const src = readFileSync(join(dir, file), "utf8");
				if (HAND_ROLLED.test(codeLines(src).join("\n"))) offenders.push(`${basename(dir)}/${file}`);
			}
		}
		expect(
			offenders,
			"these paint sites bypass fragmentTextStyle and will drop letter spacing",
		).toEqual([]);
	});
});
