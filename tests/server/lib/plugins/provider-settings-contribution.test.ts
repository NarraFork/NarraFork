import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	adaptOAuthScope,
	adaptPluginCapability,
	PLUGIN_CAPABILITY_ADAPTER,
} from "@server/lib/integrations/capability-adapters";
import {
	getContributionIds,
	type Manifest,
	parseActivationEvent,
	parseManifest,
	safeParseManifest,
} from "@server/lib/plugins/manifest";
import { CAPABILITIES, LEGACY_CAPABILITY_ALIASES } from "@server/lib/plugins/permissions";
import { PLUGIN_TO_HOST_REQUEST_METHODS } from "@server/lib/plugins/protocol";
import { PluginCatalog } from "@server/services/plugin-catalog";
import {
	ActivationIndex,
	PluginContributionRegistry,
} from "@server/services/plugin-contribution-registry";
import { PluginPackageStore } from "@server/services/plugin-package-store";
import { CANONICAL_CAPABILITY_DESCRIPTORS } from "@shared/integrations/capabilities";
import { providerSettingsContributionSchema } from "@shared/provider-settings";

const input = {
	schemaVersion: 1,
	pluginId: "com.example.provider-settings",
	version: "1.0.0",
	displayName: "Saved provider inspection",
	engine: { runtime: "bun", hostApi: ">=1.0 <2", rpc: "narrafork.rpc/1" },
};
const server = { entry: "server/index.js", protocol: "narrafork.rpc/1" };
const declaration = {
	id: "inspection",
	schemaVersion: 1,
	title: "Provider inspection",
	description: "Host-owned form for an already saved provider",
	targetKinds: ["custom-api", "nug", "platform", "executable-plugin"],
	configSchema: {
		type: "object",
		properties: { enabled: { type: "boolean" } },
		additionalProperties: false,
	},
};
const providerConnection = {
	id: "usage",
	destination: "provider",
	method: "GET",
	path: "/v1/usage",
	auth: "provider-key",
};
const extensionDeclaration = {
	...declaration,
	configSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			siteUrl: { type: "string", format: "uri" },
			token: { type: "string", writeOnly: true },
			account: { type: "string", "x-narrafork-host-only": true },
		},
	},
	connections: [
		{
			id: "wallet",
			destination: "extension",
			method: "GET",
			path: "/api/user/self",
			baseUrlField: "siteUrl",
			whenUrlMissing: "provider-root",
			auth: { kind: "bearer", secretField: "token" },
			headers: [{ name: "new-api-user", field: "account" }],
		},
	],
};
const tempRoots: string[] = [];

afterEach(async () => {
	for (const root of tempRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("saved-provider settings contribution", () => {
	test("accepts a serverless static form without grants, providers, views or activation", () => {
		const manifest = parseManifest({ ...input, contributes: { providerSettings: [declaration] } });
		expect(manifest.contributes.providerSettings).toEqual([
			providerSettingsContributionSchema.parse(declaration),
		]);
		expect(getContributionIds(manifest)).toEqual(["inspection"]);
		expect(manifest.contributes.providers).toEqual([]);
		expect(manifest.contributes.tools).toEqual([]);
		expect(manifest.contributes.commands).toEqual([]);
		expect(manifest.contributes.views).toEqual([]);
		expect(manifest.server).toBeUndefined();
		expect(manifest.ui).toBeUndefined();
		expect(manifest.permissions.host).toEqual([]);
		expect(manifest.activationEvents).toEqual([]);
	});

	test("keeps old raw, normalized and explicitly typed manifests usable without the field", () => {
		// This pre-extension shape must continue to typecheck, without reparsing before discovery.
		const legacy: Manifest = {
			schemaVersion: 1,
			pluginId: input.pluginId,
			version: input.version,
			displayName: input.displayName,
			engine: {
				runtime: "bun",
				hostApi: ">=1.0 <2",
				rpc: "narrafork.rpc/1",
				runner: "local-process",
			},
			activationEvents: [],
			contributes: {
				providers: [],
				searchProviders: [],
				quotaSources: [],
				tools: [],
				commands: [],
				events: [],
				views: [],
				themes: [],
			},
			permissions: { host: [] },
			secrets: [],
			dependencies: { plugins: {}, runtime: {} },
		};
		expect(getContributionIds(legacy)).toEqual([]);
		for (const candidate of [input, { ...input, contributes: {} }, legacy]) {
			const parsed = parseManifest(candidate);
			expect(parsed.contributes.providerSettings).toBeUndefined();
			expect(getContributionIds(parsed)).toEqual([]);
			expect(parseManifest(parsed)).toEqual(parsed);
		}
		expect(
			parseManifest({ ...input, contributes: { providerSettings: [] } }).contributes
				.providerSettings,
		).toEqual([]);
	});

	test("bounds the optional list at 32 and applies the shared declaration validation", () => {
		const declarations = Array.from({ length: 32 }, (_, index) => ({
			...declaration,
			id: `inspection-${index}`,
		}));
		expect(
			safeParseManifest({ ...input, contributes: { providerSettings: declarations } }).success,
		).toBe(true);
		expect(
			safeParseManifest({
				...input,
				contributes: { providerSettings: [...declarations, { ...declaration, id: "extra" }] },
			}).success,
		).toBe(false);
		for (const change of [
			{ schemaVersion: 2 },
			{ targetKinds: ["unknown"] },
			{ providerId: "pretend-provider" },
			{ action: { title: "Inspect", handler: "ui" } },
		]) {
			const candidate = { ...declaration, ...change };
			expect(providerSettingsContributionSchema.safeParse(candidate).success).toBe(false);
			expect(
				safeParseManifest({ ...input, contributes: { providerSettings: [candidate] } }).success,
			).toBe(false);
		}
	});

	test("rejects ID collisions with every existing contribution group and with itself", () => {
		const sameId = { ...declaration, id: "same" };
		const groups = [
			{ providers: [{ id: "same" }] },
			{
				providers: [{ id: "source" }],
				searchProviders: [{ id: "same", title: "Search", providerId: "source" }],
			},
			{
				quotaSources: [
					{
						id: "same",
						title: "Quota",
						match: { hosts: ["example.test"] },
						requests: [{ path: "/quota", auth: "bearer" }],
					},
				],
			},
			{
				tools: [
					{ id: "same", title: "Tool", inputSchema: { type: "object" }, execution: "server" },
				],
			},
			{ commands: [{ id: "same", title: "Command", handler: "server" }] },
			{ events: [{ id: "same", topic: "narrafork.narrator.lifecycle" }] },
			{
				views: [
					{
						id: "same",
						title: "View",
						entry: "ui/index.js",
						surfaces: ["workspace"],
						scope: "workspace",
						instance: "singleton",
					},
				],
			},
			{ themes: [{ id: "same", title: "Theme", colorScheme: "both", tokens: {} }] },
			{ providerSettings: [sameId, sameId] },
		];
		for (const group of groups) {
			const result = safeParseManifest({
				...input,
				server,
				ui: { entry: "ui/index.js" },
				contributes: { providerSettings: [sameId], ...group },
			});
			expect(result.success).toBe(false);
			if (!result.success)
				expect(
					result.error.issues.some((issue) =>
						issue.message.includes("duplicate contribution id: same"),
					),
				).toBe(true);
		}
	});

	test("requires a server for action or nonempty connections, but not static/empty declarations", () => {
		for (const backendDeclaration of [
			{ ...declaration, action: { title: "Inspect", description: "Read status" } },
			{ ...declaration, connections: [providerConnection] },
			extensionDeclaration,
		]) {
			const withServer = parseManifest({
				...input,
				server,
				contributes: { providerSettings: [backendDeclaration] },
			});
			expect(withServer.activationEvents).toEqual([]);
			expect(withServer.permissions.host).toEqual([]);
			const missingServer = safeParseManifest({
				...input,
				contributes: { providerSettings: [backendDeclaration] },
			});
			expect(missingServer.success).toBe(false);
			if (!missingServer.success)
				expect(missingServer.error.issues.some((issue) => issue.path[0] === "server")).toBe(true);
		}
		expect(
			safeParseManifest({
				...input,
				contributes: { providerSettings: [{ ...declaration, connections: [] }] },
			}).success,
		).toBe(true);
	});

	test("does not reinterpret settings as provider/tool/view/command activation targets", () => {
		for (const event of ["onProvider", "onTool", "onView", "onCommand", "onProviderSettings"]) {
			expect(
				safeParseManifest({
					...input,
					server,
					activationEvents: [`${event}:inspection`],
					contributes: { providerSettings: [declaration] },
				}).success,
			).toBe(false);
		}
		expect(parseActivationEvent("onProviderSettings:inspection")).toBeUndefined();
	});

	test("real catalog and registry discover detached static metadata with zero entry or process execution", async () => {
		const root = await mkdtemp(join(tmpdir(), "narrafork-provider-settings-discovery-"));
		tempRoots.push(root);
		const source = join(root, "source");
		const marker = join(root, "entry-executed");
		await mkdir(join(source, "server"), { recursive: true });
		const manifest = parseManifest({
			...input,
			server,
			contributes: {
				providerSettings: [
					{
						...extensionDeclaration,
						action: { title: "Inspect" },
						connections: [providerConnection, ...extensionDeclaration.connections],
					},
				],
			},
		});
		await writeFile(join(source, "manifest.json"), JSON.stringify(manifest));
		await writeFile(
			join(source, "server", "index.js"),
			`await Bun.write(${JSON.stringify(marker)}, "executed"); throw new Error("Entry must never execute during discovery");`,
		);
		const storeRoot = join(root, "store");
		const installed = await new PluginPackageStore(storeRoot).install(source);
		const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
			throw new Error("Discovery must not spawn a runtime");
		});
		const spawnSync = spyOn(Bun, "spawnSync").mockImplementation(() => {
			throw new Error("Discovery must not spawn a runtime");
		});
		try {
			const snapshot = await new PluginCatalog({ root: storeRoot, builtinRoots: [] }).scan();
			expect(snapshot.diagnostics).toEqual([]);
			const current = snapshot.packages.find((item) => item.hash === installed.hash);
			expect(current?.status).toBe("compatible");
			expect(current?.contributions.map((item) => item.kind)).toEqual(["providerSettings"]);
			const registry = new PluginContributionRegistry(snapshot);
			const fullId = `${installed.pluginId}/inspection`;
			expect(registry.getDiagnostics()).toEqual([]);
			expect(registry.listByKind("providerSettings")).toHaveLength(1);
			for (const kind of ["provider", "tool", "command", "view"] as const)
				expect(registry.listByKind(kind)).toEqual([]);
			const entry = registry.get(fullId);
			expect(entry).toMatchObject({
				kind: "providerSettings",
				status: "available",
				version: installed.version,
				hash: installed.hash,
			});
			expect(entry?.descriptor.providerSettings).toEqual(
				manifest.contributes.providerSettings?.[0],
			);
			expect(Object.isFrozen(entry?.descriptor.providerSettings)).toBe(true);
			expect(Object.isFrozen(entry?.descriptor.providerSettings?.targetKinds)).toBe(true);
			expect(Object.isFrozen(entry?.descriptor.providerSettings?.configSchema)).toBe(true);
			const descriptor = registry.getProviderSettingsDescriptor(fullId);
			expect(descriptor).toEqual(manifest.contributes.providerSettings?.[0]);
			expect(descriptor).not.toBe(entry?.descriptor.providerSettings);
			if (descriptor) {
				descriptor.title = "Changed form";
				descriptor.targetKinds.length = 0;
			}
			if (current?.contributions[0]?.providerSettings)
				current.contributions[0].providerSettings.title = "Changed catalog";
			expect(registry.getProviderSettingsDescriptor(fullId)).toEqual(
				manifest.contributes.providerSettings?.[0],
			);
			expect(
				registry.getProviderSettingsDescriptor(`${installed.pluginId}/missing`),
			).toBeUndefined();
			const activation = new ActivationIndex(snapshot);
			expect(activation.listTargets()).toEqual([]);
			expect(activation.getDiagnostics()).toEqual([]);
			const conflicted = structuredClone(snapshot);
			const conflictedPackage = conflicted.packages.find((item) => item.hash === installed.hash);
			if (!conflictedPackage?.contributions[0]) throw new Error("Missing installed contribution");
			conflictedPackage.contributions.push({
				...conflictedPackage.contributions[0],
				kind: "tool",
			});
			const conflictedRegistry = new PluginContributionRegistry(conflicted);
			expect(conflictedRegistry.list()).toHaveLength(1);
			expect(
				conflictedRegistry
					.getDiagnostics()
					.some((item) => item.code === "CONTRIBUTION_FULL_ID_CONFLICT"),
			).toBe(true);
			const mismatched = structuredClone(snapshot);
			const mismatchedPackage = mismatched.packages.find((item) => item.hash === installed.hash);
			if (!mismatchedPackage?.contributions[0]?.providerSettings)
				throw new Error("Missing static settings declaration");
			mismatchedPackage.contributions[0].providerSettings.id = "other";
			expect(
				new PluginContributionRegistry(mismatched).getProviderSettingsDescriptor(fullId),
			).toBeUndefined();
			registry.refresh(snapshot);
			expect(registry.markUnavailable(fullId, "revoked")).toBe(true);
			expect(registry.get(fullId)?.status).toBe("unavailable");
			// Discovery stays value-free even while unavailable; it must not be an authority grant.
			expect(registry.getProviderSettingsDescriptor(fullId)?.configSchema).toEqual(
				manifest.contributes.providerSettings?.[0]?.configSchema,
			);
			expect(spawn).not.toHaveBeenCalled();
			expect(spawnSync).not.toHaveBeenCalled();
			expect(await Bun.file(marker).exists()).toBe(false);
		} finally {
			spawn.mockRestore();
			spawnSync.mockRestore();
		}
	});

	test("canonical adapters are complete, reversible, plugin-installation-only and independent of old grants/RPC", () => {
		expect(Object.keys(PLUGIN_CAPABILITY_ADAPTER).sort()).toEqual([...CAPABILITIES].sort());
		const newCapabilities = [
			"provider.settings.read_self",
			"provider.settings.connection.use",
		] as const;
		for (const capability of newCapabilities) {
			expect(CAPABILITIES).toContain(capability);
			const descriptor = CANONICAL_CAPABILITY_DESCRIPTORS[capability];
			expect(adaptPluginCapability(capability)).toMatchObject({
				...descriptor,
				source: "plugin",
				sourceId: capability,
				visibility: "integration",
				deprecated: false,
			});
			expect(descriptor.allowedSubjects).toEqual(["plugin_installation"]);
			expect(descriptor.defaultRedaction).toBe("secrets");
			expect(
				Object.values(PLUGIN_CAPABILITY_ADAPTER).filter(
					(entry) => entry.descriptorId === capability,
				),
			).toHaveLength(1);
			expect(Object.values(LEGACY_CAPABILITY_ALIASES)).not.toContain(capability);
			expect(adaptOAuthScope(capability)).toBeUndefined();
			expect(PLUGIN_TO_HOST_REQUEST_METHODS as readonly string[]).not.toContain(capability);
		}
		for (const old of [
			"config.read_self",
			"config.write_self",
			"provider.use",
			"provider.connection.request",
			"quota.provide",
		])
			expect(newCapabilities as readonly string[]).not.toContain(
				adaptPluginCapability(old)?.id ?? "",
			);
	});
});
