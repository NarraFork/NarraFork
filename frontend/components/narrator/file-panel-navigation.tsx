import { createContext, useContext, useMemo } from "react";
import { type NarratorDockContextValue, useNarratorDockContext } from "./dock/NarratorDockContext";

export type FilePanelOpener = NonNullable<NarratorDockContextValue["openFilePanel"]>;

// Child sessions must not publish into their parent's dock state. This narrow
// capability survives that isolation without inheriting any state/setter bridges.
const FilePanelNavigationContext = createContext<FilePanelOpener | undefined>(undefined);
export const FilePanelNavigationProvider = FilePanelNavigationContext.Provider;

export function useFilePanelNavigation(): FilePanelOpener | undefined {
	const explicit = useContext(FilePanelNavigationContext);
	const dock = useNarratorDockContext();
	return explicit ?? dock?.openFilePanel;
}

/** Carry the source session's file authority separately from the receiving layout host. */
export function useFilePanelSourceOpener(
	openFilePanel: FilePanelOpener | undefined,
	sourcePanelId: string,
	fileNarratorId: string,
): FilePanelOpener | undefined {
	return useMemo<FilePanelOpener | undefined>(
		() =>
			openFilePanel
				? (filePath, fileName, options) =>
						openFilePanel(filePath, fileName, {
							...options,
							fileNarratorId: options?.fileNarratorId ?? fileNarratorId,
							sourcePanelId,
						})
				: undefined,
		[openFilePanel, sourcePanelId, fileNarratorId],
	);
}
