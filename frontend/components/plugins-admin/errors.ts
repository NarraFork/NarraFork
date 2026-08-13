import type { TFunction } from "i18next";
import { ApiError } from "../../lib/api";

/**
 * Map a plugin API error to a localized message.
 *
 * Validation errors are deliberately client-facing: the server supplies the
 * rejected field/path so an administrator can fix the package or request.
 * Unknown and internal codes still use generic localized text and never expose
 * their raw messages.
 */
export function localizePluginError(error: unknown, t: TFunction<"plugins">): string {
	if (error instanceof ApiError) {
		const code = typeof error.data?.code === "string" ? error.data.code : undefined;
		if (code) {
			const summary = t(`admin.errors.${code}`, {
				defaultValue: t("admin.errors.UNKNOWN"),
			});
			if (code === "VALIDATION_ERROR") {
				const detail = error.message.trim();
				if (detail && detail !== code && detail !== summary) return `${summary} ${detail}`;
			}
			return summary;
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
