import { createContext, useContext } from "react";

const NarratorPanelVisibleContext = createContext(true);

export const NarratorPanelVisibilityProvider = NarratorPanelVisibleContext.Provider;

export function useNarratorPanelVisible(): boolean {
	return useContext(NarratorPanelVisibleContext);
}
