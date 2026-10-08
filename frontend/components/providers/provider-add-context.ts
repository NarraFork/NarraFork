import { createContext, useContext } from "react";
import type { AddProviderDraft } from "./provider-add-draft";

// The providers parent route keeps its reducer mounted while the add route is open.
export const ProviderAddContext = createContext<
	((draft: AddProviderDraft) => Promise<void>) | null
>(null);

export function useAddProvider() {
	const add = useContext(ProviderAddContext);
	if (!add) throw new Error("Provider add route requires the providers parent context");
	return add;
}
