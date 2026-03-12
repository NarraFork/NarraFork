import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, getToken } from "../lib/api";

export interface UpdateProgress {
	phase: "checking" | "downloading" | "applying" | "complete" | "error";
	bytesDownloaded: number;
	totalBytes: number;
	percent: number;
	error?: string;
}

export interface UpdateInstructions {
	manual: boolean;
	command?: string;
	message: string;
}

export interface UpdateDownloadResult {
	success: boolean;
	updatePath?: string;
	instructions?: UpdateInstructions;
	error?: string;
}

export function useUpdateCheck(intervalMs = 60 * 60_000) {
	const [dismissed, setDismissed] = useState(false);

	const { data, isLoading, refetch } = useQuery({
		queryKey: ["update-check"],
		queryFn: () => api.checkUpdate(),
		refetchInterval: intervalMs,
		staleTime: intervalMs,
		enabled: intervalMs > 0,
	});

	const updateAvailable = !dismissed && data?.updateAvailable === true;

	// Auto-reset dismissed flag when version changes
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentionally re-run when latestVersion changes
	useEffect(() => {
		setDismissed(false);
	}, [data?.latestVersion]);

	const dismiss = useCallback(() => setDismissed(true), []);

	return {
		updateAvailable,
		isLoading,
		currentVersion: data?.currentVersion,
		latestVersion: data?.latestVersion,
		releaseInfo: data?.releaseInfo,
		downloadSize: data?.downloadSize,
		totalSize: data?.totalSize,
		diffBlocks: data?.diffBlocks,
		totalBlocks: data?.totalBlocks,
		dismiss,
		refetch,
	};
}

export function useUpdateDownload() {
	const [progress, setProgress] = useState<UpdateProgress | null>(null);
	const [result, setResult] = useState<UpdateDownloadResult | null>(null);
	const abortControllerRef = useRef<AbortController | null>(null);

	const download = useCallback(
		async (releaseInfo: {
			version: string;
			releaseDate: string;
			path: string;
			sha512: string;
			files: Array<{ url: string; size: number; sha512: string }>;
		}) => {
			setProgress({ phase: "checking", bytesDownloaded: 0, totalBytes: 0, percent: 0 });
			setResult(null);

			const controller = new AbortController();
			abortControllerRef.current = controller;

			try {
				const token = getToken();
				const response = await fetch("/api/update/download", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...(token ? { Authorization: `Bearer ${token}` } : {}),
					},
					body: JSON.stringify({ releaseInfo }),
					signal: controller.signal,
				});

				if (!response.ok) {
					throw new Error(`Download failed: ${response.status}`);
				}

				const reader = response.body?.getReader();
				if (!reader) throw new Error("No response body");

				const decoder = new TextDecoder();
				let buffer = "";

				while (true) {
					const { done, value } = await reader.read();
					if (done) break;

					buffer += decoder.decode(value, { stream: true });
					const lines = buffer.split("\n");
					buffer = lines.pop() ?? "";

					for (const line of lines) {
						if (line.startsWith("event:")) {
							const _event = line.slice(6).trim();
							// Handle event type
						} else if (line.startsWith("data:")) {
							const data = line.slice(5).trim();
							if (!data) continue;

							try {
								const parsed = JSON.parse(data);
								if (parsed.phase) {
									setProgress(parsed as UpdateProgress);
								}
								if (parsed.success !== undefined) {
									setResult(parsed as UpdateDownloadResult);
								}
							} catch {
								// Ignore parse errors
							}
						}
					}
				}
			} catch (err) {
				if ((err as Error).name === "AbortError") {
					setProgress(null);
					return;
				}
				setProgress({
					phase: "error",
					bytesDownloaded: 0,
					totalBytes: 0,
					percent: 0,
					error: String(err),
				});
				setResult({ success: false, error: String(err) });
			} finally {
				abortControllerRef.current = null;
			}
		},
		[],
	);

	const cancel = useCallback(() => {
		abortControllerRef.current?.abort();
	}, []);

	const reset = useCallback(() => {
		setProgress(null);
		setResult(null);
	}, []);

	return {
		download,
		cancel,
		reset,
		progress,
		result,
		isDownloading: progress !== null && progress.phase !== "complete" && progress.phase !== "error",
	};
}

export function useUpdateCleanup() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: () => api.cleanupUpdates(),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["update-check"] });
		},
	});
}

export function useUpdateVersion() {
	return useQuery({
		queryKey: ["update-version"],
		queryFn: () => api.getUpdateVersion(),
		staleTime: Number.POSITIVE_INFINITY,
	});
}

export function useUpdateRestart() {
	const [isRestarting, setIsRestarting] = useState(false);

	const restart = useCallback(async () => {
		setIsRestarting(true);
		try {
			const result = await api.restartForUpdate();
			if (!result.success) {
				setIsRestarting(false);
				return result;
			}
			// Server will restart, page will reload automatically when connection is lost
			return result;
		} catch (err) {
			setIsRestarting(false);
			return { success: false, error: String(err) };
		}
	}, []);

	return { restart, isRestarting };
}
