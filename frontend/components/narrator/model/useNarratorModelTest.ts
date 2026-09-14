/**
 * useNarratorModelTest — the error card's "test the current model" action.
 *
 * Carried over from the deleted chunked `NarratorModelTestAction`, which lived
 * inside MessageBubble's error notice and opened `ModelTestDialog` for the model
 * the failed turn actually dispatched to. When the vlist became the only message
 * renderer the button had no counterpart there, so an admin looking at a network
 * error lost the one-click way to find out whether the provider was reachable.
 *
 * Shaped like `useCodexImageGenerationFix` on purpose: the vlist shell holds ONE
 * instance for every visible error row, so eligibility is a pure predicate over the
 * row's error text and the dialog is hosted once for the whole list.
 */

import { useCurrentUser } from "@frontend/hooks/useAuth";
import { useAllModels } from "@frontend/hooks/useModels";
import { useNarrator } from "@frontend/hooks/useNarrator";
import { isModelNetworkError, resolveModelTestTarget } from "@frontend/lib/model-network-error";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

export interface NarratorModelTest {
	/** Whether this error text is a network failure AND the user may probe it. */
	canTest: (errorText: string) => boolean;
	/** Open the dialog for the error text of the clicked row. */
	open: (errorText: string) => void;
	/** Close the dialog. */
	close: () => void;
	/** The error text the dialog is open for, or null when closed. */
	target: string | null;
	/** The concrete `provider:model` to probe. */
	modelValue: string;
	/** The narrator's own selection, shown as the dialog's starting point. */
	selectedModelValue: string;
	/** Localized button label. */
	label: string;
}

export function useNarratorModelTest(narratorId: string): NarratorModelTest {
	const { t } = useTranslation("narrator");
	const { data: currentUser } = useCurrentUser();
	const { data: narrator } = useNarrator(narratorId);
	const { defaultModelValue } = useAllModels();
	const [target, setTarget] = useState<string | null>(null);

	const narratorModel = typeof narrator?.model === "string" ? narrator.model.trim() : "";
	const selectedModelValue = narratorModel || defaultModelValue;
	// Prefer the concrete member the failed turn dispatched to, exactly as the
	// deleted chunked action did — "which provider served this turn" has one answer,
	// and probing the aggregation instead would test a different thing than failed.
	const modelValue = resolveModelTestTarget(selectedModelValue, narrator?.runtimeModel);
	// Admin-only, and only when there is something to probe. Both were conditions of
	// the chunked action too: the dialog reports provider-level reachability, which is
	// operator information, and it needs a resolved model to aim at.
	const eligible = currentUser?.role === "admin" && modelValue.length > 0;

	const canTest = useMemo(
		() => (errorText: string) => eligible && isModelNetworkError(errorText),
		[eligible],
	);

	const open = useCallback(
		(errorText: string) => {
			if (!eligible) return;
			setTarget(errorText);
		},
		[eligible],
	);
	const close = useCallback(() => setTarget(null), []);

	return {
		canTest,
		open,
		close,
		target,
		modelValue,
		selectedModelValue,
		label: t("testCurrentModel"),
	};
}
