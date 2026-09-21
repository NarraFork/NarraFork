import {
	buildAggModelValue,
	FOLLOW_DEFAULT_MODEL,
	FOLLOW_SUMMARY_MODEL,
	type ModelAggregation,
	parseAggModelValue,
} from "../../../lib/constants";

/**
 * Whether a model-menu entry may be written into the instance-wide default or
 * summary model slots. Meta sentinels are excluded: assigning "follow default"
 * as the default model (or "follow summary" as either slot) creates a circular
 * definition the resolver cannot break.
 *
 * Concretely selectable models and aggregation roots are allowed; indented
 * aggregation members are not menu entries with their own roles — selecting one
 * pins that member on the narrator session instead.
 */
export function canAssignGlobalModelRole(value: string | null | undefined): boolean {
	if (!value) return false;
	return value !== FOLLOW_DEFAULT_MODEL && value !== FOLLOW_SUMMARY_MODEL;
}

export function modelMenuSelection(
	currentModel: string | null | undefined,
	aggregations: ModelAggregation[],
) {
	const value = currentModel || FOLLOW_DEFAULT_MODEL;
	const parsed = parseAggModelValue(value);
	const aggregation = parsed ? aggregations.find((item) => item.id === parsed.aggId) : undefined;
	const members = aggregation?.models ?? [];
	const baseValue = parsed ? buildAggModelValue(parsed.aggId) : value;
	return {
		value,
		baseValue,
		members,
		// A removed pinned member still leaves its aggregation visible.
		targetValue: parsed?.pinnedModel && !members.includes(parsed.pinnedModel) ? baseValue : value,
	};
}

/** Scroll only the dropdown, leaving the page and message list untouched. */
export function centerModelMenuSelection(
	container: HTMLElement,
	item: HTMLElement,
	footerHeight: number,
) {
	const viewport = container.getBoundingClientRect();
	const row = item.getBoundingClientRect();
	const visibleHeight = Math.max(0, container.clientHeight - footerHeight);
	container.scrollTop = Math.max(
		0,
		Math.min(
			container.scrollHeight - container.clientHeight,
			container.scrollTop +
				row.top -
				viewport.top -
				container.clientTop -
				(visibleHeight - row.height) / 2,
		),
	);
}
