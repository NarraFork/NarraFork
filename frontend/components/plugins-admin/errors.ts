import type { TFunction } from "i18next";
import { ApiError } from "../../lib/api";

/**
 * Map a plugin API error to a localized message.
 * Never surfaces raw server `Error.message` for known codes; falls back to a
 * generic localized string for unknown failures.
 */
export function localizePluginError(error: unknown, t: TFunction<"plugins">): string {
	if (error instanceof ApiError) {
		const code = typeof error.data?.code === "string" ? error.data.code : undefined;
		if (code) {
			return t(`admin.errors.${code}`, {
				defaultValue: t("admin.errors.UNKNOWN"),
			});
		}
		if (error.status === 503) return t("admin.errors.PLUGINS_DISABLED");
		if (error.status === 404) return t("admin.errors.NOT_FOUND");
		return t("admin.errors.UNKNOWN");
	}
	return t("admin.errors.UNKNOWN");
}

/** True when the error is the steady-state 503 PLUGINS_DISABLED response. */
export function isPluginsDisabledError(error: unknown): boolean {
	return (
		error instanceof ApiError && (error.data?.code === "PLUGINS_DISABLED" || error.status === 503)
	);
}
