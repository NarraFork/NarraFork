/**
 * useCodexImageGenerationFix.ts — the one-click "turn off image generation and
 * retry" flow shared by both message-list renderers.
 *
 * Lives outside the two error cards because the vlist paints its rows as
 * zero-DOM copies and cannot own state: the shell hosts ONE hook for the whole
 * list, the chunked ErrorNotice mounts its own. Both get the same eligibility
 * rule and the same two-step action (disable, then retry) from here.
 *
 * Eligibility is split from the action deliberately. `canFix(errorText)` is a
 * per-row predicate (the vlist has many error rows, each with its own text),
 * while the action itself is per-NARRATOR: it disables the tool for the provider
 * the narrator's turn resolved to and retries that narrator's last turn, so it
 * needs no row context and one shared busy flag is correct.
 *
 * The predicate is narrow on purpose (see shared/codex-image-generation-error.ts):
 * only an admin, only a 403-shaped refusal that names image generation, and only
 * when the failing turn resolves to a concrete provider prefix. Anything looser
 * would offer to silently disable a feature that was not the cause.
 */

import { api } from "@frontend/lib/api";
import { notifications } from "@mantine/notifications";
import { isCodexImageGenerationDisabledError } from "@shared/codex-image-generation-error";
import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../../hooks/useAuth";
import { useAllModels } from "../../hooks/useModels";
import { useNarrator } from "../../hooks/useNarrator";
import { resolveModelTestTarget } from "../../lib/model-network-error";

export interface CodexImageGenerationFix {
	/** Whether this error text is the image-generation refusal AND the user may fix it. */
	canFix: (errorText: string) => boolean;
	/** Disable image generation for the resolved provider, then retry the last turn. */
	run: () => void;
	/** A disable+retry round trip is in flight. */
	busy: boolean;
	/** Localized tooltip / aria-label for the control. */
	label: string;
}

/**
 * Build the image-generation fix for one narrator.
 *
 * The provider is taken from `runtimeModel` when present (the concrete member an
 * aggregation actually dispatched to) and falls back to the narrator's own model
 * selection, then the global default — the same precedence the model-test action
 * uses, because "which provider served this turn" has one answer.
 */
export function useCodexImageGenerationFix(narratorId: string): CodexImageGenerationFix {
	const { t } = useTranslation("narrator");
	const { data: currentUser } = useCurrentUser();
	const { data: narrator } = useNarrator(narratorId);
	const { defaultModelValue } = useAllModels();
	const [busy, setBusy] = useState(false);
	// The re-entrancy guard is a ref, not the state value: the vlist shell shares ONE
	// hook across every visible error row, so keeping `busy` out of `run`'s deps stops
	// each in-flight toggle from handing all those rows a new onClick identity.
	const busyRef = useRef(false);

	const narratorModel = typeof narrator?.model === "string" ? narrator.model.trim() : "";
	const modelValue = resolveModelTestTarget(
		narratorModel || defaultModelValue,
		narrator?.runtimeModel,
	);
	// A prefix is required: without one the server cannot tell which of the
	// possible flags to write, and guessing would hit the wrong provider.
	const addressable = currentUser?.role === "admin" && modelValue.includes(":");

	const canFix = useMemo(
		() => (errorText: string) => addressable && isCodexImageGenerationDisabledError(errorText),
		[addressable],
	);

	const run = useCallback(() => {
		if (!addressable || busyRef.current) return;
		busyRef.current = true;
		setBusy(true);
		void (async () => {
			try {
				const result = await api.disableCodexImageGeneration(modelValue);
				notifications.show({
					message: result.changed
						? t("disableImageGenSuccess", { provider: result.providerName })
						: t("disableImageGenAlreadyOff", { provider: result.providerName }),
					color: "green",
					autoClose: 5000,
				});
				// Retry only after the flag is persisted: the provider adapter reads
				// settings when the turn starts, so retrying first would re-send the
				// rejected tool and reproduce the same 403.
				await api.retryLastMessage(narratorId);
			} catch (err) {
				notifications.show({
					title: t("disableImageGenFailed"),
					message: err instanceof Error ? err.message : String(err),
					color: "red",
					autoClose: 8000,
				});
			} finally {
				busyRef.current = false;
				setBusy(false);
			}
		})();
	}, [addressable, modelValue, narratorId, t]);

	return { canFix, run, busy, label: t("disableImageGen") };
}
