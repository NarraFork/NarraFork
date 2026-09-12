import {
	buildAggModelValue,
	FOLLOW_DEFAULT_MODEL,
	type ModelAggregation,
	parseAggModelValue,
} from "../../../lib/constants";

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
