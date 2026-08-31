import { Box } from "@mantine/core";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useReducer,
	useRef,
	useSyncExternalStore,
} from "react";
import {
	type PluginUiHostLocalRouterOptions,
	type PluginUiPanelDelegate,
	routePluginUiHostLocalRequest,
} from "./host-local-router";
import { pluginContributionStore, toPluginUiContribution } from "./PluginContributionStore";
import type { PluginUiSessionContext } from "./PluginUiSurfaceContext";
/*
 * The context, its record types, the two consumer hooks and `fallbackPluginUiContext` live
 * in `plugin-ui-runtime-context.ts`.
 *
 * Non-component exports here made this module an INVALID Fast Refresh boundary, and this
 * provider is mounted in `App.tsx` — so the invalidation sat on the app shell's own
 * propagation path and turned shell edits into full page reloads. See that file's header.
 */
import {
	fallbackPluginUiContext,
	RuntimeContext,
	type RuntimeContextValue,
	type SessionRecord,
	type SlotRecord,
	usePluginUiRuntime,
} from "./plugin-ui-runtime-context";
import type { PluginDockPanelParams } from "./protocol";
import { parsePluginDockPanelParams } from "./protocol";
import { PluginUiSession } from "./runtime";
import {
	createPluginUiBackendSession,
	type MaterializedPluginUiSession,
	PluginUiRpcError,
	revokePluginUiBackendSession,
} from "./session-client";
import { PluginUiSessionRecoveryBudget } from "./session-recovery";
import type {
	PluginPanelSlotProps,
	PluginUiContext,
	PluginUiContribution,
	PluginUiRequestContext,
	PluginUiRuntimeProviderProps,
} from "./types";

function readRect(element: HTMLElement): SlotRecord["rect"] {
	const rect = element.getBoundingClientRect();
	return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

function isSlotVisible(slot: SlotRecord): boolean {
	return slot.visible && slot.rect.width > 0 && slot.rect.height > 0;
}

/** Session-identity fields: when any of these change the session must be rebuilt. */
function sameSessionIdentity(a: SessionRecord, contribution: PluginUiContribution): boolean {
	return (
		a.contribution.version === contribution.version &&
		(a.contribution.packageHash ?? a.contribution.contentHash) ===
			(contribution.packageHash ?? contribution.contentHash) &&
		a.contribution.entryPath === contribution.entryPath &&
		a.contribution.stylePath === contribution.stylePath
	);
}

function sameSessionContext(a: PluginUiSessionContext, b: PluginUiSessionContext): boolean {
	return (
		a.surface === b.surface &&
		a.workspaceId === b.workspaceId &&
		a.projectId === b.projectId &&
		a.narratorId === b.narratorId &&
		a.chapterId === b.chapterId &&
		a.presentation === b.presentation
	);
}

function isSessionInvalidError(error: unknown): boolean {
	if (error instanceof PluginUiRpcError) return error.code === "PLUGIN_UI_SESSION_INVALID";
	if (error && typeof error === "object" && !Array.isArray(error)) {
		return (error as { code?: unknown }).code === "PLUGIN_UI_SESSION_INVALID";
	}
	return false;
}

export function PluginUiRuntimeProvider({
	children,
	resolveContribution,
	getContext,
	onRequest,
	onBackendRequest,
	onNotification,
	defaultTimeoutMs,
	hostLocal,
	onSessionInvalid,
}: PluginUiRuntimeProviderProps) {
	const [sessionRevision, rerender] = useReducer((value) => value + 1, 0);
	const sessionsRef = useRef(new Map<string, SessionRecord>());
	const slotsRef = useRef(new Map<string, Map<HTMLElement, SlotRecord>>());
	const disposeTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
	const panelDelegatesRef = useRef(new Map<string, PluginUiPanelDelegate>());
	// One transparent rebuild per backend session generation. A successful rebuild
	// (or an explicit/identity reload) resets the budget for the next TTL expiry.
	const sessionRecoveryBudgetRef = useRef(new PluginUiSessionRecoveryBudget());
	const rerenderSoon = useCallback(() => queueMicrotask(() => rerender()), []);

	// Reactive contribution snapshot: host-owned store is the only runtime
	// registry. Subscribing here makes every dependent re-render when a backend
	// snapshot lands (login sync, WS resync, lifecycle invalidation).
	const contributionSnapshot = useSyncExternalStore(
		pluginContributionStore.subscribe,
		pluginContributionStore.getSnapshot,
		pluginContributionStore.getSnapshot,
	);

	// Latest-callback refs so session closures never go stale without churning
	// the stable api identities consumed by Dockview panels.
	const getContextRef = useRef(getContext);
	getContextRef.current = getContext;
	const onRequestRef = useRef(onRequest);
	onRequestRef.current = onRequest;
	const onBackendRequestRef = useRef(onBackendRequest);
	onBackendRequestRef.current = onBackendRequest;
	const onNotificationRef = useRef(onNotification);
	onNotificationRef.current = onNotification;
	const hostLocalRef = useRef(hostLocal);
	hostLocalRef.current = hostLocal;
	const onSessionInvalidRef = useRef(onSessionInvalid);
	onSessionInvalidRef.current = onSessionInvalid;

	const resolveContext = useCallback(
		(
			params: PluginDockPanelParams,
			sessionContext: PluginUiSessionContext,
			contribution: PluginUiContribution,
		): PluginUiContext =>
			getContextRef.current?.(params, sessionContext, contribution) ??
			fallbackPluginUiContext(params, sessionContext, contribution),
		[],
	);

	const revokeSession = useCallback((sessionId: string) => {
		void revokePluginUiBackendSession(sessionId).catch(() => {});
	}, []);

	const disposeRecord = useCallback(
		(record: SessionRecord) => {
			record.abortController.abort();
			record.controller?.dispose();
			if (record.materialized && !record.revoked) {
				record.revoked = true;
				revokeSession(record.materialized.backendSessionId);
			}
		},
		[revokeSession],
	);

	/** Host-local method routing: context/panel/notifications never hit the backend. */
	const handleHostLocal = useCallback(
		(context: PluginUiRequestContext): ReturnType<typeof routePluginUiHostLocalRequest> => {
			const options: PluginUiHostLocalRouterOptions = {
				getContext: (params) => {
					const record = sessionsRef.current.get(params.panelInstanceId);
					return record
						? resolveContext(record.params, record.sessionContext, record.contribution)
						: undefined;
				},
				getPanelDelegate: (panelInstanceId) => panelDelegatesRef.current.get(panelInstanceId),
				showNotification: hostLocalRef.current?.showNotification,
				openPanel: hostLocalRef.current?.openPanel,
				openExternal: hostLocalRef.current?.openExternal,
			};
			return routePluginUiHostLocalRequest(context, options);
		},
		[resolveContext],
	);

	const handleBackendRequest = useCallback(
		(record: SessionRecord, materialized: MaterializedPluginUiSession) => {
			const backend = onBackendRequestRef.current;
			const legacy = onRequestRef.current;
			if (!backend) return legacy;
			return (context: PluginUiRequestContext) =>
				Promise.resolve()
					.then(() =>
						backend({
							sessionId: materialized.backendSessionId,
							sessionToken: materialized.sessionToken,
							params: record.params,
							request: context.request,
							signal: context.signal,
						}),
					)
					.catch((error: unknown) => {
						if (!isSessionInvalidError(error)) throw error;
						// Session 401: transparently rebuild exactly once (generation bumps
						// inside reloadSession), then let the plugin retry its call.
						if (sessionRecoveryBudgetRef.current.consume(record.params.panelInstanceId)) {
							onSessionInvalidRef.current?.(record.params.panelInstanceId);
							if (!onSessionInvalidRef.current) {
								queueMicrotask(() =>
									reloadSessionRef.current(record.params.panelInstanceId, false),
								);
							}
						}
						throw error;
					});
		},
		[],
	);

	const ensureSession = useCallback(
		(
			params: PluginDockPanelParams,
			contribution: PluginUiContribution,
			sessionContext: PluginUiSessionContext,
		): void => {
			const existing = sessionsRef.current.get(params.panelInstanceId);
			if (
				existing &&
				existing.params.pluginId === params.pluginId &&
				existing.params.contributionId === params.contributionId &&
				sameSessionIdentity(existing, contribution) &&
				sameSessionContext(existing.sessionContext, sessionContext)
			) {
				existing.params = params;
				existing.controller?.updateParams(params);
				const timer = disposeTimersRef.current.get(params.panelInstanceId);
				if (timer) clearTimeout(timer);
				disposeTimersRef.current.delete(params.panelInstanceId);
				return;
			}
			if (existing) {
				sessionRecoveryBudgetRef.current.reset(params.panelInstanceId);
				disposeRecord(existing);
				sessionsRef.current.delete(params.panelInstanceId);
			}
			const record: SessionRecord = {
				params,
				sessionContext,
				contribution,
				snapshot: { panelInstanceId: params.panelInstanceId, status: "pending" },
				requestGeneration: (existing?.requestGeneration ?? 0) + 1,
				rebuildAttempts: (existing?.rebuildAttempts ?? 0) + 1,
				abortController: new AbortController(),
				revoked: false,
			};
			sessionsRef.current.set(params.panelInstanceId, record);
			rerenderSoon();
			void createPluginUiBackendSession(
				params,
				contribution,
				sessionContext,
				record.abortController.signal,
			)
				.then((materialized) => {
					const current = sessionsRef.current.get(params.panelInstanceId);
					if (current !== record || record.abortController.signal.aborted) {
						revokeSession(materialized.backendSessionId);
						return;
					}
					record.materialized = materialized;
					try {
						let controller: PluginUiSession;
						controller = new PluginUiSession({
							params: record.params,
							contribution: materialized.contribution,
							nonce: materialized.nonce,
							getContext: () =>
								resolveContext(record.params, record.sessionContext, record.contribution),
							onRequest: (context) => {
								const local = handleHostLocal(context);
								if (local !== null) return local;
								const backend = handleBackendRequest(record, materialized);
								if (!backend) {
									// Declared backend method without any wired handler: report a
									// structured error instead of faking success.
									throw new PluginUiRpcError(
										"HOST_UNAVAILABLE",
										`Plugin UI backend method has no host implementation: ${context.request.method}`,
										{ retryable: false },
									);
								}
								return backend(context);
							},
							onNotification: (p, notification) => onNotificationRef.current?.(p, notification),
							defaultTimeoutMs,
							onStateChange: (snapshot) => {
								const latest = sessionsRef.current.get(params.panelInstanceId);
								if (latest?.controller !== controller) return;
								latest.snapshot = snapshot;
								rerender();
							},
						});
						record.controller = controller;
						record.contribution = materialized.contribution;
						record.snapshot = controller.getSnapshot();
						sessionRecoveryBudgetRef.current.reset(params.panelInstanceId);
					} catch (error) {
						record.snapshot = {
							panelInstanceId: params.panelInstanceId,
							status: "error",
							diagnosticId: `pui_${params.panelInstanceId}_${record.requestGeneration}`,
							error: error instanceof Error ? error.message : String(error),
						};
						disposeRecord(record);
					}
					rerender();
				})
				.catch((error: unknown) => {
					const current = sessionsRef.current.get(params.panelInstanceId);
					if (current !== record || record.abortController.signal.aborted) return;
					record.snapshot = {
						panelInstanceId: params.panelInstanceId,
						status: "error",
						diagnosticId: `pui_${params.panelInstanceId}_${record.requestGeneration}`,
						error: error instanceof Error ? error.message : String(error),
					};
					rerender();
				});
		},
		[
			defaultTimeoutMs,
			disposeRecord,
			handleBackendRequest,
			handleHostLocal,
			resolveContext,
			rerenderSoon,
			revokeSession,
		],
	);

	const updateSessionParams = useCallback(
		(panelInstanceId: string, params: PluginDockPanelParams) => {
			const parsed = parsePluginDockPanelParams(params);
			const record = sessionsRef.current.get(panelInstanceId);
			if (
				!parsed ||
				!record ||
				parsed.panelInstanceId !== panelInstanceId ||
				parsed.pluginId !== record.params.pluginId ||
				parsed.contributionId !== record.params.contributionId
			) {
				return;
			}
			record.params = parsed;
			record.controller?.updateParams(parsed);
			rerenderSoon();
		},
		[rerenderSoon],
	);

	const getSessionSnapshot = useCallback(
		(panelInstanceId: string) => sessionsRef.current.get(panelInstanceId)?.snapshot,
		[],
	);

	const reloadSession = useCallback(
		(panelInstanceId: string, resetRecoveryBudget = true) => {
			const record = sessionsRef.current.get(panelInstanceId);
			if (!record) return;
			if (resetRecoveryBudget) sessionRecoveryBudgetRef.current.reset(panelInstanceId);
			disposeRecord(record);
			sessionsRef.current.delete(panelInstanceId);
			rerender();
			ensureSession(record.params, record.contribution, record.sessionContext);
		},
		[disposeRecord, ensureSession],
	);
	const reloadSessionRef = useRef(reloadSession);
	reloadSessionRef.current = reloadSession;

	const disposeSession = useCallback(
		(panelInstanceId: string) => {
			const record = sessionsRef.current.get(panelInstanceId);
			if (!record) return;
			sessionRecoveryBudgetRef.current.reset(panelInstanceId);
			disposeRecord(record);
			sessionsRef.current.delete(panelInstanceId);
			rerender();
		},
		[disposeRecord],
	);

	const registerPanelDelegate = useCallback(
		(panelInstanceId: string, delegate: PluginUiPanelDelegate) => {
			panelDelegatesRef.current.set(panelInstanceId, delegate);
			return () => {
				if (panelDelegatesRef.current.get(panelInstanceId) === delegate) {
					panelDelegatesRef.current.delete(panelInstanceId);
				}
			};
		},
		[],
	);

	const registerSlot = useCallback(
		(
			panelInstanceId: string,
			element: HTMLElement,
			options: { priority: number; visible: boolean; active: boolean },
		) => {
			const slots = slotsRef.current.get(panelInstanceId) ?? new Map<HTMLElement, SlotRecord>();
			const slot = { ...options, element, rect: readRect(element) };
			slots.set(element, slot);
			slotsRef.current.set(panelInstanceId, slots);
			const session = sessionsRef.current.get(panelInstanceId);
			const visible = isSlotVisible(slot);
			session?.controller?.setVisibility(visible);
			session?.controller?.setActive(slot.active && visible);
			session?.controller?.setSize(slot.rect.width, slot.rect.height);
			rerender();
			return () => {
				const current = slotsRef.current.get(panelInstanceId);
				current?.delete(element);
				if (current && current.size === 0) {
					slotsRef.current.delete(panelInstanceId);
					const timer = setTimeout(() => {
						if (slotsRef.current.has(panelInstanceId)) return;
						const session = sessionsRef.current.get(panelInstanceId);
						if (session) disposeRecord(session);
						sessionRecoveryBudgetRef.current.reset(panelInstanceId);
						sessionsRef.current.delete(panelInstanceId);
						disposeTimersRef.current.delete(panelInstanceId);
						rerender();
					}, 0);
					disposeTimersRef.current.set(panelInstanceId, timer);
				}
				rerender();
			};
		},
		[disposeRecord],
	);

	const updateSlot = useCallback(
		(
			panelInstanceId: string,
			element: HTMLElement,
			options: { priority: number; visible: boolean; active: boolean },
		) => {
			const slot = slotsRef.current.get(panelInstanceId)?.get(element);
			if (!slot) return;
			Object.assign(slot, options, { rect: readRect(element) });
			const session = sessionsRef.current.get(panelInstanceId);
			const visible = isSlotVisible(slot);
			session?.controller?.setVisibility(visible);
			session?.controller?.setActive(slot.active && visible);
			session?.controller?.setSize(slot.rect.width, slot.rect.height);
			rerender();
		},
		[],
	);

	// Dispose sessions whose contribution became unavailable (disabled/denied/
	// incompatible) or vanished from the host snapshot. The panel itself stays
	// mounted and renders the matching placeholder — we never auto-close a
	// panel the user may not have saved.
	useEffect(() => {
		if (!contributionSnapshot.synced) return;
		for (const record of [...sessionsRef.current.values()]) {
			const item = pluginContributionStore.get(
				record.params.pluginId,
				record.params.contributionId,
			);
			if (!item || item.availability !== "available") {
				disposeRecord(record);
				sessionsRef.current.delete(record.params.panelInstanceId);
				rerenderSoon();
				continue;
			}
			// Identity drift (hash/version/entry/style change) → rebuild against
			// the new identity so stale iframes/sessions are never reused.
			const next = toPluginUiContribution(item);
			if (!sameSessionIdentity(record, next)) {
				sessionRecoveryBudgetRef.current.reset(record.params.panelInstanceId);
				disposeRecord(record);
				sessionsRef.current.delete(record.params.panelInstanceId);
				rerenderSoon();
				ensureSession(record.params, next, record.sessionContext);
			}
		}
	}, [contributionSnapshot, disposeRecord, ensureSession, rerenderSoon]);

	const getSessions = useCallback(() => [...sessionsRef.current.values()], []);
	const getSlots = useCallback(
		(panelInstanceId: string) => [...(slotsRef.current.get(panelInstanceId)?.values() ?? [])],
		[],
	);

	const value = useMemo<RuntimeContextValue>(
		() => ({
			revision: contributionSnapshot.revision + sessionRevision,
			resolveContribution,
			ensureSession,
			updateSessionParams,
			getSessionSnapshot,
			reloadSession,
			disposeSession,
			registerPanelDelegate,
			registerSlot,
			updateSlot,
			getSessions,
			getSlots,
		}),
		[
			contributionSnapshot.revision,
			sessionRevision,
			ensureSession,
			updateSessionParams,
			getSessionSnapshot,
			getSessions,
			getSlots,
			disposeSession,
			registerPanelDelegate,
			registerSlot,
			reloadSession,
			resolveContribution,
			updateSlot,
		],
	);

	useEffect(
		() => () => {
			for (const timer of disposeTimersRef.current.values()) clearTimeout(timer);
			for (const session of sessionsRef.current.values()) disposeRecord(session);
			sessionsRef.current.clear();
			slotsRef.current.clear();
			panelDelegatesRef.current.clear();
			sessionRecoveryBudgetRef.current.clear();
		},
		[disposeRecord],
	);

	return (
		<RuntimeContext.Provider value={value}>
			{children}
			<PluginUiLayer />
		</RuntimeContext.Provider>
	);
}

// `fallbackPluginUiContext` moved to `plugin-ui-runtime-context.ts` — see the import
// comment at the top of this file.

/** Stable top-level layer. A session keeps one iframe while slots move between surfaces. */
export function PluginUiLayer() {
	const runtime = usePluginUiRuntime();
	return (
		<Box
			style={{ position: "fixed", inset: 0, zIndex: 20, pointerEvents: "none", overflow: "hidden" }}
		>
			{runtime.getSessions().map((session) => {
				const slot = runtime
					.getSlots(session.params.panelInstanceId)
					.filter(isSlotVisible)
					.sort((a, b) => b.priority - a.priority)[0];
				if (
					!slot ||
					!session.controller ||
					["pending", "error", "crashed", "disposed"].includes(session.snapshot.status)
				)
					return null;
				const controller = session.controller;
				return (
					<Box
						key={session.params.panelInstanceId}
						style={{
							position: "fixed",
							left: slot.rect.left,
							top: slot.rect.top,
							width: slot.rect.width,
							height: slot.rect.height,
							pointerEvents: slot.active ? "auto" : "none",
							overflow: "hidden",
						}}
					>
						<iframe
							srcDoc={controller.getSrcdoc()}
							sandbox="allow-scripts"
							allow=""
							referrerPolicy="no-referrer"
							title={session.contribution.title}
							onLoad={(event) => controller.attach(event.currentTarget)}
							onFocus={() => controller.setFocused(true)}
							onBlur={() => controller.setFocused(false)}
							style={{
								width: "100%",
								height: "100%",
								border: 0,
								display: "block",
								pointerEvents: slot.active ? "auto" : "none",
							}}
						/>
					</Box>
				);
			})}
		</Box>
	);
}

export function PluginPanelSlot({
	panelInstanceId,
	priority = 0,
	visible = true,
	active = true,
	children,
}: PluginPanelSlotProps) {
	const runtime = usePluginUiRuntime();
	const elementRef = useRef<HTMLDivElement | null>(null);
	const unregisterRef = useRef<(() => void) | null>(null);

	useLayoutEffect(() => {
		const element = elementRef.current;
		if (!element) return;
		unregisterRef.current = runtime.registerSlot(panelInstanceId, element, {
			priority,
			visible,
			active,
		});
		const update = () =>
			runtime.updateSlot(panelInstanceId, element, { priority, visible, active });
		const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
		observer?.observe(element);
		window.addEventListener("resize", update);
		return () => {
			observer?.disconnect();
			window.removeEventListener("resize", update);
			unregisterRef.current?.();
			unregisterRef.current = null;
		};
	}, [active, panelInstanceId, priority, runtime, visible]);

	return (
		<div
			ref={elementRef}
			onFocusCapture={() => {
				if (elementRef.current)
					runtime.updateSlot(panelInstanceId, elementRef.current, {
						priority,
						visible,
						active: true,
					});
			}}
			onBlurCapture={() => {
				if (elementRef.current)
					runtime.updateSlot(panelInstanceId, elementRef.current, { priority, visible, active });
			}}
			style={{ width: "100%", height: "100%", minWidth: 0, minHeight: 0 }}
		>
			{children}
		</div>
	);
}
