import { useEffect, useRef, useState } from "react";
import { narratorWSManager } from "../lib/narrator-ws-manager";

interface OutputStats {
	charsPerSec: number;
	totalChars: number;
}

/**
 * Subscribe to real-time AI output character rate stats via the global
 * NarratorWSManager.  Only subscribes when `enabled` is true.
 */
export function useOutputStats(enabled: boolean): OutputStats {
	const [stats, setStats] = useState<OutputStats>({ charsPerSec: 0, totalChars: 0 });
	const subscribedRef = useRef(false);

	useEffect(() => {
		if (!enabled) {
			setStats({ charsPerSec: 0, totalChars: 0 });
			return;
		}

		// Subscribe to stats
		narratorWSManager.subscribeStats();
		subscribedRef.current = true;

		// Listen for output_stats messages
		const handle = narratorWSManager.addListener({ types: ["output_stats"] }, (data) => {
			setStats({
				charsPerSec: data.charsPerSec as number,
				totalChars: data.totalChars as number,
			});
		});

		return () => {
			narratorWSManager.removeListener(handle);
			if (subscribedRef.current) {
				narratorWSManager.unsubscribeStats();
				subscribedRef.current = false;
			}
			setStats({ charsPerSec: 0, totalChars: 0 });
		};
	}, [enabled]);

	return stats;
}
