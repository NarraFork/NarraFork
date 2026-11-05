import { notifications } from "@mantine/notifications";
import type { ImportRefreshTarget, ProviderImportEntry } from "@shared/provider-import";
import type { TFunction } from "i18next";
import { api } from "../../lib/api";

export interface RefreshOutcome {
	name: string;
	/** Models listed; absent when the refresh failed. */
	count?: number;
	error?: string;
}

/** The saved provider supplies the display name and protocol; refresh targets only contain IDs. */
export interface RefreshableProvider {
	id: string;
	name: string;
	protocol: ProviderImportEntry["protocol"];
}

/**
 * Refresh models for providers that just received a key (import or replacement), one at a
 * time so a slow gateway does not get a burst. Failures are collected, not thrown:
 * the providers are already saved and a refresh can be retried from settings.
 */
export async function refreshImportedModels(
	targets: readonly ImportRefreshTarget[],
	providers: readonly RefreshableProvider[],
	t: TFunction,
): Promise<RefreshOutcome[]> {
	const outcomes: RefreshOutcome[] = [];
	const providersById = new Map(providers.map((provider) => [provider.id, provider]));
	for (const target of targets) {
		const provider = providersById.get(target.providerId);
		if (!provider) {
			outcomes.push({
				name: target.providerId,
				error: t("providerImportRefreshProviderMissing"),
			});
			continue;
		}
		try {
			const result =
				provider.protocol === "gemini-compatible"
					? await api.geminiRefreshProviderModels(provider.id)
					: provider.protocol === "anthropic-messages"
						? await api.anthropicRefreshProviderModels(provider.id)
						: await api.openaiRefreshProviderModels(provider.id);
			outcomes.push({ name: provider.name, count: result.models.length });
		} catch (err) {
			outcomes.push({
				name: provider.name,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
	return outcomes;
}

/** One line per provider; failures stay on screen until dismissed. */
export function showRefreshOutcomes(t: TFunction, outcomes: readonly RefreshOutcome[]) {
	if (outcomes.length === 0) return;
	const failed = outcomes.filter((outcome) => outcome.error !== undefined);
	const succeeded = outcomes.filter((outcome) => outcome.error === undefined);
	if (succeeded.length > 0) {
		notifications.show({
			color: "green",
			title: t("modelRefreshReportTitle"),
			message: succeeded
				.map((outcome) => t("modelRefreshReportOk", { name: outcome.name, count: outcome.count }))
				.join("\n"),
			style: { whiteSpace: "pre-line" },
		});
	}
	if (failed.length > 0) {
		notifications.show({
			color: "red",
			autoClose: false,
			title: t("modelRefreshReportFailedTitle", { count: failed.length }),
			message: failed
				.map((outcome) =>
					t("modelRefreshReportFailed", { name: outcome.name, error: outcome.error }),
				)
				.join("\n"),
			style: { whiteSpace: "pre-line" },
		});
	}
}
