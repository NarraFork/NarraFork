import { Box } from "@mantine/core";
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useLayoutEffect,
	useMemo,
	useReducer,
	useRef,
} from "react";
import type { PluginDockPanelParams } from "./protocol";
import { PluginUiSession } from "./runtime";
import {
	createPluginUiBackendSession,
	type MaterializedPluginUiSession,
	revokePluginUiBackendSession,
} from "./session-client";
import type {
	PluginPanelSlotProps,
	PluginUiContribution,
	PluginUiRuntimeApi,
	PluginUiRuntimeProviderProps,
	PluginUiSessionSnapshot,
} from "./types";

interface SlotRecord {
	element: HTMLElement;
	priority: number;
	visible: boolean;
	active: boolean;
	rect: { left: number; top: number; width: number; height: number };
}

interface SessionRecord {
	params: PluginDockPanelParams;
	contribution: PluginUiContribution;
	materialized?: MaterializedPluginUiSession;
	controller?: PluginUiSession;
	snapshot: PluginUiSessionSnapshot;
	requestGeneration: number;
	abortController: AbortController;
	revoked: boolean;
}

interface RuntimeContextValue extends PluginUiRuntimeApi {
	getSessions: () => SessionRecord[];
	getSlots: (panelInstanceId: string) => SlotRecord[];
}

const RuntimeContext = createContext<RuntimeContextValue | null>(null);

function readRect(element: HTMLElement): SlotRecord["rect"] {
	const rect = element.getBoundingClientRect();
	return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

function isSlotVisible(slot: SlotRecord): boolean {
	return slot.visible && slot.rect.width > 0 && slot.rect.height > 0;
}

export function usePluginUiRuntime(): RuntimeContextValue {
	const value = useContext(RuntimeContext);
	if (!value) throw new Error("PluginUiRuntimeProvider is required");
	return value;
}

export function useOptionalPluginUiRuntime(): RuntimeContextValue | null {
	return useContext(RuntimeContext);
}

export function PluginUiRuntimeProvider({
	children,
	resolveContribution,
	getContext,
	onRequest,
	onBackendRequest,
	onNotification,
	defaultTimeoutMs,
}: PluginUiRuntimeProviderProps) {
	const [, rerender] = useReducer((value) => value + 1, 0);
	const sessionsRef = useRef(new Map<string, SessionRecord>());
	const slotsRef = useRef(new Map<string, Map<HTMLElement, SlotRecord>>());
	const disposeTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
	const rerenderSoon = useCallback(() => queueMicrotask(() => rerender()), []);

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

	const ensureSession = useCallback(
		(params: PluginDockPanelParams, contribution: PluginUiContribution): void => {
			const existing = sessionsRef.current.get(params.panelInstanceId);
			if (
				existing &&
				existing.params.pluginId === params.pluginId &&
				existing.params.contributionId === params.contributionId &&
				existing.contribution.version === contribution.version &&
				existing.contribution.packageHash === contribution.packageHash &&
				existing.contribution.entryPath === contribution.entryPath &&
				existing.contribution.stylePath === contribution.stylePath
			) {
				const timer = disposeTimersRef.current.get(params.panelInstanceId);
				if (timer) clearTimeout(timer);
				disposeTimersRef.current.delete(params.panelInstanceId);
				return;
			}
			if (existing) {
				disposeRecord(existing);
				sessionsRef.current.delete(params.panelInstanceId);
			}
			const record: SessionRecord = {
				params,
				contribution,
				snapshot: { panelInstanceId: params.panelInstanceId, status: "pending" },
				requestGeneration: (existing?.requestGeneration ?? 0) + 1,
				abortController: new AbortController(),
				revoked: false,
			};
			sessionsRef.current.set(params.panelInstanceId, record);
			rerenderSoon();
			void createPluginUiBackendSession(params, contribution, record.abortController.signal)
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
							params,
							contribution: materialized.contribution,
							nonce: materialized.nonce,
							getContext,
							onRequest: onBackendRequest
								? (context) =>
										onBackendRequest({
											sessionId: materialized.backendSessionId,
											sessionToken: materialized.sessionToken,
											params,
											request: context.request,
											signal: context.signal,
										})
								: onRequest,
							onNotification,
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
			getContext,
			onNotification,
			onRequest,
			onBackendRequest,
			rerenderSoon,
			revokeSession,
		],
	);

	const getSessionSnapshot = useCallback(
		(panelInstanceId: string) => sessionsRef.current.get(panelInstanceId)?.snapshot,
		[],
	);

	const reloadSession = useCallback(
		(panelInstanceId: string) => {
			const record = sessionsRef.current.get(panelInstanceId);
			if (!record) return;
			disposeRecord(record);
			sessionsRef.current.delete(panelInstanceId);
			rerender();
			ensureSession(record.params, record.contribution);
		},
		[disposeRecord, ensureSession],
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

	const getSessions = useCallback(() => [...sessionsRef.current.values()], []);
	const getSlots = useCallback(
		(panelInstanceId: string) => [...(slotsRef.current.get(panelInstanceId)?.values() ?? [])],
		[],
	);

	const value = useMemo<RuntimeContextValue>(
		() => ({
			resolveContribution,
			ensureSession,
			getSessionSnapshot,
			reloadSession,
			registerSlot,
			updateSlot,
			getSessions,
			getSlots,
		}),
		[
			ensureSession,
			getSessionSnapshot,
			getSessions,
			getSlots,
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
