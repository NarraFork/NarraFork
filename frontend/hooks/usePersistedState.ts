import { useCallback, useState } from "react";

/**
 * Like useState, but persists the boolean value to localStorage.
 * Reads the initial value from localStorage on first render.
 */
export function usePersistedState(
	key: string,
	defaultValue: boolean,
): [boolean, (value: boolean | ((prev: boolean) => boolean)) => void] {
	const [value, setValue] = useState<boolean>(() => {
		try {
			const stored = localStorage.getItem(key);
			if (stored === null) return defaultValue;
			return stored === "true";
		} catch {
			return defaultValue;
		}
	});

	const setPersistedValue = useCallback(
		(next: boolean | ((prev: boolean) => boolean)) => {
			setValue((prev) => {
				const resolved = typeof next === "function" ? next(prev) : next;
				try {
					localStorage.setItem(key, String(resolved));
				} catch {
					// ignore
				}
				return resolved;
			});
		},
		[key],
	);

	return [value, setPersistedValue];
}
