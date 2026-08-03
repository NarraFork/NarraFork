import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
	isCanonicalPermissionName,
	parseManifest,
	safeParseManifest,
} from "@server/lib/plugins/manifest";
import {
	CAPABILITIES,
	CAPABILITY_TAXONOMY,
	capabilitySchema,
	KNOWN_CAPABILITIES,
	LEGACY_CAPABILITY_ALIAS_POLICY,
	LEGACY_CAPABILITY_ALIASES,
	manifestCapabilitySchema,
	normalizeCapabilityName,
} from "@server/lib/plugins/permissions";
import { NARRAFORK_RPC_PROTOCOL, PLUGIN_TO_HOST_FEATURES } from "@server/lib/plugins/protocol";
import { z } from "zod";

const fixtureDirectory = new URL("../../../fixtures/plugins/", import.meta.url);
const exampleRoot = join(process.cwd(), "examples/plugins");

async function loadFixture(name: string): Promise<Record<string, unknown>> {
	return Bun.file(new URL(name, fixtureDirectory)).json();
}

describe("Manifest/capability parity", () => {
	test("keeps the taxonomy as documentation of known names, not an admission test", () => {
		const taxonomyCapabilities = Object.values(CAPABILITY_TAXONOMY).flat();
		const canonicalJsonSchema = z.toJSONSchema(capabilitySchema) as {
			enum?: string[];
			type?: string;
		};

		// The taxonomy still enumerates every name the host itself knows about, and stays
		// duplicate-free, because admin UIs and docs read it.
		expect(taxonomyCapabilities).toEqual([...CAPABILITIES]);
		expect(new Set(CAPABILITIES).size).toBe(CAPABILITIES.length);
		expect(KNOWN_CAPABILITIES).toEqual([...CAPABILITIES]);
		expect(CAPABILITIES).toEqual(
			expect.arrayContaining([
				"event.subscribe.project",
				"event.subscribe.plugin",
				"event.subscribe.device",
				"event.subscribe.public",
			]),
		);

		// But the schema is no longer generated from it: capability names are open strings,
		// so the emitted JSON Schema carries no enum to validate against.
		expect(canonicalJsonSchema.type).toBe("string");
		expect(canonicalJsonSchema.enum).toBeUndefined();
	});

	test("still rewrites Manifest-v1 aliases and never emits them", async () => {
		const legacy = await loadFixture("valid-manifest.json");
		const parsed = parseManifest(legacy);

		expect(parsed.permissions.host).toEqual(["query.read.chapters", "ui.panel"]);
		expect(manifestCapabilitySchema.parse("query.chapters.read")).toBe("query.read.chapters");
		expect(normalizeCapabilityName("query.chapters.read")).toBe("query.read.chapters");
		expect(Object.values(LEGACY_CAPABILITY_ALIASES).every(isCanonicalPermissionName)).toBe(true);
		expect(LEGACY_CAPABILITY_ALIAS_POLICY).toMatchObject({
			status: "deprecated",
			emitted: false,
			removeInManifestSchemaVersion: 2,
		});

		// Aliases are resolved before the open-string check, otherwise a well-formed alias
		// would pass through unrewritten and split one capability into two.
		for (const [alias, canonical] of Object.entries(LEGACY_CAPABILITY_ALIASES)) {
			expect(manifestCapabilitySchema.parse(alias)).toBe(canonical);
		}
	});

	test("accepts unknown capabilities but still rejects malformed names and duplicates", async () => {
		// Unknown-to-the-host capability names now parse: declaring one is how a plugin
		// describes an integration the host has not enumerated.
		const unknown = await loadFixture("valid-manifest.json");
		(unknown.permissions as { host: string[] }).host = ["query.read.unknown"];
		expect(safeParseManifest(unknown).success).toBe(true);

		const vendor = await loadFixture("valid-manifest.json");
		(vendor.permissions as { host: string[] }).host = ["com.acme.telemetry.push", "*"];
		expect(safeParseManifest(vendor).success).toBe(true);

		// camelCase is accepted; the host's own taxonomy uses it.
		const camel = await loadFixture("valid-manifest.json");
		(camel.permissions as { host: string[] }).host = ["diagnostics.readOwnLogs"];
		expect(safeParseManifest(camel).success).toBe(true);

		// Malformed names are still refused, so audit records stay well-formed.
		const malformed = await loadFixture("valid-manifest.json");
		(malformed.permissions as { host: string[] }).host = ["Not A Capability"];
		expect(safeParseManifest(malformed).success).toBe(false);

		// `engine.features` is a host-negotiated protocol list, not a capability claim, so
		// it remains closed: an unknown feature means the plugin expects RPC we cannot serve.
		const unknownFeature = await loadFixture("valid-manifest.json");
		(unknownFeature.engine as { features?: string[] }).features = ["unknown.feature"];
		expect(safeParseManifest(unknownFeature).success).toBe(false);

		// Duplicates created by alias normalization are still a manifest authoring error.
		const duplicate = await loadFixture("valid-manifest.json");
		(duplicate.permissions as { host: string[] }).host = [
			"query.chapters.read",
			"query.read.chapters",
		];
		expect(safeParseManifest(duplicate).success).toBe(false);
	});

	test("keeps every reference Manifest on canonical permission and protocol fields", async () => {
		const entries = (await readdir(exampleRoot, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.sort((left, right) => left.name.localeCompare(right.name));
		expect(entries.length).toBeGreaterThan(0);

		for (const entry of entries) {
			const raw = (await Bun.file(join(exampleRoot, entry.name, "manifest.json")).json()) as {
				engine: { rpc: string; features?: string[] };
				server?: { protocol: string };
				permissions: { host: string[] };
			};
			const manifest = parseManifest(raw);

			expect(raw.engine.rpc).toBe(NARRAFORK_RPC_PROTOCOL);
			expect(raw.server?.protocol ?? NARRAFORK_RPC_PROTOCOL).toBe(NARRAFORK_RPC_PROTOCOL);
			expect(raw.permissions.host.every(isCanonicalPermissionName)).toBe(true);
			expect(
				(raw.engine.features ?? []).every((feature) =>
					(PLUGIN_TO_HOST_FEATURES as readonly string[]).includes(feature),
				),
			).toBe(true);
			expect([...manifest.permissions.host] as string[]).toEqual(raw.permissions.host);
		}
	});
});
