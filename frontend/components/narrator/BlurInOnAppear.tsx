import {
	createContext,
	memo,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";

interface BlurInRegistration {
	animate: boolean;
	cleanup: () => void;
}

interface BlurInRegistry {
	registerAppearance: (animationId: string) => BlurInRegistration;
}

const BlurInOnAppearContext = createContext<BlurInRegistry | null>(null);

function noopCleanup() {}

const NOOP_REGISTRATION: BlurInRegistration = {
	animate: false,
	cleanup: noopCleanup,
};

export function BlurInOnAppearProvider({
	scopeKey,
	suppress,
	seedIds = [],
	children,
}: {
	scopeKey: string;
	suppress: boolean;
	seedIds?: string[];
	children: ReactNode;
}) {
	const scopeKeyRef = useRef(scopeKey);
	const seenRef = useRef<Set<string>>(new Set());
	const pendingRef = useRef<Map<string, symbol>>(new Map());
	const completedRef = useRef<Set<string>>(new Set());
	const seededRef = useRef<Set<string>>(new Set());

	if (scopeKeyRef.current !== scopeKey) {
		scopeKeyRef.current = scopeKey;
		seenRef.current.clear();
		pendingRef.current.clear();
		completedRef.current.clear();
		seededRef.current.clear();
	}

	// Seed historical IDs synchronously during provider render. Child
	// BlurInOnAppear effects run after this render, so virtualized historical
	// items cannot briefly register themselves as fresh appearances.
	for (const animationId of seedIds) {
		if (!animationId || seededRef.current.has(animationId)) continue;
		seededRef.current.add(animationId);
		seenRef.current.add(animationId);
		completedRef.current.add(animationId);
		pendingRef.current.delete(animationId);
	}

	const registerAppearance = useCallback(
		(animationId: string): BlurInRegistration => {
			if (!animationId) return NOOP_REGISTRATION;

			// Items that already completed their animation should never
			// re-animate, regardless of suppress toggles.  This prevents
			// the chevron flicker caused by suppressBlurIn changes
			// re-triggering CSS animations that momentarily affect layout.
			if (completedRef.current.has(animationId)) return NOOP_REGISTRATION;

			if (seenRef.current.has(animationId) || pendingRef.current.has(animationId)) {
				return NOOP_REGISTRATION;
			}

			if (suppress) {
				// Suppressing: register as seen so a future non-suppress
				// call won't animate either, but don't start an animation.
				seenRef.current.add(animationId);
				completedRef.current.add(animationId);
				return NOOP_REGISTRATION;
			}

			const token = Symbol(animationId);
			pendingRef.current.set(animationId, token);
			let cancelled = false;
			queueMicrotask(() => {
				if (cancelled) return;
				if (pendingRef.current.get(animationId) !== token) return;
				pendingRef.current.delete(animationId);
				seenRef.current.add(animationId);
			});

			return {
				animate: true,
				cleanup: () => {
					cancelled = true;
					if (pendingRef.current.get(animationId) === token) {
						pendingRef.current.delete(animationId);
					}
					// Mark as completed on cleanup (unmount or re-render)
					// so this animation ID never re-triggers.
					completedRef.current.add(animationId);
				},
			};
		},
		[suppress],
	);

	const value = useMemo<BlurInRegistry>(() => ({ registerAppearance }), [registerAppearance]);

	return <BlurInOnAppearContext.Provider value={value}>{children}</BlurInOnAppearContext.Provider>;
}

export function useBlurInOnAppear(animationId?: string | null) {
	const registry = useContext(BlurInOnAppearContext);
	const [shouldAnimate, setShouldAnimate] = useState(false);

	// Use useEffect instead of useLayoutEffect to avoid incrementing React 19's
	// nested-update counter during the commit phase. Blur-in is a CSS-driven
	// visual effect — applying the class one frame later is imperceptible and
	// prevents "max update depth exceeded" when many BlurInAnimated instances
	// mount in the same commit (e.g. streaming reasoning → finalized message).
	useEffect(() => {
		if (!registry || !animationId) return;
		const registration = registry.registerAppearance(animationId);
		setShouldAnimate((prev) =>
			Object.is(prev, registration.animate) ? prev : registration.animate,
		);
		return registration.cleanup;
	}, [registry, animationId]);

	return shouldAnimate;
}

const BlurInAnimated = memo(function BlurInAnimated({
	animationId,
	children,
}: {
	animationId: string;
	children: ReactNode;
}) {
	const shouldAnimate = useBlurInOnAppear(animationId);
	return <div className={shouldAnimate ? "nf-blur-in-enter" : undefined}>{children}</div>;
});

export const BlurInOnAppear = memo(function BlurInOnAppear({
	animationId,
	children,
}: {
	animationId?: string | null;
	children: ReactNode;
}) {
	const registry = useContext(BlurInOnAppearContext);
	if (!animationId || !registry) return <>{children}</>;
	return <BlurInAnimated animationId={animationId}>{children}</BlurInAnimated>;
});
