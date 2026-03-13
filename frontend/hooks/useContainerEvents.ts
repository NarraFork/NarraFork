import { notifications } from "@mantine/notifications";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { narratorWSManager } from "../lib/narrator-ws-manager";

const MAX_LOG_LINES = 200;

/**
 * Subscribe to container lifecycle events (starting/log/started/error) via the
 * global NarratorWSManager.  Automatically invalidates container queries on
 * started/stopped and shows error notifications.
 */
export function useContainerEvents(chapterId: string) {
	const qc = useQueryClient();
	const [starting, setStarting] = useState(false);
	const [logs, setLogs] = useState<string[]>([]);

	useEffect(() => {
		if (!chapterId) return;

		const handle = narratorWSManager.addListener({ typePrefixes: ["container:"] }, (data) => {
			// Only handle events for our chapter
			if (data.chapterId !== chapterId) return;

			switch (data.type) {
				case "container:starting":
					setStarting(true);
					setLogs([]);
					break;
				case "container:log":
					setLogs((prev) => {
						const next = [...prev, data.line as string];
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
						message: (data.error as string) || "Unknown error",
					});
					break;
			}
		});

		return () => {
			narratorWSManager.removeListener(handle);
		};
	}, [chapterId, qc]);

	return { starting, logs };
}
