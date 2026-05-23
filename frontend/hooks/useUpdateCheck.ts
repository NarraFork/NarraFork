import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, getToken, readFetchError } from "../lib/api";
import { useUpdateCapability } from "./usePlatform";

const MAX_SSE_BUFFER_CHARS = 64_000;

function createSseResidualError(): Error {
	return new Error(`SSE stream line exceeded ${MAX_SSE_BUFFER_CHARS} characters before a newline`);
}

async function cancelSseReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
	try {
		await reader.cancel();
	} catch {
		// Ignore cancellation failures; the original error is more important.
	}
}

function drainCompleteSseLines(buffer: string, onLine: (line: string) => void): string {
	let newlineIndex = buffer.indexOf("\n");
	while (newlineIndex !== -1) {
		let line = buffer.slice(0, newlineIndex);
		if (line.endsWith("\r")) line = line.slice(0, -1);
		onLine(line);
		buffer = buffer.slice(newlineIndex + 1);
		newlineIndex = buffer.indexOf("\n");
	}
	return buffer;
}

interface ParsedSseEvent {
	eventName: string;
	data: string;
}

function readSseFieldValue(line: string, prefixLength: number): string {
	const value = line.slice(prefixLength);
	return value.startsWith(" ") ? value.slice(1) : value;
}

function createSseEventParser(defaultEventName: string) {
	let eventName = defaultEventName;
	let dataLines: string[] = [];

	const reset = () => {
		eventName = defaultEventName;
		dataLines = [];
	};

	const dispatch = (): ParsedSseEvent | null => {
		const hasExplicitEvent = eventName !== defaultEventName;
		if (dataLines.length === 0 && !hasExplicitEvent) {
			reset();
			return null;
		}

		const event = { eventName, data: dataLines.join("\n") };
		reset();
		return event;
	};

	return {
		handleLine(line: string): ParsedSseEvent | null {
			if (line.trim() === "") return dispatch();
			if (line.startsWith(":")) return null;
			if (line.startsWith("event:")) {
				eventName = readSseFieldValue(line, 6).trim();
				return null;
			}
			if (line.startsWith("data:")) {
				dataLines.push(readSseFieldValue(line, 5));
			}
			return null;
		},
		flushPending: dispatch,
	};
}

async function enforceSseResidualLimit(
	buffer: string,
	reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<void> {
	if (buffer.length <= MAX_SSE_BUFFER_CHARS) return;
	await cancelSseReader(reader);
	throw createSseResidualError();
}

export interface UpdateProgress {
	phase: "checking" | "downloading" | "applying" | "complete" | "error";
	bytesDownloaded: number;
	totalBytes: number;
	percent: number;
	error?: string;
	code?: string;
	reason?: string;
	message?: string;
}

export interface UpdateInstructions {
	manual: boolean;
	command?: string;
	newBinaryPath?: string;
	updatePath?: string;
	message: string;
}

export interface UpdateDownloadResult {
	success: boolean;
	version?: string;
	ready?: boolean;
	updatePath?: string;
	artifactPath?: string;
	newBinaryPath?: string;
	directory?: string;
	placed?: boolean;
	selfUpdateAvailable?: boolean;
	canAutoRestart?: boolean;
	manualOnly?: boolean;
	instructions?: UpdateInstructions;
	error?: string;
	code?: string;
	reason?: string;
	message?: string;
}

function errorToMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

interface UpdateFailureDiagnostic {
	error: string;
	code?: string;
	reason?: string;
	message?: string;
}

function createErrorProgress(error: string, diagnostic?: UpdateFailureDiagnostic): UpdateProgress {
	return {
		phase: "error",
		bytesDownloaded: 0,
		totalBytes: 0,
		percent: 0,
		error,
		code: diagnostic?.code,
		reason: diagnostic?.reason,
		message: diagnostic?.message,
	};
}

function createFailureResult(
	error: string,
	version?: string,
	diagnostic?: UpdateFailureDiagnostic,
): UpdateDownloadResult {
	return {
		success: false,
		error,
		version,
		code: diagnostic?.code,
		reason: diagnostic?.reason,
		message: diagnostic?.message,
	};
}

export function extractUpdateFailureDiagnostic(
	payload: Record<string, unknown>,
	fallback = "Update download failed",
): UpdateFailureDiagnostic {
	return {
		error:
			(typeof payload.reason === "string" && payload.reason) ||
			(typeof payload.message === "string" && payload.message) ||
			(typeof payload.error === "string" && payload.error) ||
			(typeof payload.code === "string" && payload.code) ||
			fallback,
		code: typeof payload.code === "string" ? payload.code : undefined,
		reason: typeof payload.reason === "string" ? payload.reason : undefined,
		message: typeof payload.message === "string" ? payload.message : undefined,
	};
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
		releaseNotes: data?.releaseInfo?.releaseNotes,
		releaseNotesPerVersion: data?.releaseInfo?.releaseNotesPerVersion,
		releaseDate: data?.releaseInfo?.releaseDate,
		downloadSize: data?.downloadSize,
		totalSize: data?.totalSize,
		strategy: data?.strategy,
		dismiss,
		refetch,
	};
}

export function useUpdateDownload() {
	const updateCapability = useUpdateCapability();
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
			const failBeforeRequest = (error: string) => {
				setProgress(createErrorProgress(error));
				setResult(createFailureResult(error, releaseInfo.version));
			};
			if (!updateCapability.download.supported) {
				failBeforeRequest(
					updateCapability.download.reason ??
						"Update downloads are not available in this backend/runtime.",
				);
				return;
			}
			if (!updateCapability.download.sse) {
				failBeforeRequest("Update downloads require SSE progress support in this frontend.");
				return;
			}
			const declaredBytes = releaseInfo.files.reduce((sum, file) => sum + (file.size || 0), 0);
			if (
				updateCapability.download.maxBytes != null &&
				declaredBytes > updateCapability.download.maxBytes
			) {
				failBeforeRequest(
					`Update download is ${declaredBytes} bytes, exceeding runtime limit ${updateCapability.download.maxBytes} bytes.`,
				);
				return;
			}

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
					const failure = await readFetchError(response, "Download failed");
					const diagnostic = extractUpdateFailureDiagnostic(failure.data, failure.message);
					setProgress(createErrorProgress(diagnostic.error, diagnostic));
					setResult(createFailureResult(diagnostic.error, releaseInfo.version, diagnostic));
					return;
				}

				const reader = response.body?.getReader();
				if (!reader) throw new Error("No response body");

				const decoder = new TextDecoder();
				let buffer = "";
				let receivedTerminalResult = false;
				const parser = createSseEventParser("");

				const markFailure = (failure: UpdateFailureDiagnostic | string) => {
					const diagnostic = typeof failure === "string" ? { error: failure } : failure;
					receivedTerminalResult = true;
					setProgress(createErrorProgress(diagnostic.error, diagnostic));
					setResult(createFailureResult(diagnostic.error, releaseInfo.version, diagnostic));
				};

				const markSuccess = (downloadResult: UpdateDownloadResult) => {
					receivedTerminalResult = true;
					setResult({ ...downloadResult, version: downloadResult.version ?? releaseInfo.version });
					setProgress((current) => {
						if (current?.phase === "complete") return current;
						return {
							phase: "complete",
							bytesDownloaded: current?.bytesDownloaded ?? 0,
							totalBytes: current?.totalBytes ?? 0,
							percent: 100,
						};
					});
				};

				const handleEvent = ({ eventName, data }: ParsedSseEvent) => {
					if (receivedTerminalResult) return;
					const jsonStr = data.trim();
					if (!jsonStr) {
						if (eventName === "error") {
							markFailure("Update download stream emitted an empty error event");
						}
						return;
					}

					let parsed: unknown;
					try {
						parsed = JSON.parse(jsonStr);
					} catch (err) {
						const prefix =
							eventName === "error" ? "Malformed SSE error event" : "Malformed SSE data";
						throw new Error(`${prefix}: ${errorToMessage(err)}`);
					}

					if (!parsed || typeof parsed !== "object") {
						throw new Error(`Malformed SSE data: expected object, got ${typeof parsed}`);
					}

					const payload = parsed as Partial<UpdateProgress & UpdateDownloadResult>;
					const payloadRecord = payload as Record<string, unknown>;
					if (payload.phase) {
						setProgress(payload as UpdateProgress);
					}

					const diagnostic = extractUpdateFailureDiagnostic(payloadRecord);
					if (eventName === "error" || payload.phase === "error") {
						markFailure(diagnostic);
						return;
					}

					if (typeof payload.success === "boolean") {
						const downloadResult = payload as UpdateDownloadResult;
						if (downloadResult.success) {
							markSuccess(downloadResult);
						} else {
							markFailure(diagnostic);
						}
					}
				};

				const flushLines = (final = false) => {
					buffer = drainCompleteSseLines(buffer, (line) => {
						const event = parser.handleLine(line);
						if (event) handleEvent(event);
					});
					if (!final) return;
					if (buffer.length > 0) {
						const finalLine = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
						const event = parser.handleLine(finalLine);
						if (event) handleEvent(event);
						buffer = "";
					}
					const event = parser.flushPending();
					if (event) handleEvent(event);
				};

				while (true) {
					const { done, value } = await reader.read();
					if (done) break;

					buffer += decoder.decode(value, { stream: true });
					flushLines();
					await enforceSseResidualLimit(buffer, reader);
				}

				buffer += decoder.decode();
				flushLines(true);
				if (!receivedTerminalResult) {
					markFailure("Update download stream ended without a terminal result");
				}
			} catch (err) {
				if ((err as Error).name === "AbortError") {
					setProgress(null);
					return;
				}
				const error = errorToMessage(err);
				setProgress(createErrorProgress(error));
				setResult(createFailureResult(error, releaseInfo.version));
			} finally {
				abortControllerRef.current = null;
			}
		},
		[
			updateCapability.download.maxBytes,
			updateCapability.download.reason,
			updateCapability.download.sse,
			updateCapability.download.supported,
		],
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

export function useUpdateApply() {
	const updateCapability = useUpdateCapability();
	const autoApplyAvailable =
		updateCapability.apply.supported &&
		updateCapability.selfUpdateAvailable &&
		!updateCapability.manualOnly &&
		updateCapability.canAutoRestart;
	const [isApplying, setIsApplying] = useState(false);
	const [applyResult, setApplyResult] = useState<{
		success: boolean;
		error?: string;
		newBinaryPath?: string;
		restarting?: boolean;
		replacementPid?: number;
	} | null>(null);

	const apply = useCallback(
		async (version?: string) => {
			if (!autoApplyAvailable) {
				const result = {
					success: false,
					error:
						updateCapability.apply.reason ??
						"Automatic update apply is not available in this backend/runtime.",
				};
				setApplyResult(result);
				return result;
			}
			setIsApplying(true);
			setApplyResult(null);
			try {
				const result = await api.applyUpdate(version);
				setApplyResult(result);
				if (!result.success) {
					setIsApplying(false);
				}
				// If successful, the server will exit — isApplying stays true
				return result;
			} catch (err) {
				const result = { success: false, error: errorToMessage(err) };
				setApplyResult(result);
				setIsApplying(false);
				return result;
			}
		},
		[autoApplyAvailable, updateCapability.apply.reason],
	);

	return { apply, isApplying, applyResult };
}
