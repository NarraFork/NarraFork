import type { BuiltinPluginSummary, LocalPluginSource } from "@shared/plugin-source";
import { type BundledPluginDescriptor, getBundledPluginDescriptors } from "./bundled-plugin-assets";

export const PROVIDER_QUOTA_BUILTIN_ID = "io.narrafork.provider-quota";

const definitions = Object.freeze({
	[PROVIDER_QUOTA_BUILTIN_ID]: Object.freeze({
		displayName: "Provider Quota",
		description:
			"Bounded Custom API allowance queries through credential-free Host API connections.",
	}),
});

export interface BuiltinPluginDefinition extends BundledPluginDescriptor {
	displayName: string;
	description?: string;
	source: LocalPluginSource;
}

export interface BuiltinPluginCatalogOptions {
	/** Build-owned descriptors; tests may inject their own descriptor reader without disk scans. */
	descriptors?: readonly BundledPluginDescriptor[];
}

/** A trusted distribution registry, not a second runtime or a scan of installed/foreign packages. */
export class BuiltinPluginCatalog {
	private readonly entries = new Map<string, BuiltinPluginDefinition>();

	constructor(options: BuiltinPluginCatalogOptions = {}) {
		for (const descriptor of options.descriptors ?? getBundledPluginDescriptors()) {
			if (descriptor.pluginId !== PROVIDER_QUOTA_BUILTIN_ID) continue;
			if (this.entries.has(descriptor.pluginId))
				throw new Error("Duplicate builtin plugin descriptor");
			if (
				descriptor.version.length > 128 ||
				!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
					descriptor.version,
				)
			) {
				throw new Error("Invalid builtin plugin descriptor version");
			}
			const source: LocalPluginSource = Object.freeze({
				type: "local",
				builtinId: descriptor.pluginId,
			});
			this.entries.set(
				descriptor.pluginId,
				Object.freeze({
					pluginId: descriptor.pluginId,
					version: descriptor.version,
					...definitions[PROVIDER_QUOTA_BUILTIN_ID],
					source,
					// The embedded descriptor owns bounded reading, SHA validation, cancellation and
					// its single-flight byte cache. Enumeration never invokes this loader.
					load: (signal?: AbortSignal) => descriptor.load(signal),
				}),
			);
		}
	}

	get(pluginId: string): BuiltinPluginDefinition | undefined {
		return this.entries.get(pluginId);
	}

	list(
		installedVersions: ReadonlyMap<string, string | null> = new Map(),
	): readonly BuiltinPluginSummary[] {
		return Object.freeze(
			[...this.entries.values()].map((entry) =>
				Object.freeze({
					pluginId: entry.pluginId,
					displayName: entry.displayName,
					description: entry.description,
					version: entry.version,
					source: entry.source,
					installed: installedVersions.has(entry.pluginId),
					installedVersion: installedVersions.get(entry.pluginId) ?? null,
					canInstall: !installedVersions.has(entry.pluginId),
				}),
			),
		);
	}
}

export const builtinPluginCatalog = new BuiltinPluginCatalog();
