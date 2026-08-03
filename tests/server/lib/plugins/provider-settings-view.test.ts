import { describe, expect, it } from "bun:test";
import { safeParseManifest } from "@server/lib/plugins/manifest";

/**
 * The `provider-settings` surface lets a plugin replace the host's generated config
 * form with its own UI for one specific provider. That binding has to be established in
 * the manifest rather than at runtime: a plugin may contribute several providers, and
 * the host has no other way to tell which one a view configures.
 *
 * These tests pin the three ways the declaration can be wrong. Each is rejected at
 * install time, where the plugin author sees the error, instead of degrading into a view
 * that renders but configures nothing.
 */

const fixtureDirectory = new URL("../../../fixtures/plugins/", import.meta.url);

async function manifestWith(input: {
	providers?: Array<Record<string, unknown>>;
	views?: Array<Record<string, unknown>>;
}): Promise<unknown> {
	const base = (await Bun.file(new URL("valid-manifest.json", fixtureDirectory)).json()) as Record<
		string,
		unknown
	>;
	const contributes = (base.contributes ?? {}) as Record<string, unknown>;
	return {
		...base,
		// Views require a top-level `ui` entry (validateManifestCrossFields).
		ui: { entry: "ui/index.js" },
		contributes: {
			...contributes,
			...(input.providers ? { providers: input.providers } : {}),
			...(input.views ? { views: input.views } : {}),
		},
		activationEvents: ["onStartup"],
	};
}

function view(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "provider-ui",
		title: "Provider settings",
		entry: "ui/provider.js",
		surfaces: ["provider-settings"],
		scope: "global",
		instance: "singleton",
		...overrides,
	};
}

const provider = { id: "demo", title: "Demo", providerPrefix: "demo" };

async function accepts(input: Parameters<typeof manifestWith>[0]): Promise<boolean> {
	return safeParseManifest(await manifestWith(input)).success;
}

async function errorFor(input: Parameters<typeof manifestWith>[0]): Promise<string> {
	const result = safeParseManifest(await manifestWith(input));
	return result.success ? "" : JSON.stringify(result.error.issues);
}

describe("provider-settings view contract", () => {
	it("accepts a view bound to a declared provider", async () => {
		expect(await accepts({ providers: [provider], views: [view({ providerId: "demo" })] })).toBe(
			true,
		);
	});

	it("rejects a provider-settings view with no providerId", async () => {
		expect(await accepts({ providers: [provider], views: [view()] })).toBe(false);
		expect(await errorFor({ providers: [provider], views: [view()] })).toContain(
			"provider-settings view requires providerId",
		);
	});

	it("rejects a providerId that names no declared provider", async () => {
		const input = { providers: [provider], views: [view({ providerId: "absent" })] };
		expect(await accepts(input)).toBe(false);
		expect(await errorFor(input)).toContain("view references an undeclared provider");
	});

	it("rejects providerId on a surface where it would do nothing", async () => {
		// Accepting this would read as a working declaration while the host ignores it.
		const input = {
			providers: [provider],
			views: [view({ surfaces: ["workspace"], providerId: "demo", scope: "workspace" })],
		};
		expect(await accepts(input)).toBe(false);
		expect(await errorFor(input)).toContain("only valid on the provider-settings surface");
	});

	it("still accepts views on the existing surfaces without providerId", async () => {
		for (const surfaces of [["workspace"], ["settings"], ["workspace", "director"]]) {
			expect(
				await accepts({
					views: [view({ surfaces, scope: surfaces[0] === "workspace" ? "workspace" : "global" })],
				}),
			).toBe(true);
		}
	});

	it("allows a view to serve provider-settings alongside another surface", async () => {
		// A plugin may want the same UI available from its own detail page too.
		expect(
			await accepts({
				providers: [provider],
				views: [view({ surfaces: ["provider-settings", "settings"], providerId: "demo" })],
			}),
		).toBe(true);
	});

	it("rejects an unknown surface name outright", async () => {
		expect(await accepts({ views: [view({ surfaces: ["provider-config"] })] })).toBe(false);
	});
});
