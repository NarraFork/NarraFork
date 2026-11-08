import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * The model catalog has one metadata representation. Older stored shapes are imported
 * at three read boundaries only; everything else must speak the raw contract, so a
 * second in-memory format (and the conversions that kept it in step) cannot return.
 */
const IMPORTERS = new Set([
	"server/lib/model-catalog/index.ts",
	"server/lib/model-catalog/source.ts",
	"server/lib/nug-model-cache.ts",
	"server/lib/settings/types.ts",
]);
// Names of the retired grouped-metadata runtime. They may appear only inside the importer.
const RETIRED = [
	"ResolvedModelMetadata",
	"LocalCatalogState",
	"CatalogDocument",
	"getEffectiveModelMetadata",
	"createModelMetadataResolver",
	"resolveModelMetadata",
	"mutateModelCatalog",
	"getModelCatalogSnapshot",
	"ModelCatalogMutation",
	"ModelCatalogSnapshot",
	"rawLocalToLegacy",
	"reconcileLegacyWindowSettings",
	// The editable raw local layer (variants, bindings, revisioned mutations) it replaced.
	"createModelCardResolver",
	"createModelIdentityResolver",
	"mutateModelCard",
	"getModelCardSnapshot",
	"ModelCardMutation",
	"ModelCardSnapshot",
	"RawLocalState",
	"RawBinding",
];

function sources(): string[] {
	const files: string[] = [];
	for (const root of ["server", "shared", "frontend"])
		for (const file of new Bun.Glob(`${root}/**/*.{ts,tsx}`).scanSync("."))
			if (
				!/(\.test\.tsx?|__tests__\/)/.test(file) &&
				!file.includes("/node_modules/") &&
				!file.startsWith("frontend/routeTree.gen")
			)
				files.push(file);
	return files;
}

describe("model catalog format boundary", () => {
	const files = sources();
	test("only the read boundaries import old stored shapes", () => {
		const offenders = files.filter(
			(file) =>
				file !== "server/lib/model-catalog/legacy-v1.ts" &&
				/model-catalog\/legacy-v1["']/.test(readFileSync(file, "utf8")) &&
				!IMPORTERS.has(file),
		);
		expect(offenders).toEqual([]);
	});
	test("the retired grouped-metadata runtime does not reappear", () => {
		const offenders = files.flatMap((file) => {
			if (file === "server/lib/model-catalog/legacy-v1.ts") return [];
			const text = readFileSync(file, "utf8");
			return RETIRED.filter((name) => new RegExp(`\\b${name}\\b`).test(text)).map(
				(name) => `${file}: ${name}`,
			);
		});
		expect(offenders).toEqual([]);
	});
});
