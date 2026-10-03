import { type ComponentType, createContext, memo, useContext } from "react";

// Undefined intentionally retains the standalone panel's original falsey default.
export const NarratorPanelCompactContext = createContext<boolean | undefined>(undefined);

export function useNarratorPanelCompact() {
	return useContext(NarratorPanelCompactContext);
}

/** Create once at module scope: compact changes must not render or remount the body. */
export function createResponsiveNarratorPanel<Props extends { compact?: boolean }>(
	Body: ComponentType<Omit<Props, "compact">>,
) {
	const MemoBody = memo(Body);
	return function ResponsiveNarratorPanel({ compact, ...bodyProps }: Props) {
		return (
			<NarratorPanelCompactContext.Provider value={compact}>
				<MemoBody {...bodyProps} />
			</NarratorPanelCompactContext.Provider>
		);
	};
}
