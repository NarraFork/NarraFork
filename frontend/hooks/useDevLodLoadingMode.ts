import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "narrafork_dev_lod_loading";
const EVENT_NAME = "narrafork:dev-lod-loading-changed";

function readMode(): boolean {
	try {
		return localStorage.getItem(STORAGE_KEY) === "true";
	} catch {
		return false;
	}
}

export function useDevLodLoadingMode(): [boolean, () => void] {
	const [enabled, setEnabled] = useState(readMode);

	useEffect(() => {
		const onChange = () => setEnabled(readMode());
		window.addEventListener(EVENT_NAME, onChange);
		return () => window.removeEventListener(EVENT_NAME, onChange);
	}, []);

	const toggle = useCallback(() => {
		const next = !readMode();
		try {
			localStorage.setItem(STORAGE_KEY, String(next));
		} catch {
			// Ignore storage failures; the current tab still gets the new value.
		}
		setEnabled(next);
		window.dispatchEvent(new Event(EVENT_NAME));
	}, []);

	return [enabled, toggle];
}
