import { notifications } from "@mantine/notifications";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { getToken } from "../lib/api";

const MAX_LOG_LINES = 200;

/**
 * Subscribe to container lifecycle events (starting/log/started/error) via WebSocket.
 * Automatically invalidates container queries on started/stopped and shows error notifications.
 * Returns streaming build logs and a "starting" flag for UI feedback.
 */
export function useContainerEvents(chapterId: string) {
	const qc = useQueryClient();
	const [starting, setStarting] = useState(false);
	const [logs, setLogs] = useState<string[]>([]);
	const wsRef = useRef<WebSocket | null>(null);
	const cancelledRef = useRef(false);

	useEffect(() => {
		if (!chapterId) return;
		cancelledRef.current = false;

		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		const token = getToken();
		const tokenParam = token ? `?token=${encodeURIComponent(token)}` : "";
		const ws = new WebSocket(`${protocol}//${window.location.host}/ws/narrator${tokenParam}`);
		wsRef.current = ws;

		ws.onopen = () => {
			if (cancelledRef.current) {
				ws.close();
				return;
			}
			// Subscribe with empty narrator list — we only care about broadcast events
			ws.send(JSON.stringify({ type: "subscribe", narratorIds: [] }));
		};

		ws.onmessage = (event) => {
			if (cancelledRef.current) return;
			try {
				const data = JSON.parse(event.data);
				if (data.type === "ping") {
					ws.send(JSON.stringify({ type: "pong" }));
					return;
				}
				// Only handle events for our chapter
				if (data.chapterId !== chapterId) return;

				switch (data.type) {
					case "container:starting":
						setStarting(true);
						setLogs([]);
						break;
					case "container:log":
						setLogs((prev) => {
							const next = [...prev, data.line];
							return next.length > MAX_LOG_LINES ? next.slice(-MAX_LOG_LINES) : next;
						});
						break;
					case "container:started":
						setStarting(false);
						qc.invalidateQueries({ queryKey: ["containers", chapterId] });
						break;
					case "container:stopped":
					case "container:paused":
					case "container:resumed":
						qc.invalidateQueries({ queryKey: ["containers", chapterId] });
						break;
					case "container:error":
						setStarting(false);
						notifications.show({
							color: "red",
							title: "Container error",
							message: data.error || "Unknown error",
						});
						break;
				}
			} catch {
				// ignore parse errors
			}
		};

		ws.onclose = () => {};
		ws.onerror = () => {};

		return () => {
			cancelledRef.current = true;
			const w = wsRef.current;
			if (w) {
				w.onopen = null;
				w.onmessage = null;
				w.onclose = null;
				w.onerror = null;
				w.close();
			}
			wsRef.current = null;
		};
	}, [chapterId, qc]);

	return { starting, logs };
}
