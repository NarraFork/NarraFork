import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useLayoutEffect,
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
	const seenRef = useRef<Set<string>>(new Set());
	const pendingRef = useRef<Map<string, symbol>>(new Map());

	useEffect(() => {
		void scopeKey;
		seenRef.current.clear();
		pendingRef.current.clear();
	}, [scopeKey]);

	useEffect(() => {
		void scopeKey;
		for (const animationId of seedIds) {
			if (!animationId) continue;
			seenRef.current.add(animationId);
			pendingRef.current.delete(animationId);
		}
	}, [scopeKey, seedIds]);

	const registerAppearance = useCallback(
		(animationId: string): BlurInRegistration => {
			if (!animationId) return NOOP_REGISTRATION;
			if (seenRef.current.has(animationId) || pendingRef.current.has(animationId)) {
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
				animate: !suppress,
				cleanup: () => {
					cancelled = true;
					if (pendingRef.current.get(animationId) === token) {
						pendingRef.current.delete(animationId);
					}
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

	useLayoutEffect(() => {
		setShouldAnimate(false);
		if (!registry || !animationId) return;
		const registration = registry.registerAppearance(animationId);
		if (registration.animate) {
			setShouldAnimate(true);
		}
		return registration.cleanup;
	}, [registry, animationId]);

	return shouldAnimate;
}

function BlurInAnimated({ animationId, children }: { animationId: string; children: ReactNode }) {
	const shouldAnimate = useBlurInOnAppear(animationId);
	return <div className={shouldAnimate ? "nf-blur-in-enter" : undefined}>{children}</div>;
}

export function BlurInOnAppear({
	animationId,
	children,
}: {
	animationId?: string | null;
	children: ReactNode;
}) {
	const registry = useContext(BlurInOnAppearContext);
	if (!animationId || !registry) return <>{children}</>;
	return <BlurInAnimated animationId={animationId}>{children}</BlurInAnimated>;
}
