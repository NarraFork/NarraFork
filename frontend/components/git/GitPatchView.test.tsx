import { describe, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import type { GitStagingUnit, GitStagingUnitDiffMapping } from "@shared/git-staging-lists";
import type { DiffLine } from "@shared/pretext-layout/diff-core";
import { parseUnifiedDiff } from "@shared/pretext-layout/parse-unified-diff";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import type { DiffLineOperations } from "../narrator/diff/DiffContent";
import { completeStagingDiffMappings } from "./git-staging-diff-mappings";

let operations: DiffLineOperations | undefined;
let renderedLines: readonly DiffLine[] = [];
mock.module("@frontend/components/narrator/diff/DiffView", () => ({
	DiffView: ({
		lineOperations,
		lines,
	}: {
		lineOperations?: DiffLineOperations;
		lines: readonly DiffLine[];
	}) => {
		operations = lineOperations;
		renderedLines = lines;
		return (
			<div data-rendered-lines>
				{[0, 1, 2, 3, 4].map((row) => (
					<div key={row}>{lineOperations?.render(row)}</div>
				))}
			</div>
		);
	},
}));
const { GitPatchView } = await import("./GitPatchView");
const patch =
	"diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -10,3 +10,3 @@\n-old\n+new\n same\n-last\n+next\n";
const lines = parseUnifiedDiff(patch).lines;
const units: GitStagingUnit[] = [0, 1].map((index) => ({
	id: `u${index}`,
	fileId: "f",
	path: "file.txt",
	kind: "text",
	listId: "A",
	baseStart: index * 40,
	baseEnd: index * 40 + 1,
	workStart: index * 50,
	workEnd: index * 50 + 1,
	added: 1,
	removed: 1,
	needsReview: false,
}));
const mappings: GitStagingUnitDiffMapping[] = [
	{ unitId: "u0", lineRanges: [{ start: 0, end: 2 }] },
	{ unitId: "u1", lineRanges: [{ start: 3, end: 5 }] },
];
function mapped(
	overrides: { mappings?: GitStagingUnitDiffMapping[]; count?: number; truncated?: boolean } = {},
) {
	return completeStagingDiffMappings(
		units,
		overrides.mappings ?? mappings,
		lines,
		overrides.count ?? lines.length,
		overrides.truncated ?? false,
	).map((entry) => entry.unitId);
}
function render({
	source = patch,
	metadata = mappings,
	truncated = false,
	layout = "unified",
	manyUnits = units,
	selectedIds = ["u1"],
	showAll = false,
}: {
	source?: string;
	metadata?: GitStagingUnitDiffMapping[];
	truncated?: boolean;
	layout?: "unified" | "split";
	manyUnits?: GitStagingUnit[];
	selectedIds?: string[];
	showAll?: boolean;
} = {}) {
	operations = undefined;
	const html = renderToStaticMarkup(
		<MantineProvider>
			<GitPatchView
				diff={source}
				file="file.txt"
				resetKey="file"
				truncated={truncated}
				layout={layout}
				unitActions={{
					units: manyUnits,
					mappings: metadata,
					selectedIds,
					showAll,
					render: (unit, inline) => (
						<button type="button" data-test-unit={unit.id} data-inline={inline || undefined}>
							{unit.id}
						</button>
					),
				}}
			/>
		</MantineProvider>,
	);
	return parseHTML(`<html><body>${html}</body></html>`).document;
}

describe("complete ownership display mapping", () => {
	test("one hunk can expose multiple complete units without using work coordinates", () => {
		expect(mapped()).toEqual(["u0", "u1"]);
	});
	test("partial frontend segments and server truncation keep full unit fallback", () => {
		expect(mapped({ count: 4 })).toEqual(["u0"]);
		expect(mapped({ truncated: true })).toEqual([]);
		expect(completeStagingDiffMappings(units, undefined, lines, 5, false)).toEqual([]);
	});
	test("overlap, duplicate mappings, context lines and count mismatches fail closed", () => {
		expect(
			mapped({ mappings: [mappings[0], { unitId: "u1", lineRanges: [{ start: 1, end: 3 }] }] }),
		).toEqual([]);
		expect(mapped({ mappings: [mappings[0], mappings[0]] })).toEqual([]);
		expect(mapped({ mappings: [{ unitId: "u0", lineRanges: [{ start: 0, end: 3 }] }] })).toEqual(
			[],
		);
		expect(mapped({ mappings: [{ unitId: "u0", lineRanges: [{ start: 0, end: 1 }] }] })).toEqual(
			[],
		);
	});
	test("invalid intervals and structure-only units never gain guessed text actions", () => {
		for (const range of [
			{ start: -1, end: 2 },
			{ start: 1, end: 1 },
			{ start: 0, end: 99 },
			{ start: 0.5, end: 2 },
		])
			expect(mapped({ mappings: [{ unitId: "u0", lineRanges: [range] }] })).toEqual([]);
		expect(
			completeStagingDiffMappings([{ ...units[0], kind: "mode" }], [mappings[0]], lines, 5, false),
		).toEqual([]);
	});
	test("pure deletion and non-contiguous ranges preserve every real changed row", () => {
		expect(
			completeStagingDiffMappings(
				[{ ...units[0], added: 0, removed: 2 }],
				[
					{
						unitId: "u0",
						lineRanges: [
							{ start: 0, end: 1 },
							{ start: 3, end: 4 },
						],
					},
				],
				lines,
				5,
				false,
			),
		).toHaveLength(1);
	});
});

describe("GitPatchView ownership controls", () => {
	test("renders code-side anchors and highlights exactly the selected unit ranges", () => {
		const document = render();
		expect(document.querySelectorAll("[data-inline]").length).toBe(2);
		expect(document.querySelector("[data-git-staging-unit-fallback]")).toBeNull();
		expect([...(operations?.selected ?? [])]).toEqual([3, 4]);
		expect(operations?.keys?.get(3)).toBe("u1:0");
		expect([...(operations?.anchors ?? [])]).toEqual([0, 3]);
		expect(operations?.minHeight).toBeUndefined();
		expect(operations?.width).toBe(84);
		expect(operations?.keys?.size).toBe(4);
		expect(operations?.render(2)).toBeNull();
	});
	test("adjacent single-line anchors preserve blank, whitespace and long code rows at natural height", () => {
		const contents = ["first", "", " ", "\t", "long ".repeat(80)];
		const manyUnits = contents.map((_, index) => ({
			...units[0],
			id: `single-${index}`,
			added: 1,
			removed: 0,
		}));
		const document = render({
			source: `@@ -0,0 +1,5 @@\n${contents.map((content) => `+${content}`).join("\n")}\n`,
			manyUnits,
			metadata: manyUnits.map((unit, row) => ({
				unitId: unit.id,
				lineRanges: [{ start: row, end: row + 1 }],
			})),
			selectedIds: ["single-1"],
		});
		expect(
			renderedLines.filter((line) => line.type === "added").map((line) => line.content),
		).toEqual(contents);
		expect([...(operations?.anchors ?? [])]).toEqual([0, 1, 2, 3, 4]);
		expect([...(operations?.selected ?? [])]).toEqual([1]);
		expect(operations?.minHeight).toBeUndefined();
		expect(operations?.keys?.size).toBe(contents.length);
		expect(document.querySelectorAll("[data-inline]").length).toBe(contents.length);
	});

	test("split presentation leaves operation row geometry unchanged", () => {
		render({ layout: "split" });
		expect(operations).toBeUndefined();
	});

	test("the full-unit list also exposes precisely mapped identities on demand", () => {
		const document = render({ showAll: true });
		expect(
			document.querySelectorAll("[data-git-staging-unit-fallback] [data-test-unit]").length,
		).toBe(2);
		expect(document.querySelectorAll("[data-inline]").length).toBe(2);
	});
	test("thousands of selected units never perform a linear ID search for each displayed line", () => {
		const manyUnits = Array.from({ length: 5000 }, (_, index) => ({
			...units[0],
			id: `unit-${index}`,
			added: 1,
			removed: 0,
		}));
		const source = `diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -0,0 +1,5000 @@\n${manyUnits.map((unit) => `+${unit.id}`).join("\n")}\n`;
		const selectedIds = manyUnits.map((unit) => unit.id);
		selectedIds.includes = () => {
			throw new Error("Per-line linear lookup");
		};
		render({
			source,
			manyUnits,
			selectedIds,
			metadata: manyUnits.map((unit, index) => ({
				unitId: unit.id,
				lineRanges: [{ start: index, end: index + 1 }],
			})),
		});
		expect(operations?.selected?.size).toBe(500);
		expect(operations?.anchors?.size).toBe(500);
		expect(operations?.anchors?.has(499)).toBe(true);
		expect(operations?.anchors?.has(500)).toBe(false);
	});
	test("missing metadata and truncation preserve explicit backend unit selection", () => {
		for (const options of [{ metadata: [] }, { truncated: true }]) {
			const document = render(options);
			expect(
				document.querySelectorAll("[data-git-staging-unit-fallback] [data-test-unit]").length,
			).toBe(2);
			expect(document.querySelectorAll("[data-inline]").length).toBe(0);
			expect(operations).toBeUndefined();
		}
	});
	test("a unit straddling the 500-row segment remains only in the full-unit list", () => {
		const source = `diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1,502 @@\n-old\n${Array.from({ length: 502 }, (_, index) => `+line ${index}`).join("\n")}\n`;
		const document = render({
			source,
			manyUnits: [{ ...units[0], added: 502, removed: 1 }],
			metadata: [{ unitId: "u0", lineRanges: [{ start: 0, end: 503 }] }],
		});
		expect(operations).toBeUndefined();
		expect(
			document.querySelector("[data-git-staging-unit-fallback] [data-test-unit='u0']"),
		).not.toBeNull();
	});
	test("fallback rendering stays bounded with thousands of complete unit identities", () => {
		const document = render({
			manyUnits: Array.from({ length: 5000 }, (_, index) => ({ ...units[0], id: `unit-${index}` })),
			metadata: [],
		});
		expect(
			document.querySelector("[data-git-staging-unit-fallback]")?.getAttribute("data-total"),
		).toBe("5000");
		expect(document.querySelectorAll("[data-test-unit]").length).toBe(12);
	});
});
