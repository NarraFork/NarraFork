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
	test("derives the canonical enum, Zod schema, and JSON Schema from one taxonomy", () => {
		const taxonomyCapabilities = Object.values(CAPABILITY_TAXONOMY).flat();
		const canonicalJsonSchema = z.toJSONSchema(capabilitySchema) as { enum?: string[] };
		const manifestJsonSchema = z.toJSONSchema(manifestCapabilitySchema) as { enum?: string[] };

		expect(taxonomyCapabilities).toEqual([...CAPABILITIES]);
		expect(new Set(CAPABILITIES).size).toBe(CAPABILITIES.length);
		expect(canonicalJsonSchema.enum).toEqual([...CAPABILITIES]);
		expect(manifestJsonSchema.enum).toEqual([...CAPABILITIES]);
		expect(CAPABILITIES).toEqual(
			expect.arrayContaining([
				"event.subscribe.project",
				"event.subscribe.plugin",
				"event.subscribe.device",
				"event.subscribe.public",
			]),
		);
	});

	test("normalizes only explicit Manifest-v1 aliases and never emits them", async () => {
		const legacy = await loadFixture("valid-manifest.json");
		const parsed = parseManifest(legacy);

		expect(parsed.permissions.host).toEqual(["query.read.chapters", "ui.panel"]);
		expect(capabilitySchema.safeParse("query.chapters.read").success).toBe(false);
		expect(manifestCapabilitySchema.parse("query.chapters.read")).toBe("query.read.chapters");
		expect(normalizeCapabilityName("query.chapters.read")).toBe("query.read.chapters");
		expect(normalizeCapabilityName("query.unknown.read")).toBeUndefined();
		expect(Object.values(LEGACY_CAPABILITY_ALIASES).every(isCanonicalPermissionName)).toBe(true);
		expect(LEGACY_CAPABILITY_ALIAS_POLICY).toMatchObject({
			status: "deprecated",
			emitted: false,
			removeInManifestSchemaVersion: 2,
		});
	});

	test("rejects unknown capabilities/features and duplicates created by alias normalization", async () => {
		const unknown = await loadFixture("valid-manifest.json");
		(unknown.permissions as { host: string[] }).host = ["query.read.unknown"];
		expect(safeParseManifest(unknown).success).toBe(false);

		const unknownFeature = await loadFixture("valid-manifest.json");
		(unknownFeature.engine as { features?: string[] }).features = ["unknown.feature"];
		expect(safeParseManifest(unknownFeature).success).toBe(false);

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
