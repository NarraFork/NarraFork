import { notifications } from "@mantine/notifications";
import i18n from "../../lib/i18n";
import { ErrorDetail } from "./ErrorDetail";

export interface ShowErrorNotificationOptions {
	/** Defaults to `common:operationFailed`. */
	title?: string;
	fallback?: string;
	/** Mantine notification id, for deduplicating repeated failures of one action. */
	id?: string;
}

/**
 * Show a failure as a localized toast with the original message one click away.
 *
 * `i18n.t` rather than a hook: the primary caller is the query client's global `onError`, which
 * runs outside React. The body is a React node, so `ErrorDetail` still translates through the
 * normal `useTranslation` path and re-renders on a language change.
 *
 * `autoClose` is left at the Mantine default. Unlike the rollback advisories in
 * `operation-warnings.ts` — which describe state left on disk and must survive inattention —
 * a failed request left the system unchanged, and the action can simply be retried.
 */
export function showErrorNotification(
	error: unknown,
	options: ShowErrorNotificationOptions = {},
): void {
	notifications.show({
		id: options.id,
		color: "red",
		title: options.title ?? i18n.t("common:operationFailed"),
		message: <ErrorDetail error={error} fallback={options.fallback} />,
	});
}
