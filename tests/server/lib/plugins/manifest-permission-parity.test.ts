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

	/**
	 * Every Plugin→Host method a reference plugin actually calls must have its capability
	 * declared in that plugin's `permissions.host`.
	 *
	 * from its token-writeback path while declaring no `secret.use_self`. Grants are seeded
	 * strictly from `permissions.host` (`plugin-manager.ts` `seedGrantsFromManifest`), and the
	 * broker treats an absent grant as a denial on purpose (`plugin-capability-broker.ts`:
	 * "Deliberately still a denial") — so the call was rejected at runtime. Because the
	 * writeback is fire-and-forget, the rejection was swallowed and **every token rotation
	 * silently failed to persist**. For IDC credentials, whose refresh tokens are
	 * single-use, that is unrecoverable credential loss.
	 *
	 * Nothing else catches this: the manifest is valid, the code compiles, the plugin runs,
	 * and the only symptom is a log line. The check is deliberately source-derived (scan the
	 * plugin's own sources for the method names) rather than a hand-maintained table, because
	 * a table would drift exactly the way the manifest did.
	 */
	test("declares the capability for every host method a reference plugin calls", async () => {
		// Method → capability, mirroring the dispatcher's own table in
		// `plugin-host-services.ts`. Only the methods a plugin backend would call for
		// credential/config work are listed; the rest are covered by their own contracts.
		const METHOD_CAPABILITIES: Record<string, string> = {
			"secrets.get": "secret.use_self",
			"secrets.set": "secret.use_self",
			"secrets.delete": "secret.use_self",
			"secrets.list": "secret.use_self",
			"storage.get": "storage.read_self",
			"storage.list": "storage.read_self",
			"storage.set": "storage.write_self",
			"storage.delete": "storage.write_self",
			"config.get": "config.read_self",
			"diagnostics.getOwn": "diagnostics.readOwnLogs",
		};

		const entries = (await readdir(exampleRoot, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.sort((left, right) => left.name.localeCompare(right.name));

		for (const entry of entries) {
			const sourceRoot = join(exampleRoot, entry.name, "src");
			const sources = await collectSourceFiles(sourceRoot);
			// A plugin without TypeScript sources (a theme, or hand-written JS) has nothing
			// to derive from.
			if (sources.length === 0) continue;

			const text = (await Promise.all(sources.map((file) => Bun.file(file).text()))).join("\n");
			const declared = new Set(
				(
					(await Bun.file(join(exampleRoot, entry.name, "manifest.json")).json()) as {
						permissions: { host: string[] };
					}
				).permissions.host,
			);

			for (const [method, capability] of Object.entries(METHOD_CAPABILITIES)) {
				// Match the method only as a quoted RPC method name, so a same-named local
				// helper does not register as a host call.
				if (!new RegExp(`["'\`]${method.replace(".", "\\.")}["'\`]`).test(text)) continue;
				expect(
					declared.has(capability),
					`${entry.name} calls ${method} but does not declare ${capability}`,
				).toBe(true);
			}
		}
	});
});

/**
 * The check above only proves something if it can fail, and a parity test that silently
 * matches nothing looks identical to one that passes. So the same rule is applied to a
 * synthetic plugin that calls `secrets.set` while declaring no `secret.use_self` — exactly
 * the shape of the real bug — and must reject it.
 *
 * Written against synthetic inputs rather than by mutating a real manifest: the reference
 * manifests are the thing under test, and temporarily breaking one on disk risks leaving it
 * broken if the run is interrupted.
 */
describe("host method capability parity, negative case", () => {
	const METHOD_CAPABILITIES: Record<string, string> = {
		"secrets.set": "secret.use_self",
		"storage.set": "storage.write_self",
	};

	function missingCapabilities(source: string, declaredHost: string[]): string[] {
		const declared = new Set(declaredHost);
		const missing: string[] = [];
		for (const [method, capability] of Object.entries(METHOD_CAPABILITIES)) {
			if (!new RegExp(`["'\`]${method.replace(".", "\\.")}["'\`]`).test(source)) continue;
			if (!declared.has(capability)) missing.push(capability);
		}
		return missing;
	}

	test("flags a plugin that calls secrets.set without declaring secret.use_self", () => {
		const source = `await request("secrets.set", { key, value });`;
		expect(missingCapabilities(source, ["provider.register"])).toEqual(["secret.use_self"]);
	});

	test("accepts the same call once the capability is declared", () => {
		const source = `await request("secrets.set", { key, value });`;
		expect(missingCapabilities(source, ["provider.register", "secret.use_self"])).toEqual([]);
	});

	test("does not flag a same-named local helper", () => {
		// The method name must appear as a quoted RPC method, not as an identifier, or every
		// plugin with a `storage.set`-like helper would trip the check.
		const source = `function storageSet(key: string) {}\nstorageSet("k");`;
		expect(missingCapabilities(source, [])).toEqual([]);
	});
});

/** Every `.ts`/`.tsx` file under a directory, recursively. Empty when it does not exist. */
async function collectSourceFiles(root: string): Promise<string[]> {
	let dirEntries: { name: string; isDirectory(): boolean }[];
	try {
		dirEntries = await readdir(root, { withFileTypes: true });
	} catch {
		return [];
	}
	const files: string[] = [];
	for (const item of dirEntries) {
		const full = join(root, item.name);
		if (item.isDirectory()) files.push(...(await collectSourceFiles(full)));
		else if (item.name.endsWith(".ts") || item.name.endsWith(".tsx")) files.push(full);
	}
	return files;
}
