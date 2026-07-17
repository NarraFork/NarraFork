import {
	getContributionFullId,
	isContributionId,
	isPluginId,
	parseActivationEvent,
} from "../lib/plugins/manifest";
import { PUBLIC_EVENT_TOPICS } from "../lib/plugins/protocol";
import type {
	PluginCatalogPlugin,
	PluginCatalogSnapshot,
	PluginContributionSummary,
	PluginDiagnostic,
	PluginPackageSummary,
} from "./plugin-catalog";

export type PluginContributionKind = PluginContributionSummary["kind"];
export type PluginContributionStatus = "available" | "unavailable";

export interface PluginContributionRegistryEntry {
	pluginId: string;
	version: string;
	hash: string;
	contributionId: string;
	fullId: string;
	kind: PluginContributionKind;
	descriptor: Readonly<PluginContributionSummary>;
	status: PluginContributionStatus;
	unavailableReason: string | undefined;
}

export interface PluginRegistryDiagnostic extends PluginDiagnostic {
	pluginId?: string;
	fullId?: string;
	activationEvent?: string;
}

export type ActivationEventKind =
	| "onStartup"
	| "onProvider"
	| "onTool"
	| "onCommand"
	| "onView"
	| "onEvent"
	| "onSchedule";

export interface PluginActivationTarget {
	activationEvent: string;
	canonicalEvent: string;
	kind: ActivationEventKind;
	pluginId: string;
	version: string;
	hash: string;
	contributionId: string | undefined;
	fullId: string | undefined;
	contributionKind: PluginContributionKind | "schedule" | undefined;
}

export interface ActivationIndexEntry {
	event: string;
	targets: PluginActivationTarget[];
}

const PUBLIC_EVENT_TOPIC_SET = new Set<string>(PUBLIC_EVENT_TOPICS);

function contributionSort(
	a: Pick<PluginContributionRegistryEntry, "fullId" | "kind">,
	b: Pick<PluginContributionRegistryEntry, "fullId" | "kind">,
): number {
	return a.fullId.localeCompare(b.fullId) || a.kind.localeCompare(b.kind);
}

function activationTargetSort(a: PluginActivationTarget, b: PluginActivationTarget): number {
	return (
		a.pluginId.localeCompare(b.pluginId) ||
		(a.fullId ?? "").localeCompare(b.fullId ?? "") ||
		a.activationEvent.localeCompare(b.activationEvent) ||
		a.kind.localeCompare(b.kind)
	);
}

function diagnosticSort(a: PluginRegistryDiagnostic, b: PluginRegistryDiagnostic): number {
	return (
		(a.pluginId ?? "").localeCompare(b.pluginId ?? "") ||
		(a.fullId ?? "").localeCompare(b.fullId ?? "") ||
		(a.activationEvent ?? "").localeCompare(b.activationEvent ?? "") ||
		a.code.localeCompare(b.code) ||
		a.message.localeCompare(b.message)
	);
}

function currentPackage(
	snapshot: PluginCatalogSnapshot,
	plugin: PluginCatalogPlugin,
): PluginPackageSummary | undefined {
	if (plugin.current) {
		return (
			plugin.packages.find(
				(item) => item.version === plugin.current?.version && item.hash === plugin.current?.hash,
			) ??
			snapshot.packages.find(
				(item) =>
					item.pluginId === plugin.pluginId &&
					item.version === plugin.current?.version &&
					item.hash === plugin.current?.hash,
			)
		);
	}
	return (
		plugin.packages.find((item) => item.isCurrent) ??
		snapshot.packages.find((item) => item.pluginId === plugin.pluginId && item.isCurrent)
	);
}

function unavailableReason(packageSummary: PluginPackageSummary): string {
	const details = packageSummary.diagnostics
		.map((item) => item.message)
		.filter(Boolean)
		.join("; ");
	if (details) return details;
	return `Plugin package is ${packageSummary.status}`;
}

function cloneDiagnostic(
	diagnostic: PluginDiagnostic,
	pluginId?: string,
): PluginRegistryDiagnostic {
	return pluginId ? { ...diagnostic, pluginId } : { ...diagnostic };
}

function freezeDescriptor(
	descriptor: PluginContributionSummary,
): Readonly<PluginContributionSummary> {
	return Object.freeze({ ...descriptor });
}

function freezeRegistryEntry(
	entry: PluginContributionRegistryEntry,
): PluginContributionRegistryEntry {
	return Object.freeze(entry);
}

function freezeActivationTarget(target: PluginActivationTarget): PluginActivationTarget {
	return Object.freeze(target);
}

function contributionIdentityIsValid(
	plugin: PluginCatalogPlugin,
	packageSummary: PluginPackageSummary,
	contribution: PluginContributionSummary,
): boolean {
	return (
		isPluginId(contribution.pluginId) &&
		isContributionId(contribution.id) &&
		contribution.pluginId === plugin.pluginId &&
		contribution.version === packageSummary.version &&
		contribution.hash === packageSummary.hash &&
		contribution.fullId === getContributionFullId(plugin.pluginId, contribution.id)
	);
}

function makeRegistryEntry(
	contribution: PluginContributionSummary,
	status: PluginContributionStatus,
	reason: string | undefined,
): PluginContributionRegistryEntry {
	return freezeRegistryEntry({
		pluginId: contribution.pluginId,
		version: contribution.version,
		hash: contribution.hash,
		contributionId: contribution.id,
		fullId: contribution.fullId,
		kind: contribution.kind,
		descriptor: freezeDescriptor(contribution),
		status,
		unavailableReason: reason,
	});
}

/**
 * Host-owned registry of statically declared plugin contributions.
 *
 * Refreshing only consumes PluginCatalog metadata. It never imports an entry point or starts a
 * plugin runtime.
 */
export class PluginContributionRegistry {
	private entries = new Map<string, PluginContributionRegistryEntry>();
	private diagnosticsValue: PluginRegistryDiagnostic[] = [];

	constructor(snapshot?: PluginCatalogSnapshot) {
		if (snapshot) this.refresh(snapshot);
	}

	get diagnostics(): PluginRegistryDiagnostic[] {
		return this.getDiagnostics();
	}

	refresh(snapshot: PluginCatalogSnapshot): PluginRegistryDiagnostic[] {
		const previousEntries = this.entries;
		const nextEntries = new Map<string, PluginContributionRegistryEntry>();
		const diagnostics: PluginRegistryDiagnostic[] = snapshot.diagnostics.map((item) =>
			cloneDiagnostic(item),
		);
		const encounteredPlugins = new Set<string>();

		for (const plugin of [...snapshot.plugins].sort((a, b) =>
			a.pluginId.localeCompare(b.pluginId),
		)) {
			encounteredPlugins.add(plugin.pluginId);
			if (!isPluginId(plugin.pluginId)) {
				diagnostics.push({
					code: "REGISTRY_PLUGIN_ID_INVALID",
					message: `Invalid plugin ID in catalog: ${plugin.pluginId}`,
					pluginId: plugin.pluginId,
				});
				continue;
			}

			const packageSummary = currentPackage(snapshot, plugin);
			if (!packageSummary) {
				diagnostics.push(
					...plugin.diagnostics.map((item) => cloneDiagnostic(item, plugin.pluginId)),
				);
				diagnostics.push({
					code: "REGISTRY_CURRENT_PACKAGE_MISSING",
					message: "Plugin has no readable current package",
					pluginId: plugin.pluginId,
				});
				this.retainUnavailableEntries(
					previousEntries,
					nextEntries,
					plugin.pluginId,
					"Plugin current package is missing",
				);
				continue;
			}

			diagnostics.push(
				...packageSummary.diagnostics.map((item) => cloneDiagnostic(item, plugin.pluginId)),
			);
			const packageAvailable = packageSummary.status === "compatible";
			const packageUnavailableReason = packageAvailable
				? undefined
				: unavailableReason(packageSummary);
			if (!packageAvailable) {
				diagnostics.push({
					code: "REGISTRY_PACKAGE_UNAVAILABLE",
					message: `Current plugin package is ${packageSummary.status}`,
					pluginId: plugin.pluginId,
				});
			}

			const contributions = [...packageSummary.contributions].sort((a, b) =>
				contributionSort({ fullId: a.fullId, kind: a.kind }, { fullId: b.fullId, kind: b.kind }),
			);
			for (const contribution of contributions) {
				if (!contributionIdentityIsValid(plugin, packageSummary, contribution)) {
					diagnostics.push({
						code: "CONTRIBUTION_IDENTITY_INVALID",
						message: "Contribution identity does not match its current plugin package",
						pluginId: plugin.pluginId,
						fullId: contribution.fullId,
					});
					continue;
				}
				if (nextEntries.has(contribution.fullId)) {
					diagnostics.push({
						code: "CONTRIBUTION_FULL_ID_CONFLICT",
						message: `Duplicate contribution fullId rejected: ${contribution.fullId}`,
						pluginId: plugin.pluginId,
						fullId: contribution.fullId,
					});
					continue;
				}

				const previous = previousEntries.get(contribution.fullId);
				const preserveUnavailable =
					packageAvailable &&
					previous?.version === contribution.version &&
					previous.hash === contribution.hash &&
					previous.status === "unavailable";
				nextEntries.set(
					contribution.fullId,
					makeRegistryEntry(
						contribution,
						packageAvailable && !preserveUnavailable ? "available" : "unavailable",
						preserveUnavailable ? previous.unavailableReason : packageUnavailableReason,
					),
				);
			}

			if (!packageAvailable && contributions.length === 0) {
				this.retainUnavailableEntries(
					previousEntries,
					nextEntries,
					plugin.pluginId,
					packageUnavailableReason ?? "Plugin package is unavailable",
				);
			}
		}

		for (const entry of previousEntries.values()) {
			if (encounteredPlugins.has(entry.pluginId)) continue;
			diagnostics.push({
				code: "REGISTRY_PLUGIN_REMOVED_FROM_CATALOG",
				message: "Plugin is no longer present in the catalog",
				pluginId: entry.pluginId,
				fullId: entry.fullId,
			});
		}

		this.entries = nextEntries;
		this.diagnosticsValue = diagnostics.sort(diagnosticSort);
		return this.getDiagnostics();
	}

	get(fullId: string): PluginContributionRegistryEntry | undefined {
		return this.entries.get(fullId);
	}

	list(): PluginContributionRegistryEntry[] {
		return [...this.entries.values()].sort(contributionSort);
	}

	listByKind(kind: PluginContributionKind): PluginContributionRegistryEntry[] {
		return this.list().filter((entry) => entry.kind === kind);
	}

	markUnavailable(fullIdOrPluginId: string, reason: string): boolean;
	markUnavailable(pluginId: string, contributionId: string, reason: string): boolean;
	markUnavailable(
		fullIdOrPluginId: string,
		contributionIdOrReason: string,
		maybeReason?: string,
	): boolean {
		const requestedFullId = maybeReason
			? getContributionFullId(fullIdOrPluginId, contributionIdOrReason)
			: fullIdOrPluginId;
		const normalizedReason =
			(maybeReason ?? contributionIdOrReason).trim() || "Plugin contribution is unavailable";
		let changed = false;
		for (const [fullId, entry] of this.entries) {
			if (fullId !== requestedFullId && entry.pluginId !== requestedFullId) continue;
			this.entries.set(
				fullId,
				freezeRegistryEntry({
					...entry,
					status: "unavailable",
					unavailableReason: normalizedReason,
				}),
			);
			changed = true;
		}
		return changed;
	}

	removePlugin(pluginId: string): number {
		let removed = 0;
		for (const [fullId, entry] of this.entries) {
			if (entry.pluginId !== pluginId) continue;
			this.entries.delete(fullId);
			removed += 1;
		}
		return removed;
	}

	getDiagnostics(): PluginRegistryDiagnostic[] {
		return this.diagnosticsValue.map((item) => ({ ...item }));
	}

	private retainUnavailableEntries(
		previousEntries: Map<string, PluginContributionRegistryEntry>,
		nextEntries: Map<string, PluginContributionRegistryEntry>,
		pluginId: string,
		reason: string,
	): void {
		for (const previous of previousEntries.values()) {
			if (previous.pluginId !== pluginId || nextEntries.has(previous.fullId)) continue;
			nextEntries.set(
				previous.fullId,
				freezeRegistryEntry({
					...previous,
					status: "unavailable",
					unavailableReason: reason,
				}),
			);
		}
	}
}

function containsControlCharacter(value: string): boolean {
	for (const character of value) {
		const codePoint = character.codePointAt(0) ?? 0;
		if (codePoint < 0x20 || codePoint === 0x7f) return true;
	}
	return false;
}

function normalizeContributionReference(
	pluginId: string,
	reference: string,
): { contributionId: string; fullId: string } | undefined {
	if (reference.length > 256 || containsControlCharacter(reference)) return undefined;
	if (reference.includes("/")) {
		const prefix = `${pluginId}/`;
		if (!reference.startsWith(prefix)) return undefined;
		const contributionId = reference.slice(prefix.length);
		if (!isContributionId(contributionId)) return undefined;
		return { contributionId, fullId: getContributionFullId(pluginId, contributionId) };
	}
	if (!isContributionId(reference)) return undefined;
	return { contributionId: reference, fullId: getContributionFullId(pluginId, reference) };
}

function targetIdentity(target: PluginActivationTarget): string {
	return [
		target.canonicalEvent,
		target.pluginId,
		target.fullId ?? "",
		target.contributionKind ?? "",
	].join("\u0000");
}

/** Static activation-event lookup built exclusively from catalog metadata. */
export class ActivationIndex {
	private targetsByEvent = new Map<string, PluginActivationTarget[]>();
	private targets = new Map<string, PluginActivationTarget>();
	private diagnosticsValue: PluginRegistryDiagnostic[] = [];

	constructor(snapshot?: PluginCatalogSnapshot) {
		if (snapshot) this.refresh(snapshot);
	}

	get diagnostics(): PluginRegistryDiagnostic[] {
		return this.getDiagnostics();
	}

	refresh(snapshot: PluginCatalogSnapshot): PluginRegistryDiagnostic[] {
		const aliases = new Map<string, Map<string, PluginActivationTarget>>();
		const targets = new Map<string, PluginActivationTarget>();
		const diagnostics: PluginRegistryDiagnostic[] = [];

		const addTarget = (target: PluginActivationTarget, aliasesForTarget: string[]): void => {
			const frozen = freezeActivationTarget(target);
			const identity = targetIdentity(frozen);
			targets.set(identity, frozen);
			for (const alias of new Set([
				target.activationEvent,
				target.canonicalEvent,
				...aliasesForTarget,
			])) {
				const eventTargets = aliases.get(alias) ?? new Map<string, PluginActivationTarget>();
				eventTargets.set(identity, frozen);
				aliases.set(alias, eventTargets);
			}
		};

		for (const plugin of [...snapshot.plugins].sort((a, b) =>
			a.pluginId.localeCompare(b.pluginId),
		)) {
			const packageSummary = currentPackage(snapshot, plugin);
			if (!packageSummary || packageSummary.status !== "compatible" || !packageSummary.manifest) {
				if (packageSummary && packageSummary.status !== "compatible") {
					diagnostics.push({
						code: "ACTIVATION_PACKAGE_UNAVAILABLE",
						message: `Activation events ignored for ${packageSummary.status} package`,
						pluginId: plugin.pluginId,
					});
				}
				continue;
			}

			const contributions = packageSummary.contributions.filter((contribution) =>
				contributionIdentityIsValid(plugin, packageSummary, contribution),
			);
			const contributionsByFullId = new Map(
				contributions.map((contribution) => [contribution.fullId, contribution]),
			);
			const activationEvents = packageSummary.manifest.activationEvents as unknown[];
			const activationEventSortKey = (value: unknown): string =>
				typeof value === "string" ? `string:${value}` : `invalid:${typeof value}`;
			for (const rawEvent of [...activationEvents].sort((a, b) =>
				activationEventSortKey(a).localeCompare(activationEventSortKey(b)),
			)) {
				if (typeof rawEvent !== "string" || rawEvent.length > 256) {
					diagnostics.push({
						code: "ACTIVATION_EVENT_INVALID",
						message: "Activation event must be a bounded string",
						pluginId: plugin.pluginId,
						activationEvent: typeof rawEvent === "string" ? rawEvent.slice(0, 256) : undefined,
					});
					continue;
				}

				const parsed = parseActivationEvent(rawEvent);
				if (!parsed) {
					diagnostics.push({
						code: "ACTIVATION_EVENT_UNKNOWN",
						message: `Unknown or malformed activation event: ${rawEvent}`,
						pluginId: plugin.pluginId,
						activationEvent: rawEvent,
					});
					continue;
				}

				if (parsed.kind === "onStartup") {
					addTarget(
						{
							activationEvent: rawEvent,
							canonicalEvent: "onStartup",
							kind: "onStartup",
							pluginId: plugin.pluginId,
							version: packageSummary.version,
							hash: packageSummary.hash,
							contributionId: undefined,
							fullId: undefined,
							contributionKind: undefined,
						},
						[],
					);
					continue;
				}

				if (parsed.kind === "onEvent") {
					if (!PUBLIC_EVENT_TOPIC_SET.has(parsed.reference)) {
						diagnostics.push({
							code: "ACTIVATION_EVENT_TOPIC_UNKNOWN",
							message: `Event topic is not part of the public event contract: ${parsed.reference}`,
							pluginId: plugin.pluginId,
							activationEvent: rawEvent,
						});
						continue;
					}
					const matchingEvents = contributions
						.filter(
							(contribution) =>
								contribution.kind === "event" && contribution.topic === parsed.reference,
						)
						.sort((a, b) => a.fullId.localeCompare(b.fullId));
					if (matchingEvents.length === 0) {
						diagnostics.push({
							code: "ACTIVATION_EVENT_TARGET_MISSING",
							message: `No declared event contribution handles ${parsed.reference}`,
							pluginId: plugin.pluginId,
							activationEvent: rawEvent,
						});
						continue;
					}
					for (const contribution of matchingEvents) {
						addTarget(
							{
								activationEvent: rawEvent,
								canonicalEvent: `onEvent:${parsed.reference}`,
								kind: "onEvent",
								pluginId: plugin.pluginId,
								version: packageSummary.version,
								hash: packageSummary.hash,
								contributionId: contribution.id,
								fullId: contribution.fullId,
								contributionKind: "event",
							},
							[],
						);
					}
					continue;
				}

				if (parsed.kind === "onSchedule") {
					if (!isContributionId(parsed.reference)) {
						diagnostics.push({
							code: "ACTIVATION_SCHEDULE_ID_INVALID",
							message: `Invalid schedule activation ID: ${parsed.reference}`,
							pluginId: plugin.pluginId,
							activationEvent: rawEvent,
						});
						continue;
					}
					const fullId = getContributionFullId(plugin.pluginId, parsed.reference);
					addTarget(
						{
							activationEvent: rawEvent,
							canonicalEvent: `onSchedule:${fullId}`,
							kind: "onSchedule",
							pluginId: plugin.pluginId,
							version: packageSummary.version,
							hash: packageSummary.hash,
							contributionId: parsed.reference,
							fullId,
							contributionKind: "schedule",
						},
						[`onSchedule:${parsed.reference}`],
					);
					continue;
				}

				const normalized = normalizeContributionReference(plugin.pluginId, parsed.reference);
				const expectedKind: Record<
					"onProvider" | "onTool" | "onCommand" | "onView",
					PluginContributionKind
				> = {
					onProvider: "provider",
					onTool: "tool",
					onCommand: "command",
					onView: "view",
				};
				if (!normalized) {
					diagnostics.push({
						code: "ACTIVATION_REFERENCE_INVALID",
						message: `Invalid or foreign activation reference: ${parsed.reference}`,
						pluginId: plugin.pluginId,
						activationEvent: rawEvent,
					});
					continue;
				}
				const contribution = contributionsByFullId.get(normalized.fullId);
				if (!contribution || contribution.kind !== expectedKind[parsed.kind]) {
					diagnostics.push({
						code: "ACTIVATION_EVENT_TARGET_MISSING",
						message: `Activation event does not reference a declared ${expectedKind[parsed.kind]}`,
						pluginId: plugin.pluginId,
						fullId: normalized.fullId,
						activationEvent: rawEvent,
					});
					continue;
				}
				const canonicalEvent = `${parsed.kind}:${normalized.fullId}`;
				addTarget(
					{
						activationEvent: rawEvent,
						canonicalEvent,
						kind: parsed.kind,
						pluginId: plugin.pluginId,
						version: packageSummary.version,
						hash: packageSummary.hash,
						contributionId: normalized.contributionId,
						fullId: normalized.fullId,
						contributionKind: contribution.kind,
					},
					[`${parsed.kind}:${normalized.contributionId}`],
				);
			}
		}

		this.targets = targets;
		this.targetsByEvent = new Map(
			[...aliases.entries()]
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([event, eventTargets]) => [
					event,
					[...eventTargets.values()].sort(activationTargetSort),
				]),
		);
		this.diagnosticsValue = diagnostics.sort(diagnosticSort);
		return this.getDiagnostics();
	}

	get(event: string): PluginActivationTarget[] {
		return [...(this.targetsByEvent.get(event) ?? [])];
	}

	resolve(event: string): PluginActivationTarget[] {
		return this.get(event);
	}

	listByEvent(event: string): PluginActivationTarget[] {
		return this.get(event);
	}

	list(): ActivationIndexEntry[] {
		return [...this.targetsByEvent.entries()].map(([event, targets]) => ({
			event,
			targets: [...targets],
		}));
	}

	listTargets(): PluginActivationTarget[] {
		return [...this.targets.values()].sort(activationTargetSort);
	}

	removePlugin(pluginId: string): number {
		let removed = 0;
		for (const [identity, target] of this.targets) {
			if (target.pluginId !== pluginId) continue;
			this.targets.delete(identity);
			removed += 1;
		}
		for (const [event, targets] of this.targetsByEvent) {
			const retained = targets.filter((target) => target.pluginId !== pluginId);
			if (retained.length === 0) this.targetsByEvent.delete(event);
			else this.targetsByEvent.set(event, retained);
		}
		return removed;
	}

	getDiagnostics(): PluginRegistryDiagnostic[] {
		return this.diagnosticsValue.map((item) => ({ ...item }));
	}
}

export const ContributionRegistry = PluginContributionRegistry;
