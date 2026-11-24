import { expect, mock, test } from "bun:test";
import {
	BuiltinPluginCatalog,
	builtinPluginCatalog,
	PROVIDER_QUOTA_BUILTIN_ID,
} from "@server/services/builtin-plugin-catalog";

const ID = PROVIDER_QUOTA_BUILTIN_ID;

test("builtin enumeration is synchronous, host-owned and homepage-free without loading an archive", () => {
	const load = mock(async () => ({ bytes: new Uint8Array([1]), sha256: "a".repeat(64) }));
	const catalog = new BuiltinPluginCatalog({
		descriptors: [
			{ pluginId: "com.external.plugin", version: "9.0.0", load },
			{ pluginId: ID, version: "1.0.3", load },
		],
	});
	const definition = catalog.get(ID);
	expect(definition).toMatchObject({
		pluginId: ID,
		version: "1.0.3",
		displayName: "Provider Quota",
		source: { type: "local", builtinId: ID },
	});
	expect(Object.isFrozen(definition)).toBe(true);
	expect(Object.isFrozen(definition?.source)).toBe(true);
	expect(Object.hasOwn(definition?.source ?? {}, "homepage")).toBe(false);
	expect(catalog.get("com.external.plugin")).toBeUndefined();
	expect(catalog.get("../provider-quota.nfplugin")).toBeUndefined();
	expect(catalog.list()).toEqual([
		{
			pluginId: ID,
			displayName: "Provider Quota",
			description: definition?.description,
			version: "1.0.3",
			source: { type: "local", builtinId: ID },
			installed: false,
			installedVersion: null,
			canInstall: true,
		},
	]);
	expect(load).not.toHaveBeenCalled();
});

test("local latest comes from the NF descriptor rather than an installed higher/lower package", () => {
	const load = mock(async () => ({ bytes: new Uint8Array([1]), sha256: "a".repeat(64) }));
	const catalog = new BuiltinPluginCatalog({
		descriptors: [{ pluginId: ID, version: "1.0.4", load }],
	});
	for (const installedVersion of ["1.0.2", "2.0.0", null]) {
		const [summary] = catalog.list(
			new Map([
				[ID, installedVersion],
				["com.external.plugin", "9.0.0"],
			]),
		);
		expect(summary).toMatchObject({
			version: "1.0.4",
			installed: true,
			installedVersion,
			canInstall: false,
		});
		expect(catalog.get(ID)?.version).toBe("1.0.4");
	}
	expect(load).not.toHaveBeenCalled();
});

test("builtin loads retain descriptor cancellation and byte/hash semantics", async () => {
	const load = mock(async (signal?: AbortSignal) => {
		signal?.throwIfAborted();
		return { bytes: new Uint8Array([1, 2, 3]), sha256: "b".repeat(64) };
	});
	const catalog = new BuiltinPluginCatalog({
		descriptors: [{ pluginId: ID, version: "1.0.3", load }],
	});
	const definition = catalog.get(ID);
	if (!definition) throw new Error("Missing builtin definition");
	const controller = new AbortController();
	expect(await definition.load(controller.signal)).toEqual({
		bytes: new Uint8Array([1, 2, 3]),
		sha256: "b".repeat(64),
	});
	expect(load).toHaveBeenCalledWith(controller.signal);
	controller.abort(new Error("cancel builtin archive"));
	await expect(definition.load(controller.signal)).rejects.toThrow("cancel builtin archive");
});

test("the default host registry exposes only the current pinned quota descriptor", () => {
	expect(builtinPluginCatalog.list()).toHaveLength(1);
	expect(builtinPluginCatalog.get(ID)?.version).toBe("1.0.3");
	expect(builtinPluginCatalog.get("com.narrafork.apikey-quota")).toBeUndefined();
});

test("duplicate/invalid build-owned descriptors fail instead of selecting an arbitrary archive", () => {
	const load = async () => ({ bytes: new Uint8Array([1]), sha256: "a".repeat(64) });
	expect(
		() =>
			new BuiltinPluginCatalog({
				descriptors: [
					{ pluginId: ID, version: "1.0.3", load },
					{ pluginId: ID, version: "1.0.4", load },
				],
			}),
	).toThrow("Duplicate");
	expect(
		() => new BuiltinPluginCatalog({ descriptors: [{ pluginId: ID, version: "latest", load }] }),
	).toThrow("version");
});
