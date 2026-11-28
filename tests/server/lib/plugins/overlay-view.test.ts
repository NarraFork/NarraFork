import { describe, expect, it } from "bun:test";
import { safeParseManifest } from "@server/lib/plugins/manifest";

/**
 * The `overlay` surface has exactly one layer per app instance, and the host only mounts
 * global-scope overlay views. Any other scope must be rejected at install time instead of
 * parsing and then silently never appearing.
 */

const fixtureDirectory = new URL("../../../fixtures/plugins/", import.meta.url);

async function manifestWithView(view: Record<string, unknown>): Promise<unknown> {
	const base = (await Bun.file(new URL("valid-manifest.json", fixtureDirectory)).json()) as Record<
		string,
		unknown
	>;
	const contributes = (base.contributes ?? {}) as Record<string, unknown>;
	return {
		...base,
		ui: { entry: "ui/index.js" },
		contributes: {
			...contributes,
			views: [
				{
					id: "pet",
					title: "Pet",
					entry: "ui/pet.js",
					surfaces: ["overlay"],
					scope: "global",
					instance: "singleton",
					...view,
				},
			],
		},
		activationEvents: ["onStartup"],
	};
}

describe("overlay view contract", () => {
	it("accepts a global-scope overlay view", async () => {
		expect(safeParseManifest(await manifestWithView({})).success).toBe(true);
	});

	for (const scope of ["workspace", "narrator", "project"]) {
		it(`rejects an overlay view with ${scope} scope`, async () => {
			const result = safeParseManifest(await manifestWithView({ scope }));
			expect(result.success).toBe(false);
			expect(result.success ? "" : JSON.stringify(result.error.issues)).toContain(
				"overlay views must use global scope",
			);
		});
	}

	it("still accepts non-global scope on views that do not use the overlay", async () => {
		expect(
			safeParseManifest(await manifestWithView({ surfaces: ["workspace"], scope: "workspace" }))
				.success,
		).toBe(true);
	});
});
