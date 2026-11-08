import type { AutoModelInfo } from "@shared/auto-model";

/**
 * The `auto:` models that would be left without a source if `prefix` stopped joining auto.
 *
 * `models` is the server's current list, which already leaves out saved exclusions, so a model
 * whose only source is `prefix` is exactly one this switch would strand. Sessions and settings
 * that use such a model fail with AUTO_MODEL_UNAVAILABLE until a source joins again.
 */
export function autoModelsOnlyServedBy(
	models: readonly AutoModelInfo[],
	prefix: string,
): AutoModelInfo[] {
	return models.filter(
		(model) =>
			model.sources.length > 0 && model.sources.every((source) => source.provider === prefix),
	);
}

/** How many `auto:` models this provider is a source of. */
export function autoModelCountFor(models: readonly AutoModelInfo[], prefix: string): number {
	return models.filter((model) => model.sources.some((source) => source.provider === prefix))
		.length;
}
