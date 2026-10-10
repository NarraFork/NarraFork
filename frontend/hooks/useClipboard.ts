import { copyTextToClipboard } from "@frontend/lib/clipboard";
import { useCallback, useEffect, useRef, useState } from "react";

export interface UseClipboardInput {
	timeout?: number;
}

export interface UseClipboardReturnValue {
	copy: (value: unknown) => void;
	reset: () => void;
	error: Error | null;
	copied: boolean;
}

export function useClipboard(options: UseClipboardInput = {}): UseClipboardReturnValue {
	const timeout = options.timeout ?? 2000;
	const [error, setError] = useState<Error | null>(null);
	const [copied, setCopied] = useState(false);
	const timeoutRef = useRef<number | null>(null);
	const mountedRef = useRef(true);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			if (timeoutRef.current != null) window.clearTimeout(timeoutRef.current);
		};
	}, []);

	const reset = useCallback(() => {
		if (timeoutRef.current != null) window.clearTimeout(timeoutRef.current);
		timeoutRef.current = null;
		setCopied(false);
		setError(null);
	}, []);

	const copy = useCallback(
		(value: unknown) => {
			void copyTextToClipboard(String(value))
				.then(() => {
					if (!mountedRef.current) return;
					if (timeoutRef.current != null) window.clearTimeout(timeoutRef.current);
					setError(null);
					setCopied(true);
					timeoutRef.current = window.setTimeout(() => {
						if (mountedRef.current) setCopied(false);
					}, timeout);
				})
				.catch((reason: unknown) => {
					if (!mountedRef.current) return;
					setCopied(false);
					setError(reason instanceof Error ? reason : new Error(String(reason)));
				});
		},
		[timeout],
	);

	return { copy, reset, error, copied };
}
