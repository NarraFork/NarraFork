import { useCallback } from "react";
import { useUserPreferences } from "./useUserPreferences";

/**
 * Returns a guard function that checks whether the setup wizard has been completed.
 * If not completed, it dispatches an event to open the wizard and returns `false`.
 * The caller should abort the action when `false` is returned.
 *
 * Usage:
 * ```ts
 * const requireSetup = useSetupWizardGuard();
 * const handleCreate = () => {
 *   if (!requireSetup()) return;
 *   // proceed with creation...
 * };
 * ```
 */
export function useSetupWizardGuard() {
	const { data: prefs } = useUserPreferences();

	return useCallback(() => {
		if (prefs?.setupWizardCompleted === false) {
			window.dispatchEvent(new CustomEvent("narrafork:open-wizard"));
			return false;
		}
		return true;
	}, [prefs?.setupWizardCompleted]);
}
