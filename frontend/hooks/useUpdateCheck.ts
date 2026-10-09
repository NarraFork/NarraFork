import {
	type PreparedUpdateIdentity,
	sameUpdateSourceIdentity,
	updateSourceIdentityKey,
} from "@shared/update-identity";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import i18n from "i18next";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, authorizedFetch, readFetchError } from "../lib/api";
import {
	sameUpdateSource,
	settingsSourceIdentity,
	updateCheckErrorKey,
	updateSettingsKey,
} from "../lib/update-source";
import type { UpdateCoordinationPhase } from "../lib/update-state";

type UpdateReleaseInfo = NonNullable<Awaited<ReturnType<typeof api.checkUpdate>>["releaseInfo"]>;

import { useCurrentUser } from "./useAuth";
import { useUpdateCapability } from "./usePlatform";

/** A disabled/changed selection gets a different key, cancelling and hiding stale notes. */
export function useUpdateNotes(
	release: UpdateReleaseInfo | undefined,
	enabled: boolean,
	preparedId?: string,
) {
	const identity =
		enabled &&
		release?.notesDeferred &&
		release.notesAvailable &&
		release.sourceIdentity?.source === "github"
			? { version: release.version, sha512: release.sha512, sourceIdentity: release.sourceIdentity }
			: null;
	return useQuery({
		queryKey: [
			"update-notes",
			identity ? updateSourceIdentityKey(identity.sourceIdentity) : null,
			identity?.version,
			identity?.sha512,
			preparedId,
		],
		queryFn: ({ signal }) => {
			if (!identity) throw new Error("No selected release notes identity");
			return api.getUpdateNotes(identity, signal);
		},
		enabled: !!identity,
		staleTime: 5 * 60_000,
		gcTime: 5 * 60_000,
		retry: false,
	});
}

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
	strategy?: "full" | "zstd";
	fallback?: boolean;
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
	preparedIdentity?: PreparedUpdateIdentity;
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
	phase?: UpdateProgress["phase"] | UpdateCoordinationPhase;
	scheduled?: boolean;
	targetVersion?: string;
	pendingExecutionCount?: number;
	pendingBackgroundBashCount?: number;
	pendingOrdinaryExecutionCount?: number;
	resumableExecutionCount?: number;
	pausedToolCount?: number;
	drainStartedAt?: string;
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
	fallback = i18n.t("common:updateDownloadFailed"),
): UpdateFailureDiagnostic {
	return {
		error:
			(typeof payload.reason === "string" && payload.reason) ||
			(typeof payload.message === "string" && payload.message) ||
			(typeof payload.error === "string" && payload.error) ||
			(typeof payload.code === "string" && payload.code) ||
			fallback,
		code:
			typeof payload.code === "string"
				? payload.code
				: typeof payload.errorCode === "string"
					? payload.errorCode
					: undefined,
		reason: typeof payload.reason === "string" ? payload.reason : undefined,
		message: typeof payload.message === "string" ? payload.message : undefined,
	};
}

async function checkWithSavedSettings(queryClient: QueryClient, signal?: AbortSignal) {
	const settings = await queryClient.ensureQueryData({
		queryKey: ["settings"],
		queryFn: api.getSettings,
	});
	signal?.throwIfAborted();
	const settingsKey = updateSettingsKey(settings.update);
	const checked = await api.checkUpdate();
	signal?.throwIfAborted();
	const currentSettings = queryClient.getQueryData<Awaited<ReturnType<typeof api.getSettings>>>([
		"settings",
	]);
	const identity = checked.sourceIdentity ?? checked.releaseInfo?.sourceIdentity;
	if (
		(currentSettings && updateSettingsKey(currentSettings.update) !== settingsKey) ||
		(identity &&
			!sameUpdateSourceIdentity(
				identity,
				settingsSourceIdentity(settings.update, identity.platform),
			))
	) {
		return {
			...checked,
			updateAvailable: false,
			releaseInfo: undefined,
			errorCode: "UPDATE_SOURCE_CHANGED",
			error: i18n.t("common:updateSourceChanged"),
			settingsKey,
		};
	}
	return { ...checked, settingsKey };
}

/**
 * Poll the configured update source for a newer release.
 *
 * `GET /api/update/check` is admin-only: it makes the deployment emit an outbound request and
 * replies with release metadata and download URLs. The admin gate therefore lives HERE rather
 * than in each caller — this hook already owns the `enabled` decision through `intervalMs`, and
 * the only consumer (`UpdateBadge`) renders for every signed-in user via the app shell. Leaving
 * the gate to callers guaranteed a 403 per interval for non-admins and would silently repeat that
 * for every future caller.
 *
 * A non-admin therefore gets a query that never runs: `updateAvailable` stays false and the badge
 * renders nothing, which is the right outcome since acting on a result (`/download`, `/apply`) is
 * admin-only too.
 */
export function useUpdateCheck(intervalMs = 60 * 60_000) {
	const [dismissed, setDismissed] = useState(false);
	const queryClient = useQueryClient();
	const { data: user } = useCurrentUser();
	const isAdmin = user?.role === "admin";

	const {
		data,
		isLoading,
		error: queryError,
		refetch: refetchQuery,
	} = useQuery({
		queryKey: ["update-check"],
		queryFn: ({ signal }) => checkWithSavedSettings(queryClient, signal),
		refetchInterval: intervalMs,
		staleTime: intervalMs,
		enabled: isAdmin && intervalMs > 0,
	});

	// `refetch()` ignores `enabled` in React Query v5, so exposing it raw would reopen the same
	// guaranteed 403 through any caller that wires it to a "check now" control.
	const refetch = useCallback(async () => {
		if (!isAdmin) return;
		await refetchQuery();
	}, [isAdmin, refetchQuery]);

	const checkFailed = !!queryError || !!data?.error || !!data?.errorCode;
	const updateAvailable = !dismissed && !checkFailed && data?.updateAvailable === true;

	// Auto-reset dismissed flag when version changes
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentionally re-run when latestVersion changes
	useEffect(() => {
		setDismissed(false);
	}, [data?.latestVersion, data?.source, data?.repository, data?.settingsKey]);

	const dismiss = useCallback(() => setDismissed(true), []);

	return {
		updateAvailable,
		isLoading,
		checkFailed,
		error: data?.error ?? queryError?.message,
		errorCode: data?.errorCode,
		errorKey: checkFailed ? updateCheckErrorKey(data?.errorCode) : undefined,
		retryAfter: data?.retryAfter,
		source: data?.source,
		repository: data?.repository,
		settingsKey: data?.settingsKey,
		sourceIdentity: data?.sourceIdentity,
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
	const queryClient = useQueryClient();
	const [progress, setProgress] = useState<UpdateProgress | null>(null);
	const [result, setResult] = useState<UpdateDownloadResult | null>(null);
	const abortControllerRef = useRef<AbortController | null>(null);
	useEffect(
		() => () => {
			abortControllerRef.current?.abort();
			abortControllerRef.current = null;
		},
		[],
	);
	const downloadRef = useRef<
		| ((
				info: UpdateReleaseInfo,
				options?: { retry?: boolean; autoRetried?: boolean },
		  ) => Promise<void>)
		| null
	>(null);

	const download = useCallback(
		async (
			releaseInfo: UpdateReleaseInfo,
			options?: { retry?: boolean; autoRetried?: boolean },
		) => {
			const failBeforeRequest = (error: string) => {
				setProgress(createErrorProgress(error));
				setResult(createFailureResult(error, releaseInfo.version));
			};
			if (!updateCapability.download.supported) {
				failBeforeRequest(
					updateCapability.download.reason ?? i18n.t("common:updateDownloadUnavailable"),
				);
				return;
			}
			if (!updateCapability.download.sse) {
				failBeforeRequest(i18n.t("common:updateDownloadRequiresSse"));
				return;
			}
			const declaredBytes = releaseInfo.files.reduce((sum, file) => sum + (file.size || 0), 0);
			if (
				updateCapability.download.maxBytes != null &&
				declaredBytes > updateCapability.download.maxBytes
			) {
				failBeforeRequest(
					i18n.t("common:updateDownloadTooLarge", {
						bytes: declaredBytes,
						limit: updateCapability.download.maxBytes,
					}),
				);
				return;
			}

			setProgress({ phase: "checking", bytesDownloaded: 0, totalBytes: 0, percent: 0 });
			setResult(null);

			abortControllerRef.current?.abort();
			const controller = new AbortController();
			abortControllerRef.current = controller;

			try {
				const settingsAtStart = await queryClient.ensureQueryData({
					queryKey: ["settings"],
					queryFn: api.getSettings,
				});
				controller.signal.throwIfAborted();
				const requestSettingsKey = updateSettingsKey(settingsAtStart.update);
				const response = await authorizedFetch("/api/update/download", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						releaseInfo: {
							version: releaseInfo.version,
							sha512: releaseInfo.sha512,
							sourceIdentity: releaseInfo.sourceIdentity,
						},
						source: releaseInfo.source ?? "update-server",
						repository: releaseInfo.repository,
						retry: options?.retry === true,
					}),
					signal: controller.signal,
				});
				controller.signal.throwIfAborted();

				if (!response.ok) {
					const failure = await readFetchError(response, "Download failed");
					controller.signal.throwIfAborted();
					// A version conflict may be rechecked once, but a source or artifact identity
					// change requires a new explicit selection, never a transparent download.
					const conflictCode = failure.data.code ?? failure.data.errorCode;
					if (
						response.status === 409 &&
						conflictCode !== "UPDATE_SOURCE_CHANGED" &&
						conflictCode !== "UPDATE_ARTIFACT_CHANGED" &&
						!options?.autoRetried
					) {
						try {
							const rechecked = await queryClient.fetchQuery({
								queryKey: ["update-check"],
								queryFn: () => checkWithSavedSettings(queryClient, controller.signal),
							});
							controller.signal.throwIfAborted();
							if (
								!rechecked.error &&
								!rechecked.errorCode &&
								rechecked.updateAvailable &&
								rechecked.releaseInfo &&
								rechecked.settingsKey === requestSettingsKey &&
								sameUpdateSource(releaseInfo, rechecked.releaseInfo)
							) {
								await downloadRef.current?.(rechecked.releaseInfo, {
									retry: options?.retry,
									autoRetried: true,
								});
								return;
							}
						} catch {
							// Fall through to surface the original 409 failure below.
						}
					}
					controller.signal.throwIfAborted();
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
					setProgress((current) => ({
						...createErrorProgress(diagnostic.error, diagnostic),
						strategy: current?.strategy,
						fallback: current?.fallback,
					}));
					setResult(createFailureResult(diagnostic.error, releaseInfo.version, diagnostic));
				};

				const markSuccess = (downloadResult: UpdateDownloadResult) => {
					receivedTerminalResult = true;
					setResult({ ...downloadResult, version: downloadResult.version ?? releaseInfo.version });
					setProgress((current) => {
						if (current?.phase === "complete") return current;
						return {
							strategy: current?.strategy,
							fallback: current?.fallback,
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
							markFailure(i18n.t("common:updateStreamEmptyError"));
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
						setProgress((current) => ({
							...(payload as UpdateProgress),
							strategy: payload.strategy ?? current?.strategy,
							fallback: payload.fallback ?? current?.fallback,
						}));
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
					controller.signal.throwIfAborted();
					if (done) break;

					buffer += decoder.decode(value, { stream: true });
					flushLines();
					await enforceSseResidualLimit(buffer, reader);
				}

				buffer += decoder.decode();
				flushLines(true);
				if (!receivedTerminalResult) {
					markFailure(i18n.t("common:updateStreamNoResult"));
				}
			} catch (err) {
				if (controller.signal.aborted || (err as Error).name === "AbortError") {
					if (abortControllerRef.current === controller) setProgress(null);
					return;
				}
				// Malformed/failed streams must not leave a server-side patch download running.
				controller.abort();
				const error = errorToMessage(err);
				setProgress((current) => ({
					...createErrorProgress(error),
					strategy: current?.strategy,
					fallback: current?.fallback,
				}));
				setResult(createFailureResult(error, releaseInfo.version));
			} finally {
				if (abortControllerRef.current === controller) abortControllerRef.current = null;
			}
		},
		[
			queryClient,
			updateCapability.download.maxBytes,
			updateCapability.download.reason,
			updateCapability.download.sse,
			updateCapability.download.supported,
		],
	);

	// Keep a ref to the latest `download` so the 409 auto-retry path can re-invoke
	// it without adding `download` to its own dependency list.
	downloadRef.current = download;

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

const UPDATE_APPLY_ERROR_KEYS: Record<string, string> = {
	NOT_COMPILED_BINARY: "common:updateApplyErrorNotCompiledBinary",
	NO_PREPARED_UPDATE: "common:updateApplyErrorNoPreparedUpdate",
	PREPARED_UPDATE_NOT_PLACED: "common:updateApplyErrorNotPlaced",
	PREPARED_UPDATE_IDENTITY_REQUIRED: "common:updateApplyIdentityRequired",
	PREPARED_UPDATE_CHANGED: "common:updatePreparedChanged",
};

/** Translate the fixed apply pre-flight codes, keeping unknown server text as-is. */
export function localizeUpdateApplyError(
	error: string | undefined,
	code: string | undefined,
): string | undefined {
	const key = code ? UPDATE_APPLY_ERROR_KEYS[code] : undefined;
	return key ? i18n.t(key) : error;
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
		code?: string;
		newBinaryPath?: string;
		restarting?: boolean;
		scheduled?: boolean;
		phase?: UpdateProgress["phase"] | UpdateCoordinationPhase;
		targetVersion?: string;
		pendingExecutionCount?: number;
		pendingBackgroundBashCount?: number;
		pendingOrdinaryExecutionCount?: number;
		resumableExecutionCount?: number;
		pausedToolCount?: number;
		drainStartedAt?: string;
		replacementPid?: number;
	} | null>(null);

	const apply = useCallback(
		async (version?: string, preparedId?: string) => {
			if (!autoApplyAvailable) {
				const result = {
					success: false,
					error: updateCapability.apply.reason ?? i18n.t("common:updateApplyUnavailable"),
				};
				setApplyResult(result);
				return result;
			}
			setIsApplying(true);
			setApplyResult(null);
			try {
				const response = await api.applyUpdate(version, preparedId);
				const result = {
					...response,
					error: localizeUpdateApplyError(response.error, response.code),
				};
				setApplyResult(result);
				if (!result.success) {
					setIsApplying(false);
				}
				// If successful, the server will exit — isApplying stays true
				return result;
			} catch (err) {
				const diagnostic =
					err instanceof ApiError
						? extractUpdateFailureDiagnostic(err.data ?? {}, err.message)
						: { error: errorToMessage(err), code: undefined };
				const result = {
					success: false,
					code: diagnostic.code,
					error: localizeUpdateApplyError(diagnostic.error, diagnostic.code),
				};
				setApplyResult(result);
				setIsApplying(false);
				return result;
			}
		},
		[autoApplyAvailable, updateCapability.apply.reason],
	);

	return { apply, isApplying, applyResult };
}
