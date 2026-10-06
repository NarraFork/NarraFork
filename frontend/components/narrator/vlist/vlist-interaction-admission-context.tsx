import {
	createContext,
	useCallback,
	useContext,
	useLayoutEffect,
	useMemo,
	useRef,
	useSyncExternalStore,
} from "react";
import type {
	VListInteractionAdmissionLease,
	VListInteractionAdmissionStore,
} from "./vlist-interaction-admission";

export interface VListInteractionRowBounds {
	top: number;
	height: number;
	immediate?: boolean;
}

export const VListInteractionAdmissionContext =
	createContext<VListInteractionAdmissionStore | null>(null);
export const VListInteractionRowBoundsContext = createContext<VListInteractionRowBounds | null>(
	null,
);

const eagerLease: VListInteractionAdmissionLease = {
	getSnapshot: () => true,
	subscribe: () => () => {},
	ensure: () => {},
};

/** Subscribes to one sticky bit, never the owner's frequently changing scroll phase. */
export function useDeferredInteractionMount({
	immediate = false,
	enabled = true,
}: {
	immediate?: boolean;
	enabled?: boolean;
} = {}): {
	ready: boolean;
	ensure: () => void;
} {
	const store = useContext(VListInteractionAdmissionContext);
	const bounds = useContext(VListInteractionRowBoundsContext);
	const effectiveImmediate = immediate || bounds?.immediate === true;
	const boundsRef = useRef(bounds);
	useLayoutEffect(() => {
		// Publish only committed bounds, not speculative renders, to the priority callback.
		boundsRef.current = bounds;
	}, [bounds]);
	const lease = useMemo(() => {
		if (!enabled || !store) return eagerLease;
		return store.createLease({
			priority: () => {
				const row = boundsRef.current;
				if (!row) return 0;
				const view = store.getView();
				return row.top + row.height > view.scrollTop &&
					row.top < view.scrollTop + view.viewportHeight
					? 0
					: 1;
			},
		});
	}, [store, enabled]);
	const ready = useSyncExternalStore(lease.subscribe, lease.getSnapshot, lease.getSnapshot);
	const ensure = useCallback(() => lease.ensure(), [lease]);
	useLayoutEffect(() => {
		if (effectiveImmediate) ensure();
	}, [effectiveImmediate, ensure]);
	return { ready: effectiveImmediate || ready, ensure };
}
