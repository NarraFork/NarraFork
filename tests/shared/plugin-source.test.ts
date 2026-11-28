import { describe, expect, test } from "bun:test";
import {
	defaultPluginSourceBinding,
	PLUGIN_UPDATE_MAX_ARCHIVE_BYTES,
	pluginSourceBindingSchema,
	pluginSourceMetadataSchema,
	pluginSourceSchema,
	pluginSourceUrlSchema,
	pluginSourceVersionSchema,
	pluginWebsiteUpdateResponseSchema,
} from "../../shared/plugin-source";

const pluginId = "io.example.legacy";
const website = { type: "website", updateApi: "https://plugins.example/v1/latest" };
const release = {
	schemaVersion: 1,
	pluginId,
	latest: {
		version: "1.2.3",
		artifact: {
			url: "https://plugins.example/assets/archive.nfplugin",
			sha256: "a".repeat(64),
			size: 42,
		},
	},
};

describe("optional plugin source contracts", () => {
	test("defaults legacy source bindings to no automatic network update", () => {
		expect(pluginSourceBindingSchema.parse({})).toEqual(defaultPluginSourceBinding());
		expect(defaultPluginSourceBinding()).toEqual({
			revision: 0,
			mode: "inherit",
			source: null,
			autoUpdate: false,
		});
	});

	test("source homepage is optional and is never derived from the repository or API", () => {
		for (const source of [
			{ type: "github", owner: "example", repo: "plugin", assetName: "plugin-{version}.nfplugin" },
			website,
			{ type: "local", builtinId: pluginId },
		]) {
			const parsed = pluginSourceSchema.parse(source);
			expect(parsed.homepage).toBeUndefined();
			expect("homepage" in parsed).toBe(false);
		}
		expect(pluginSourceSchema.parse(website)).toMatchObject({
			downloadOrigins: [],
			allowInsecureHttp: false,
		});
	});

	test("accepts explicitly configured safe GitHub and website homepage links", () => {
		for (const homepage of [
			"https://github.com/example/plugin",
			"https://example.com/plugins#legacy",
		]) {
			expect(pluginSourceSchema.parse({ ...website, homepage }).homepage).toBe(homepage);
		}
	});

	test("rejects credentials, unsafe schemes, controls, encoded controls and oversized URLs", () => {
		for (const url of [
			"javascript:alert(1)",
			"data:text/html,unsafe",
			"file:///etc/passwd",
			"https://user:secret@example.test/feed",
			"https://example.test/\nfeed",
			"https://example.test/%0afeed",
			"https://example.test/%7ffeed",
			"https://example.test/\\feed",
			`https://example.test/${"x".repeat(2048)}`,
		])
			expect(pluginSourceUrlSchema.safeParse(url).success).toBe(false);
	});

	test("origins are explicit and cannot contain paths, queries or fragments", () => {
		for (const origin of [
			"https://cdn.example/path",
			"https://cdn.example/?token=x",
			"https://cdn.example/#x",
		]) {
			expect(pluginSourceSchema.safeParse({ ...website, downloadOrigins: [origin] }).success).toBe(
				false,
			);
		}
		expect(
			pluginSourceSchema.safeParse({ ...website, downloadOrigins: ["https://cdn.example"] })
				.success,
		).toBe(true);
	});

	test("repository and asset fields cannot traverse paths or carry executable extension fields", () => {
		const github = {
			type: "github",
			owner: "example",
			repo: "plugin",
			assetName: "plugin.nfplugin",
		};
		for (const changes of [
			{ repo: ".." },
			{ owner: "example/plugin" },
			{ assetName: "../plugin.nfplugin" },
			{ script: "update()" },
		]) {
			expect(pluginSourceSchema.safeParse({ ...github, ...changes }).success).toBe(false);
		}
	});

	test("source metadata remains a separate versioned strict document", () => {
		const metadata = { schemaVersion: 1, pluginId, source: website };
		expect(pluginSourceMetadataSchema.safeParse(metadata).success).toBe(true);
		for (const changes of [{ schemaVersion: 2 }, { pluginId: "../legacy" }, { builtin: true }]) {
			expect(pluginSourceMetadataSchema.safeParse({ ...metadata, ...changes }).success).toBe(false);
		}
	});

	test("automatic and cleared bindings cannot be contradictory", () => {
		const source = pluginSourceSchema.parse(website);
		expect(pluginSourceBindingSchema.safeParse({ mode: "none", source }).success).toBe(false);
		expect(pluginSourceBindingSchema.safeParse({ mode: "configured", source: null }).success).toBe(
			false,
		);
		expect(pluginSourceBindingSchema.safeParse({ autoUpdate: true }).success).toBe(false);
		expect(
			pluginSourceBindingSchema.parse({ mode: "configured", source, autoUpdate: true }).autoUpdate,
		).toBe(true);
	});

	test("SemVer validation rejects coercion and zero-prefixed numeric prereleases", () => {
		for (const version of [
			"1.2.3",
			"1.2.3-alpha.0",
			"1.2.3-rc.1+build.01",
			"99999999999999999.0.0",
		]) {
			expect(pluginSourceVersionSchema.safeParse(version).success).toBe(true);
		}
		for (const version of [
			"1.2",
			"v1.2.3",
			"01.2.3",
			"1.2.3-01",
			"1.2.3-rc.01",
			"1.2.3-",
			"1.2.3+",
		]) {
			expect(pluginSourceVersionSchema.safeParse(version).success).toBe(false);
		}
	});

	test("website responses validate their own identity, strict release metadata and byte budgets", () => {
		expect(pluginWebsiteUpdateResponseSchema.safeParse(release).success).toBe(true);
		expect(pluginWebsiteUpdateResponseSchema.safeParse({ ...release, latest: null }).success).toBe(
			true,
		);
		for (const artifact of [
			{ ...release.latest.artifact, sha256: "bad" },
			{ ...release.latest.artifact, size: 0 },
			{ ...release.latest.artifact, size: PLUGIN_UPDATE_MAX_ARCHIVE_BYTES + 1 },
			{ ...release.latest.artifact, url: "javascript:run()" },
		])
			expect(
				pluginWebsiteUpdateResponseSchema.safeParse({
					...release,
					latest: { ...release.latest, artifact },
				}).success,
			).toBe(false);
		expect(
			pluginWebsiteUpdateResponseSchema.safeParse({ ...release, updateAvailable: true }).success,
		).toBe(false);
		expect(
			pluginWebsiteUpdateResponseSchema.safeParse({
				...release,
				latest: { ...release.latest, notes: "x".repeat(4097) },
			}).success,
		).toBe(false);
	});
});
