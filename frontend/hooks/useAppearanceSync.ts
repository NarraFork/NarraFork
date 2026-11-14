import type { AppearancePreferenceKey } from "@shared/appearance-preferences";
import { useSyncExternalStore } from "react";
import {
	appearanceStore,
	subscribeAppearancePreferences,
} from "../lib/appearance-preference-store";

export function useAppearanceSync() {
	useSyncExternalStore(subscribeAppearancePreferences, appearanceStore.getSnapshot, () => 0);
	return {
		customEnabled: appearanceStore.customEnabled,
		setCustomEnabled: appearanceStore.setCustomEnabled,
		isSynced: appearanceStore.isSynced,
		setSynced: appearanceStore.setSynced,
		ready: appearanceStore.ready,
	};
}

/** Type-check a setting's identity without turning the bootstrap store into an API dependency. */
export type { AppearancePreferenceKey };
