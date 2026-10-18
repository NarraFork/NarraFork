import type { DockviewPanelApi } from "dockview-react";
import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useLayoutEffect,
	useState,
	useSyncExternalStore,
} from "react";

const NarratorPanelVisibleContext = createContext(true);

export function NarratorPanelVisibilityProvider({
	value,
	children,
}: {
	value: boolean;
	children: ReactNode;
}) {
	const parent = useContext(NarratorPanelVisibleContext);
	return (
		<NarratorPanelVisibleContext.Provider value={parent && value}>
			{children}
		</NarratorPanelVisibleContext.Provider>
	);
}

// One realm subscription, not one visibilitychange listener per restored tab.
const documentListeners = new Set<() => void>();
const documentChanged = () => {
	for (const listener of documentListeners) listener();
};
const subscribeDocument = (listener: () => void) => {
	if (!documentListeners.size) document.addEventListener("visibilitychange", documentChanged);
	documentListeners.add(listener);
	return () => {
		documentListeners.delete(listener);
		if (!documentListeners.size) document.removeEventListener("visibilitychange", documentChanged);
	};
};
export function useEditorPanelVisible(visible = true) {
	const panel = useNarratorPanelVisible();
	const foreground = useSyncExternalStore(
		subscribeDocument,
		() => document.visibilityState !== "hidden",
		() => true,
	);
	return visible && panel && foreground;
}

export const EDITOR_HIDE_DELAY_MS = 1000;
/** Never retain a never-displayed view. Short tab switches do not destroy the view. */
export function useRetainedEditorView(visible: boolean) {
	const [retained, setRetained] = useState(visible);
	useEffect(() => {
		if (visible) {
			setRetained(true);
			return;
		}
		if (!retained) return;
		const timer = setTimeout(() => setRetained(false), EDITOR_HIDE_DELAY_MS);
		return () => clearTimeout(timer);
	}, [visible, retained]);
	return visible || retained;
}

export function useNarratorPanelVisible(): boolean {
	return useContext(NarratorPanelVisibleContext);
}

export function DockviewNarratorPanelVisibilityProvider({
	api,
	children,
}: {
	api: DockviewPanelApi;
	children: ReactNode;
}) {
	// Every split group's selected tab is visible; only one group owns focus.
	// Layout and document loading must not wait for api.isActive.
	const [visible, setVisible] = useState(api.isVisible);
	useLayoutEffect(() => {
		setVisible(api.isVisible);
		const subscription = api.onDidVisibilityChange(() => setVisible(api.isVisible));
		return () => subscription.dispose();
	}, [api]);
	return (
		<NarratorPanelVisibilityProvider value={visible}>{children}</NarratorPanelVisibilityProvider>
	);
}
