import { useEffect, useRef, useState } from "react";
import { narratorWSManager } from "../lib/narrator-ws-manager";

interface OutputStats {
	charsPerSec: number;
	totalChars: number;
}

const ZERO_STATS: OutputStats = { charsPerSec: 0, totalChars: 0 };

/** Reset to zero without producing a new object when already zeroed. */
function resetToZero(prev: OutputStats): OutputStats {
	return prev.charsPerSec === 0 && prev.totalChars === 0 ? prev : ZERO_STATS;
}

/**
 * Subscribe to real-time AI output character rate stats via the global
 * NarratorWSManager.  Only subscribes when `enabled` is true.
 */
export function useOutputStats(enabled: boolean): OutputStats {
	const [stats, setStats] = useState<OutputStats>(ZERO_STATS);
	const subscribedRef = useRef(false);

	useEffect(() => {
		if (!enabled) {
			setStats(resetToZero);
			return;
		}

		// Subscribe to stats
		narratorWSManager.subscribeStats();
		subscribedRef.current = true;

		// Listen for output_stats messages.
		//
		// The server broadcasts this every second whether or not the numbers moved,
		// and this hook sits at the top of AuthenticatedLayout — so a naive setState
		// re-renders the whole AppShell (navbar NavLinks, tab strip, tooltips) once
		// per second, costing ~140ms of main-thread work and a visible frame drop
		// during scrolling. Bail out when the payload is unchanged, which is the
		// common case while idle.
		const handle = narratorWSManager.addListener({ types: ["output_stats"] }, (data) => {
			const charsPerSec = data.charsPerSec as number;
			const totalChars = data.totalChars as number;
			setStats((prev) =>
				prev.charsPerSec === charsPerSec && prev.totalChars === totalChars
					? prev
					: { charsPerSec, totalChars },
			);
		});

		return () => {
			narratorWSManager.removeListener(handle);
			if (subscribedRef.current) {
				narratorWSManager.unsubscribeStats();
				subscribedRef.current = false;
			}
			setStats(resetToZero);
		};
	}, [enabled]);

	return stats;
}
