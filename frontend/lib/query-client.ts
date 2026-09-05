import { notifications } from "@mantine/notifications";
import { isSessionInvalidResponse } from "@shared/session-auth";
import { QueryClient } from "@tanstack/react-query";
import type { ApiError } from "./api";
import { isAbortError } from "./api/client";
import { describeApiError } from "./api-error";
import i18n from "./i18n";

/**
 * Per-mutation opt-out from the global failure toast.
 *
 * A mutation that renders its own failure — an Alert inside the modal that started it,
 * an inline field error — was still getting the global toast on top, because TanStack
 * only replaces the default `onError` when the mutation defines one of its own.
 * The user saw the same sentence twice, in two places, and the toast covered the
 * surface that already explained it.
 *
 * `meta.suppressErrorToast` says "this failure is already visible" without forcing the
 * call site to declare an empty `onError` that reads like an oversight.
 */
declare module "@tanstack/react-query" {
	interface Register {
		mutationMeta: {
			suppressErrorToast?: boolean;
		};
	}
}

/**
 * Global failure toast for mutations.
 *
 * This one handler is where the large majority of user-visible errors surface, so localizing it
 * covers most of the app without touching individual call sites.
 *
 * The rich body (`ErrorDetail`, with the "show original" disclosure) is pulled in dynamically
 * rather than imported at the top: this module is imported by non-React code and by Bun tests
 * (`useRecentTabs.test.ts` imports it directly), and a static edge to a `.tsx` component would
 * drag React and Mantine's notification internals into every one of those graphs. The plain-text
 * fallback below keeps the toast correct — already localized, just without the disclosure — if
 * the chunk cannot be loaded.
 */
function showMutationError(error: unknown): void {
	import("../components/common/error-toast")
		.then(({ showErrorNotification }) => showErrorNotification(error))
		.catch(() => {
			// Only the fallback needs a plain string, so the error is described here rather
			// than eagerly: on the path that succeeds, `showErrorNotification` describes it
			// itself and a second pass would be pure waste.
			notifications.show({
				title: i18n.t("common:operationFailed"),
				message: describeApiError(error, (key, options) => i18n.t(key, options)).message,
				color: "red",
			});
		});
}

/**
 * Show the global failure toast from a mutation that declares its own `onError`.
 *
 * TanStack REPLACES the default handler when a mutation supplies one, so an
 * optimistic mutation that rolls back in `onError` silently opted out of the
 * toast as well: the UI reverted the user's action and said nothing about why.
 * Rollback handlers call this to opt back in; handlers that render the failure
 * themselves must not.
 */
export function reportMutationError(error: unknown, meta?: { suppressErrorToast?: boolean }): void {
	if (!shouldShowMutationErrorToast(error, meta)) return;
	showMutationError(error);
}

/**
 * Whether a mutation failure deserves the global toast.
 *
 * Exported (and kept free of Mantine/i18n) so the three suppression rules can be asserted
 * without mounting a QueryClient: each of them fails SILENTLY when wrong — a missing toast
 * looks like a dead button, a redundant one looks like a bug in the modal — so none of them
 * would be caught by watching the app.
 *
 * Silent cases, all three because a toast would be actively wrong rather than merely noisy:
 *
 *   - **The call site already shows it** (`meta.suppressErrorToast`). TanStack only replaces
 *     the default `onError` when a mutation declares its own, so a modal rendering its
 *     failure as an Alert was getting the toast on top of it.
 *   - **Cancellation.** An aborted upload or a request dropped by an unmounting component is
 *     the outcome the user asked for. `isAbortError` covers both fetch's native `AbortError`
 *     and the XHR upload path's `UPLOAD_ABORTED` code.
 *   - **A dead session.** `AppRootLayout` responds by sending the user to the login page, so
 *     a toast would ride along on a screen that already explains itself.
 *
 * A 401 alone is NOT silent. `isSessionInvalidResponse` exists because some 401s leave the
 * session intact — a wrong TOTP code, a failed passkey assertion — and those navigate
 * nowhere. Treating every 401 as session loss made them look like a dead button: the form
 * stayed put and nothing was said.
 */
export function shouldShowMutationErrorToast(
	error: unknown,
	meta?: { suppressErrorToast?: boolean },
): boolean {
	if (meta?.suppressErrorToast) return false;
	if (isAbortError(error)) return false;
	const apiError = error as ApiError | null | undefined;
	if (apiError?.status === 401 && isSessionInvalidResponse(apiError.data ?? null)) return false;
	return true;
}

export const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			staleTime: 5_000,
			gcTime: 2 * 60_000,
			retry: 1,
		},
		mutations: {
			onError: (error, _variables, _onMutateResult, context) => {
				reportMutationError(error, context?.meta);
			},
		},
	},
});
