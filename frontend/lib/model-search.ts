import type {
	ComboboxItem,
	ComboboxParsedItem,
	ComboboxParsedItemGroup,
	OptionsFilter,
} from "@mantine/core";
import {
	AGG_MODEL_PREFIX,
	FOLLOW_DEFAULT_MODEL,
	FOLLOW_PARENT_MODEL,
	FOLLOW_SUMMARY_MODEL,
	isAutoModelOptionValue,
} from "./constants";

/**
 * One matching rule for every model picker.
 *
 * Mantine's default Select filter only looks at `item.label`. Model pickers put
 * the provider in the group header and the `prefix:model` id in the value, so a
 * user typing a provider's display name, its prefix, or a model id whose label
 * differs (Gemini display names, NUG `channel · name`) found nothing. Pickers
 * that patched this by baking text into the label each covered a different
 * subset, which is why some pickers could search a provider and others could not.
 */

/**
 * Provider prefix of a concrete `provider:model` value.
 *
 * Returns null for empty values and meta sentinels (aggregations, follow-*),
 * which have no single provider.
 */
export function modelProviderPrefix(value: string | null | undefined): string | null {
	if (!value || value.startsWith(AGG_MODEL_PREFIX) || isAutoModelOptionValue(value)) return null;
	if (
		value === FOLLOW_DEFAULT_MODEL ||
		value === FOLLOW_SUMMARY_MODEL ||
		value === FOLLOW_PARENT_MODEL
	) {
		return null;
	}
	const idx = value.indexOf(":");
	return idx > 0 ? value.slice(0, idx) : null;
}

/** The fields of a model option that a search may match. */
export interface ModelSearchOption {
	value: string;
	label: string;
	/** Group header the option is listed under, usually the provider display name. */
	group?: string;
	provider?: string;
	channel?: string;
	bareModel?: string;
	family?: string;
	rateMultiplier?: number;
	/** Auto rows also match the concrete services that can serve the model. */
	autoSources?: readonly { value: string; provider: string }[];
}

export interface ModelSearchContext {
	/** Provider prefix → display name. */
	providerLabels?: Record<string, string>;
	/** What the "follow default" row resolves to, so it matches by its real model. */
	defaultModelValue?: string | null;
	/** What the "follow summary" row resolves to. */
	summaryModelValue?: string | null;
	/** Additional searchable text for a value (e.g. a catalog variant's provider key). */
	extraText?: (value: string) => string | null | undefined;
}

function providerLabel(
	labels: Record<string, string> | undefined,
	prefix: string | null | undefined,
): string | undefined {
	if (!labels || !prefix || !Object.hasOwn(labels, prefix)) return undefined;
	const label = labels[prefix];
	return typeof label === "string" ? label : undefined;
}

function roleTargetValue(value: string, ctx: ModelSearchContext): string | null | undefined {
	if (value !== FOLLOW_DEFAULT_MODEL && value !== FOLLOW_SUMMARY_MODEL) return null;
	const visited = new Set<string>();
	let target: string | null | undefined = value;
	while (target === FOLLOW_DEFAULT_MODEL || target === FOLLOW_SUMMARY_MODEL) {
		if (visited.has(target)) return null;
		visited.add(target);
		target = target === FOLLOW_DEFAULT_MODEL ? ctx.defaultModelValue : ctx.summaryModelValue;
	}
	return target;
}

/**
 * Lowercased text a query is matched against: group header, label, value,
 * provider prefix and its display name, bare model, channel and rate. The
 * follow-default/summary rows also carry their target model, its prefix and its
 * display name, because they sit under a role header instead of a provider group.
 */
export function modelSearchText(option: ModelSearchOption, ctx: ModelSearchContext = {}): string {
	const labels = ctx.providerLabels;
	const prefix = modelProviderPrefix(option.value);
	const parts: Array<string | null | undefined> = [
		option.group,
		option.label,
		option.value,
		option.provider,
		providerLabel(labels, option.provider),
		prefix,
		prefix === option.provider ? undefined : providerLabel(labels, prefix),
		option.bareModel,
		option.family,
		option.channel,
		option.rateMultiplier != null ? String(option.rateMultiplier) : undefined,
		option.rateMultiplier != null ? `×${option.rateMultiplier}` : undefined,
		...(option.autoSources ?? []).flatMap((source) => [
			source.value,
			providerLabel(labels, source.provider) ?? source.provider,
		]),
	];
	const target = roleTargetValue(option.value, ctx);
	if (target) {
		const targetPrefix = modelProviderPrefix(target);
		parts.push(target, targetPrefix, providerLabel(labels, targetPrefix));
	}
	const extra = ctx.extraText?.(option.value);
	if (extra) parts.push(extra);
	return parts
		.filter((part): part is string => !!part)
		.join(" ")
		.toLowerCase();
}

/**
 * Cache metadata independently of the display data supplied to a picker. Mantine's
 * grouped DTOs retain only value/label, so bare ids, families and auto sources must
 * be recovered by value. Build a new index when the catalog or context changes.
 */
export function createModelSearchIndex(
	models: readonly ModelSearchOption[],
	ctx: ModelSearchContext = {},
): ReadonlyMap<string, string> {
	const base = new Map<string, string>();
	for (const model of models) {
		const text = modelSearchText(model, ctx);
		const existing = base.get(model.value);
		base.set(model.value, existing ? `${existing} ${text}` : text);
	}
	const index = new Map(base);
	for (const model of models) {
		const target = roleTargetValue(model.value, ctx);
		const targetText = target ? base.get(target) : undefined;
		if (targetText) index.set(model.value, `${base.get(model.value) ?? ""} ${targetText}`);
	}
	return index;
}

function queryTerms(query: string): string[] {
	return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

function matchesTerms(text: string, terms: readonly string[]): boolean {
	return terms.every((term) => text.includes(term));
}

/** Compile the whitespace-separated AND query once per filter operation. */
export function createModelQueryMatcher(query: string): (text: string) => boolean {
	const terms = queryTerms(query);
	return (text) => matchesTerms(text, terms);
}

/** Match every query term against lowercase text, as returned by modelSearchText. */
export function matchesModelQuery(text: string, query: string): boolean {
	return createModelQueryMatcher(query)(text);
}

function isGroup(item: ComboboxParsedItem<string>): item is ComboboxParsedItemGroup<string> {
	return "group" in item;
}

/** Group headers are ReactNode in Mantine's types; only text can be searched. */
function groupText(group: unknown): string | undefined {
	if (typeof group === "string") return group;
	if (typeof group === "number") return String(group);
	return undefined;
}

/**
 * Mantine-compatible filter for model Select / MultiSelect / Autocomplete.
 *
 * Metadata enriches existing options by value; it never adds a hidden or disabled
 * catalog entry to the supplied list. `limit` retains Mantine's grouped budget,
 * and groups left without matches are dropped instead of leaving bare headers.
 */
export function createModelOptionsFilter(
	ctx: ModelSearchContext = {},
	models: readonly ModelSearchOption[] = [],
): OptionsFilter<string> {
	const index = createModelSearchIndex(models, ctx);
	const matches = (
		item: ComboboxItem<string>,
		group: string | undefined,
		matchesQuery: (text: string) => boolean,
	): boolean => {
		const target = roleTargetValue(item.value, ctx);
		const indexed = index.get(item.value) ?? (target ? index.get(target) : undefined);
		return matchesQuery(`${modelSearchText({ ...item, group }, ctx)} ${indexed ?? ""}`);
	};
	return ({ options, search, limit }) => {
		const hasQuery = search.trim().length > 0;
		const matchesQuery = createModelQueryMatcher(search);
		const result: ComboboxParsedItem<string>[] = [];
		for (const item of options) {
			if (result.length >= limit) break;
			if (!isGroup(item)) {
				if (!hasQuery || matches(item, undefined, matchesQuery)) result.push(item);
				continue;
			}
			const room = limit - result.length;
			const group = groupText(item.group);
			const items: ComboboxItem<string>[] = [];
			for (const child of item.items) {
				if (items.length >= room) break;
				if (!hasQuery || matches(child, group, matchesQuery)) items.push(child);
			}
			if (items.length > 0) result.push({ group: item.group, items });
		}
		return result;
	};
}

/** For pickers without settings context: still matches group header, value and prefix. */
export const defaultModelOptionsFilter = createModelOptionsFilter();

/**
 * Display text for a bare provider prefix option (log filters list prefixes
 * only): "Display name · prefix", or just the prefix when no display name is
 * known (e.g. a deleted provider) or it adds nothing.
 */
export function providerPrefixDisplay(
	prefix: string,
	providerLabels: Record<string, string> | undefined,
): string {
	const name = providerLabel(providerLabels, prefix);
	return name && name.toLowerCase() !== prefix.toLowerCase() ? `${name} · ${prefix}` : prefix;
}

/** Filter for bare provider prefix options that also matches the provider display name. */
export function createProviderPrefixOptionsFilter(
	providerLabels: Record<string, string> | undefined,
): OptionsFilter<string> {
	return createModelOptionsFilter({
		extraText: (value) => providerLabel(providerLabels, value),
	});
}
