/**
 * Registry of externally-supplied search channels.
 *
 * The search layer knows five channel kinds and switches over them exhaustively. Adding a
 * sixth for plugins would have meant `lib/search` importing `services/plugin-*`, which puts a
 * leaf module downstream of the whole plugin platform. Instead this file holds a registry the
 * platform pushes into, mirroring `registerExtraModelSource()` in `lib/settings/provider.ts`
 * — the same problem (a host surface that must enumerate plugin contributions without
 * depending on them) already solved once.
 *
 * ## The synchronous constraint is load-bearing
 *
 * `listChannels()` runs on a hot path. `getNormalizedSearchChannels()` is called on every
 * tool execution and every provider request-body build, which is why that function goes out
 * of its way to avoid `structuredClone`-ing the whole settings object. So enumeration must be
 * an in-memory read: no RPC, no plugin activation, no awaiting. Availability is decided from
 * already-loaded state, which is why a plugin declares `requiresConfig` in its manifest
 * instead of being asked whether it is usable.
 *
 * `execute()` is the only async half, and it only runs when a search is actually dispatched.
 */

import type { SearchChannelResult, SearchRequest } from "./types";

/** One channel a source offers, as the search layer sees it. */
export interface ExtraSearchChannel {
	/** Stable channel id. Must survive restarts: user channel order is saved against it. */
	id: string;
	/** Display label, resolved by the source (it owns the plugin/contribution names). */
	label: string;
	/**
	 * Whether this channel can be dispatched right now.
	 *
	 * A source computes this synchronously from config presence and runtime state. It cannot
	 * mean "the credential is valid" — an invalid credential yields an available channel that
	 * fails at execution, after which the router falls through. Built-in `custom-api`
	 * channels behave the same way.
	 */
	available: boolean;
	/** Per-channel timeout the source declares; the router still applies its own ceiling. */
	timeoutMs?: number;
}

export interface ExtraSearchChannelSource {
	/** Must be synchronous and side-effect free. See the module header. */
	listChannels(): ExtraSearchChannel[];
	execute(
		channelId: string,
		request: SearchRequest,
		signal: AbortSignal,
	): Promise<SearchChannelResult>;
}

const extraSearchChannelSources = new Map<string, ExtraSearchChannelSource>();

/**
 * Register (or replace) a named search channel source.
 *
 * Returns a disposer so a subsystem can withdraw its channels on shutdown. Registering the
 * same name twice replaces rather than stacks, keeping repeated wiring idempotent.
 *
 * Registering does NOT make enumeration authoritative — see
 * {@link areExtraSearchChannelsReady}: a source is wired up before it has anything to report.
 */
export function registerExtraSearchChannelSource(
	name: string,
	source: ExtraSearchChannelSource,
): () => void {
	extraSearchChannelSources.set(name, source);
	return () => {
		if (extraSearchChannelSources.get(name) === source) extraSearchChannelSources.delete(name);
	};
}

/**
 * Whether enumeration is complete enough that "not in the catalog" means "gone".
 *
 * Two distinct moments make a saved `plugin:` channel absent from the catalog for reasons that
 * have nothing to do with the plugin:
 *
 * 1. `settings` is built during module load (`export const settings = loadSettings()`), before
 *    the plugin platform module has even registered its source.
 * 2. The source is registered when the platform graph is constructed, but the registry it reads
 *    stays empty until `PluginContributionCoordinator` has reconciled the installed catalog —
 *    an async step that finishes well after startup.
 *
 * In both windows `mergeChannels` must keep a saved entry, because dropping it discards the
 * user's enabled flag and fallback position and — since `normalizeSearchSettings` reports a
 * change — persists that loss to disk. Only after the first reconcile does absence become
 * authoritative, which is why this is flipped by {@link markExtraSearchChannelsReady} rather
 * than by registration.
 *
 * A deployment with the plugin platform disabled never flips it, so saved plugin channels simply
 * persist untouched. That is the safe direction: with no registration they report unavailable and
 * are never dispatched (see the `plugin` case in `isPotentiallyUsableFunctionChannel`).
 */
let channelsReady = false;

export function areExtraSearchChannelsReady(): boolean {
	return channelsReady;
}

/**
 * Declare that every source has finished loading its contributions.
 *
 * Called once the plugin contribution catalog has been reconciled. From this point a saved
 * plugin channel with no catalog entry is genuinely uninstalled and gets pruned.
 */
export function markExtraSearchChannelsReady(): void {
	channelsReady = true;
}

/** Test seam: drop every registered source and reset readiness. */
export function clearExtraSearchChannelSources(): void {
	extraSearchChannelSources.clear();
	channelsReady = false;
}

/**
 * Every channel offered by every source.
 *
 * A source that throws is skipped rather than allowed to blank out the channel list — the
 * same defence `listExtraModels()` applies, and for the same reason: this feeds the catalog
 * that decides whether web search is available at all.
 */
export function listExtraSearchChannels(): ExtraSearchChannel[] {
	const channels: ExtraSearchChannel[] = [];
	for (const source of extraSearchChannelSources.values()) {
		try {
			channels.push(...source.listChannels());
		} catch {
			// Skip this source; a broken one must not hide the others.
		}
	}
	return channels;
}

export function findExtraSearchChannel(channelId: string): ExtraSearchChannel | undefined {
	return listExtraSearchChannels().find((channel) => channel.id === channelId);
}

/** Dispatch to whichever source owns this channel id. */
export async function executeExtraSearchChannel(
	channelId: string,
	request: SearchRequest,
	signal: AbortSignal,
): Promise<SearchChannelResult> {
	for (const source of extraSearchChannelSources.values()) {
		let owns = false;
		try {
			owns = source.listChannels().some((channel) => channel.id === channelId);
		} catch {
			continue;
		}
		if (owns) return source.execute(channelId, request, signal);
	}
	throw new Error(`No registered source owns search channel: ${channelId}`);
}
