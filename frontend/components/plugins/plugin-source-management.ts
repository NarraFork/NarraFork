import {
	type PluginSource,
	type PluginUpdateJob,
	pluginSourceUrlSchema,
} from "@shared/plugin-source";
import type { TFunction } from "i18next";
import { ApiError } from "../../lib/api";
import type { PluginSummary } from "../../lib/api/plugins";
import { localizePluginError } from "../plugins-admin/errors";

export function pluginUpdateErrorMessage(error: unknown, t: TFunction<"plugins">): string {
	const code =
		error instanceof ApiError && typeof error.data?.code === "string" ? error.data.code : null;
	return code
		? t(`admin.updates.errors.${code}`, { defaultValue: localizePluginError(error, t) })
		: localizePluginError(error, t);
}

/** No repository, publisher, or update-feed URL is a substitute for an explicit homepage. */
export function pluginSourceHomepage(source: PluginSource | null | undefined): string | null {
	if (!source?.homepage) return null;
	const parsed = pluginSourceUrlSchema.safeParse(source.homepage);
	return parsed.success ? parsed.data : null;
}

export function pluginCanUninstall(plugin: PluginSummary): boolean {
	if (typeof plugin.canUninstall === "boolean") return plugin.canUninstall;
	if (plugin.packageKind) return plugin.packageKind === "installed";
	return !plugin.builtin;
}

export function pluginIsCatalogOnly(plugin: PluginSummary): boolean {
	if (plugin.canUninstall === true) return false;
	if (plugin.packageKind) return plugin.packageKind === "builtin-directory";
	return plugin.builtin === true;
}

export function pluginUpdateJobActive(job: PluginUpdateJob | null | undefined): boolean {
	return job?.status === "queued" || job?.status === "running";
}

/** A missing bounded-history job is terminal; a network error is not proof of completion. */
export function pluginUpdateJobMissing(error: unknown): boolean {
	return error instanceof ApiError && error.status === 404;
}

export function pluginSourceAllowsAutomatic(source: PluginSource | null | undefined): boolean {
	if (!source) return false;
	if (source.type !== "website") return true;
	const parsed = pluginSourceUrlSchema.safeParse(source.updateApi);
	return parsed.success && new URL(parsed.data).protocol === "https:";
}

export function pluginUpdateDownloadPercent(job: PluginUpdateJob): number | null {
	if (
		!Number.isFinite(job.downloadedBytes) ||
		job.downloadedBytes < 0 ||
		!job.totalBytes ||
		!Number.isFinite(job.totalBytes) ||
		job.totalBytes < 0
	)
		return null;
	return Math.max(0, Math.min(100, (job.downloadedBytes / job.totalBytes) * 100));
}
