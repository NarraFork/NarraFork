import { useCallback, useEffect, useRef, useState } from "react";
import { getToken } from "../lib/api";
import { buildWsUrl } from "../lib/ws";

interface OutputStats {
	charsPerSec: number;
	totalChars: number;
}

/**
 * Subscribe to real-time AI output character rate stats via the narrator WS.
 * Only connects when `enabled` is true.
 */
export function useOutputStats(enabled: boolean): OutputStats {
	const [stats, setStats] = useState<OutputStats>({ charsPerSec: 0, totalChars: 0 });
	const wsRef = useRef<WebSocket | null>(null);
	const reconnectTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

	const connect = useCallback(() => {
		if (!enabled) return;
		const token = getToken();
		if (!token) return;

		const ws = new WebSocket(buildWsUrl("/ws/narrator", `token=${token}`));
		wsRef.current = ws;

		ws.onopen = () => {
			ws.send(JSON.stringify({ type: "subscribe_stats" }));
		};

		ws.onmessage = (e) => {
			try {
				const msg = JSON.parse(e.data);
				if (msg.type === "output_stats") {
					setStats({ charsPerSec: msg.charsPerSec, totalChars: msg.totalChars });
				}
			} catch {
				// ignore parse errors
			}
		};

		ws.onclose = () => {
			wsRef.current = null;
			if (enabled) {
				reconnectTimer.current = setTimeout(connect, 3000);
			}
		};
	}, [enabled]);

	useEffect(() => {
		if (enabled) {
			connect();
		}
		return () => {
			clearTimeout(reconnectTimer.current);
			const ws = wsRef.current;
			if (ws) {
				// Unsubscribe before closing
				if (ws.readyState === WebSocket.OPEN) {
					ws.send(JSON.stringify({ type: "unsubscribe_stats" }));
				}
				ws.onclose = null;
				ws.close();
				wsRef.current = null;
			}
			setStats({ charsPerSec: 0, totalChars: 0 });
		};
	}, [enabled, connect]);

	return stats;
}
