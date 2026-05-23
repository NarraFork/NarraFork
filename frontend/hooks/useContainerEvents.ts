import { notifications } from "@mantine/notifications";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { narratorWSManager } from "../lib/narrator-ws-manager";

const MAX_LOG_LINES = 200;
const LOG_FLUSH_FALLBACK_MS = 250;

export interface ContainerLogEntry {
	line: string;
	phase: "build" | "start";
}

/**
 * Subscribe to container lifecycle events (starting/log/started/error) via the
 * global NarratorWSManager.  Automatically invalidates container queries on
 * started/stopped and shows error notifications.
 */
export function useContainerEvents(chapterId: string) {
	const qc = useQueryClient();
	const [starting, setStarting] = useState(false);
	const [logs, setLogs] = useState<ContainerLogEntry[]>([]);
	const [phase, setPhase] = useState<"build" | "start" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const pendingLogsRef = useRef<ContainerLogEntry[]>([]);
	const pendingPhaseRef = useRef<"build" | "start" | null>(null);
	const logRafRef = useRef<number | null>(null);
	const logTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const flushPendingLogs = useCallback(() => {
		if (logRafRef.current !== null) {
			cancelAnimationFrame(logRafRef.current);
			logRafRef.current = null;
		}
		if (logTimeoutRef.current !== null) {
			clearTimeout(logTimeoutRef.current);
			logTimeoutRef.current = null;
		}
		const pendingLogs = pendingLogsRef.current;
		const pendingPhase = pendingPhaseRef.current;
		pendingLogsRef.current = [];
		pendingPhaseRef.current = null;

		if (pendingPhase) setPhase(pendingPhase);
		if (pendingLogs.length === 0) return;

		setLogs((prev) => {
			const next = [...prev, ...pendingLogs];
			return next.length > MAX_LOG_LINES ? next.slice(-MAX_LOG_LINES) : next;
		});
	}, []);

	const scheduleLogFlush = useCallback(() => {
		if (logRafRef.current === null) {
			logRafRef.current = requestAnimationFrame(() => {
				logRafRef.current = null;
				flushPendingLogs();
			});
		}
		if (logTimeoutRef.current === null) {
			logTimeoutRef.current = setTimeout(() => {
				logTimeoutRef.current = null;
				flushPendingLogs();
			}, LOG_FLUSH_FALLBACK_MS);
		}
	}, [flushPendingLogs]);

	const clearPendingLogs = useCallback(() => {
		if (logRafRef.current !== null) {
			cancelAnimationFrame(logRafRef.current);
			logRafRef.current = null;
		}
		if (logTimeoutRef.current !== null) {
			clearTimeout(logTimeoutRef.current);
			logTimeoutRef.current = null;
		}
		pendingLogsRef.current = [];
		pendingPhaseRef.current = null;
	}, []);

	useEffect(() => {
		if (!chapterId) return;

		const handle = narratorWSManager.addListener({ typePrefixes: ["container:"] }, (data) => {
			// Only handle events for our chapter
			if (data.chapterId !== chapterId) return;

			switch (data.type) {
				case "container:starting":
					clearPendingLogs();
					setStarting(true);
					setLogs([]);
					setPhase(null);
					setError(null);
					break;
				case "container:log": {
					const entryPhase = (data.phase as "build" | "start") ?? "build";
					pendingPhaseRef.current = entryPhase;
					// Skip empty phase-transition markers
					const line = data.line as string;
					if (line) {
						pendingLogsRef.current.push({ line, phase: entryPhase });
					}
					scheduleLogFlush();
					break;
				}
				case "container:started":
					flushPendingLogs();
					setStarting(false);
					setPhase(null);
					setError(null);
					qc.invalidateQueries({ queryKey: ["containers", chapterId] });
					break;
				case "container:stopped":
				case "container:paused":
				case "container:resumed":
					qc.invalidateQueries({ queryKey: ["containers", chapterId] });
					break;
				case "container:error": {
					const errorMessage =
						(data.reason as string | undefined) ??
						(data.message as string | undefined) ??
						(data.error as string | undefined) ??
						(data.code as string | undefined) ??
						"Unknown error";
					flushPendingLogs();
					setStarting(false);
					setError(errorMessage);
					notifications.show({
						color: "red",
						title: "Container error",
						message: errorMessage,
						autoClose: false,
					});
					break;
				}
			}
		});

		return () => {
			narratorWSManager.removeListener(handle);
			clearPendingLogs();
		};
	}, [chapterId, qc, clearPendingLogs, flushPendingLogs, scheduleLogFlush]);

	return { starting, logs, phase, error, clearError: () => setError(null) };
}
