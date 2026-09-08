import { useCallback } from "react";
import { useCurrentUser } from "./useAuth";
import { useUserPreferences } from "./useUserPreferences";

/**
 * Whether an action must be blocked until the setup wizard has been completed.
 *
 * `setupWizardCompleted` is instance-wide, projected through the preferences API.
 * Once any admin completes setup, later users (including promoted admins) skip it.
 * The wizard configures instance-wide settings (providers, models, listen address)
 * that non-admins may not change, so they are never gated on it.
 */
export function shouldBlockForSetupWizard(options: {
	role: string | undefined;
	setupWizardCompleted: boolean | undefined;
}): boolean {
	return options.role === "admin" && options.setupWizardCompleted === false;
}

/**
 * Returns a guard function that checks whether the setup wizard has been completed.
 * If not completed, it dispatches an event to open the wizard and returns `false`.
 * The caller should abort the action when `false` is returned.
 *
 * Non-admins are always allowed through — see `shouldBlockForSetupWizard`.
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
	const { data: user } = useCurrentUser();
	const role = user?.role;
	const setupWizardCompleted = prefs?.setupWizardCompleted;

	return useCallback(() => {
		if (shouldBlockForSetupWizard({ role, setupWizardCompleted })) {
			window.dispatchEvent(new CustomEvent("narrafork:open-wizard"));
			return false;
		}
		return true;
	}, [role, setupWizardCompleted]);
}
