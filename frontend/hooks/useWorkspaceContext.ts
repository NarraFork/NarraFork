import type {
	ListNarratorDeviceWorkspacesResult,
	NarratorDeviceWorkspaceMutationResult,
	NarratorDeviceWorkspaceSummary,
	SelectNarratorDeviceWorkspaceRequest,
	SetNarratorDeviceWorkspaceRequest,
	SwitchWorkingDirectoryRequest,
	WorkspaceContext,
} from "@shared/workspace-context";
import {
	type InfiniteData,
	type QueryClient,
	QueryObserver,
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useEffect } from "react";
import { ApiError, api } from "../lib/api";
import type { DeviceWorkspaceRequestReceipt } from "../lib/api/workspace-context";
import { type ListenerHandle, narratorWSManager } from "../lib/narrator-ws-manager";

export const workspaceContextKey = (id: string) => ["workspaceContext", id] as const;
export const transitionKey = (id: string) => ["workspaceContextTransition", id] as const;
export const deviceWorkspacesKey = (id: string) => ["deviceWorkspaces", id] as const;
export type DeviceWorkspaceIntent =
	| { narratorId: string; kind: "set"; request: SetNarratorDeviceWorkspaceRequest }
	| { narratorId: string; kind: "select"; request: SelectNarratorDeviceWorkspaceRequest };
export interface DeviceWorkspaceTransition {
	phase: "unconfirmed" | "committed_pending" | "superseded" | "not_committed";
	affectsSelection: boolean;
	intent: DeviceWorkspaceIntent;
	result?: NarratorDeviceWorkspaceMutationResult;
}
type WorkspaceTransition = boolean | DeviceWorkspaceTransition;

// An unresolved operation is durable client state, not an ordinary inactive query.
// Pin it even when setQueryData creates the query before any panel mounts. Release
// the observer on resolution so the normal query GC policy applies again.
const transitionPins = new WeakMap<QueryClient, Map<string, () => void>>();
function setWorkspaceTransition(qc: QueryClient, id: string, value: WorkspaceTransition) {
	let pins = transitionPins.get(qc);
	if (!pins) {
		pins = new Map();
		transitionPins.set(qc, pins);
		const clientPins = pins;
		qc.getQueryCache().subscribe((event) => {
			if (event.type === "removed" && event.query.queryKey[0] === "workspaceContextTransition") {
				const removedId = String(event.query.queryKey[1]);
				const release = clientPins.get(removedId);
				clientPins.delete(removedId);
				release?.();
			}
		});
	}
	qc.setQueryData<WorkspaceTransition>(transitionKey(id), value);
	if (value && !pins.has(id)) {
		const observer = new QueryObserver(qc, {
			queryKey: transitionKey(id),
			queryFn: () => false,
			enabled: false,
		});
		pins.set(
			id,
			observer.subscribe(() => {}),
		);
	} else if (!value) {
		const release = pins.get(id);
		pins.delete(id);
		release?.();
	}
}
export function isDeviceWorkspaceTransition(value: unknown): value is DeviceWorkspaceTransition {
	return !!value && typeof value === "object" && "phase" in value && "intent" in value;
}

export function workspaceFileTarget(context: WorkspaceContext | undefined) {
	return context?.deviceId && context.cwd ? { deviceId: context.deviceId, cwd: context.cwd } : null;
}

/** Do not let an old read or out-of-order WS notification undo a completed switch. */
export function latestWorkspaceContext(
	previous: WorkspaceContext | undefined,
	incoming: WorkspaceContext,
): WorkspaceContext {
	return previous && previous.revision > incoming.revision ? previous : incoming;
}

export function applyWorkspaceContext(qc: QueryClient, id: string, context: WorkspaceContext) {
	qc.setQueryData<WorkspaceContext>(workspaceContextKey(id), (old) =>
		latestWorkspaceContext(old, context),
	);
	void qc.invalidateQueries({ queryKey: ["narrators", id] });
	void qc.invalidateQueries({ queryKey: ["narratorExecutionDevices", id] });
	void qc.invalidateQueries({ queryKey: deviceWorkspacesKey(id) });
	void qc.invalidateQueries({ queryKey: ["gitWorkspace", id] });
	if (context.git)
		void qc.invalidateQueries({
			predicate: (query) =>
				String(query.queryKey[0]).startsWith("git") &&
				query.queryKey[1] === context.git?.workspaceKey,
		});
	void qc.invalidateQueries({ queryKey: ["narratorWorktrees", id] });
	void qc.invalidateQueries({ queryKey: ["recentTabs"] });
}

const subscriptions = new WeakMap<
	QueryClient,
	Map<string, { count: number; handle: ListenerHandle }>
>();
function subscribeWorkspaceContext(qc: QueryClient, narratorId: string) {
	let clients = subscriptions.get(qc);
	if (!clients) {
		clients = new Map();
		subscriptions.set(qc, clients);
	}
	let entry = clients.get(narratorId);
	if (!entry) {
		const handle = narratorWSManager.addListener(
			{
				narratorIds: [narratorId],
				types: ["workspace_context_changed", "device_workspace_bindings_changed"],
			},
			(event) => {
				if (event.type === "device_workspace_bindings_changed") {
					void qc.invalidateQueries({ queryKey: deviceWorkspacesKey(narratorId) });
					return;
				}
				const context = event.current as WorkspaceContext | undefined;
				if (context?.contextKey && typeof context.revision === "number") {
					const previous = qc.getQueryData<WorkspaceContext>(workspaceContextKey(narratorId));
					if (previous && context.revision < previous.revision) return;
					applyWorkspaceContext(qc, narratorId, context);
					if (
						(!previous || context.revision > previous.revision) &&
						!isDeviceWorkspaceTransition(qc.getQueryData(transitionKey(narratorId)))
					)
						setWorkspaceTransition(qc, narratorId, false);
					void qc.invalidateQueries({ queryKey: workspaceContextKey(narratorId) });
				}
			},
		);
		entry = { count: 0, handle };
		clients.set(narratorId, entry);
	}
	entry.count++;
	return () => {
		if (--entry.count !== 0) return;
		narratorWSManager.removeListener(entry.handle);
		clients.delete(narratorId);
	};
}

export function useWorkspaceContext(narratorId: string) {
	const qc = useQueryClient();
	useEffect(
		() => (narratorId ? subscribeWorkspaceContext(qc, narratorId) : undefined),
		[qc, narratorId],
	);
	const transition = useQuery<WorkspaceTransition>({
		queryKey: transitionKey(narratorId),
		queryFn: () => false,
		enabled: false,
	});
	const blocked = isDeviceWorkspaceTransition(transition.data)
		? transition.data.affectsSelection !== false
		: !!transition.data;
	const query = useQuery({
		queryKey: workspaceContextKey(narratorId),
		queryFn: async ({ signal }) => {
			const incoming = await api.getWorkspaceContext(narratorId, signal);
			return latestWorkspaceContext(qc.getQueryData(workspaceContextKey(narratorId)), incoming);
		},
		enabled: !!narratorId && !blocked,
	});
	return {
		...query,
		data: blocked ? undefined : query.data,
		// UI may display a confirmed durable target while operational consumers remain paused.
		snapshot: query.data,
		transition: isDeviceWorkspaceTransition(transition.data) ? transition.data : undefined,
		transitioning: blocked,
		deviceOperationPending: isDeviceWorkspaceTransition(transition.data),
	};
}

/** HTTP device selection and model SwitchDevice share the server's revisioned context. */
export function useUpdateExecutionDevice(narratorId: string, onError?: (error: Error) => void) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (deviceId: string | null) => api.updateNarratorDefaultDevice(narratorId, deviceId),
		retry: false,
		onMutate: async () => {
			setWorkspaceTransition(qc, narratorId, true);
			await qc.cancelQueries({ queryKey: workspaceContextKey(narratorId) });
		},
		onSuccess: async (result) => {
			await qc.cancelQueries({ queryKey: workspaceContextKey(narratorId) });
			const incoming = result.current ?? (await api.getWorkspaceContext(narratorId));
			applyWorkspaceContext(qc, narratorId, incoming);
			setWorkspaceTransition(qc, narratorId, false);
		},
		onError: async (error) => {
			// A dropped HTTP response may still have switched. Re-enable only after
			// an authoritative read; never infer the device/cwd from the failed request.
			try {
				const incoming = await api.getWorkspaceContext(narratorId);
				applyWorkspaceContext(qc, narratorId, incoming);
				setWorkspaceTransition(qc, narratorId, false);
			} catch {
				/* Fail closed until another successful selection/context event. */
			}
			onError?.(error);
		},
		onSettled: () => {
			void qc.invalidateQueries({ queryKey: workspaceContextKey(narratorId) });
			void qc.invalidateQueries({ queryKey: ["narratorExecutionDevices", narratorId] });
			void qc.invalidateQueries({ queryKey: ["narrators", narratorId] });
		},
	});
}

export function useSwitchWorkspaceContext(narratorId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async (input: SwitchWorkingDirectoryRequest) => {
			try {
				return await api.switchWorkspaceContext(narratorId, input);
			} catch (error) {
				// A lost response must query the ORIGINAL request, never create a new ID.
				try {
					const receipt = await api.getWorkspaceSwitchRequest(narratorId, input.requestId);
					if (receipt.installState === "installed") return receipt.result;
				} catch {
					/* No confirmed installed receipt; retain the original error. */
				}
				throw error;
			}
		},
		retry: false,
		onMutate: async () => {
			setWorkspaceTransition(qc, narratorId, true);
			await qc.cancelQueries({ queryKey: workspaceContextKey(narratorId) });
		},
		onError: async () => {
			try {
				const context = await api.getWorkspaceContext(narratorId);
				applyWorkspaceContext(qc, narratorId, context);
				setWorkspaceTransition(qc, narratorId, false);
			} catch {
				/* Keep file operations suspended until an authoritative read. */
			}
		},
		onSuccess: async ({ current }) => {
			await qc.cancelQueries({ queryKey: workspaceContextKey(narratorId) });
			applyWorkspaceContext(qc, narratorId, current);
			setWorkspaceTransition(qc, narratorId, false);
			void qc.invalidateQueries({ queryKey: workspaceContextKey(narratorId) });
		},
	});
}

/** Device bindings are summaries; never fan out native-evidence detail reads. */
export function useNarratorDeviceWorkspaces(narratorId: string) {
	const qc = useQueryClient();
	const actor = useQuery<{ id: string }>({
		queryKey: ["auth", "me"],
		queryFn: () => api.me(),
		enabled: false,
	});
	const actorId = actor.data?.id;
	useEffect(() => {
		if (!narratorId) return;
		return subscribeWorkspaceContext(qc, narratorId);
	}, [qc, narratorId]);
	useEffect(() => {
		qc.removeQueries({
			predicate: (query) =>
				query.queryKey[0] === "deviceWorkspaces" &&
				query.queryKey[1] === narratorId &&
				query.queryKey[2] !== actorId,
		});
	}, [qc, narratorId, actorId]);
	const query = useInfiniteQuery({
		queryKey: [...deviceWorkspacesKey(narratorId), actorId],
		initialPageParam: null as string | null,
		queryFn: ({ pageParam, signal }) =>
			api.listNarratorDeviceWorkspaces(narratorId, {
				cursor: pageParam ?? undefined,
				limit: 32,
				signal,
			}),
		getNextPageParam: (page) => page.nextCursor,
		enabled: !!narratorId,
		retry: false,
	});
	const items = query.isError ? [] : (query.data?.pages.flatMap((page) => page.items) ?? []);
	return { ...query, items };
}

export class DeviceWorkspaceOperationError extends Error {
	constructor(
		public readonly phase: "unconfirmed" | "committed_pending" | "superseded" | "not_committed",
		public readonly originalError?: unknown,
	) {
		super(`deviceWorkspaceOperation.${phase}`);
	}
}

function mutationAffectsSelection(intent: DeviceWorkspaceIntent) {
	return intent.kind === "select" || intent.request.expectedSelectionRevision !== undefined;
}
function actorIdFromCache(qc: QueryClient) {
	return qc.getQueryData<{ id: string }>(["auth", "me"])?.id;
}
function sameIntent(left: DeviceWorkspaceIntent, right: DeviceWorkspaceIntent) {
	return (
		left.narratorId === right.narratorId &&
		left.kind === right.kind &&
		left.request.requestId === right.request.requestId &&
		JSON.stringify(left.request) === JSON.stringify(right.request)
	);
}
function ensureReceipt(intent: DeviceWorkspaceIntent, receipt: DeviceWorkspaceRequestReceipt) {
	if (
		receipt.requestId !== intent.request.requestId ||
		receipt.kind !== intent.kind ||
		receipt.result.kind !== intent.kind ||
		receipt.result.binding.narratorId !== intent.narratorId ||
		receipt.result.binding.deviceId !== intent.request.deviceId
	)
		throw new Error("Workspace receipt identity changed");
}
function updateDeviceSummary(
	qc: QueryClient,
	intent: DeviceWorkspaceIntent,
	result: NarratorDeviceWorkspaceMutationResult,
) {
	const binding = result.binding;
	const current = qc.getQueryData<WorkspaceContext>(workspaceContextKey(intent.narratorId));
	const summary: NarratorDeviceWorkspaceSummary = {
		id: binding.id,
		deviceId: binding.deviceId,
		cwd: binding.context.cwd,
		pathFlavor: binding.context.pathFlavor,
		bindingRevision: binding.bindingRevision,
		selected: current?.deviceId === binding.deviceId,
		availability: binding.context.availability,
		updatedAt: binding.updatedAt,
	};
	const key = [...deviceWorkspacesKey(intent.narratorId), actorIdFromCache(qc)];
	qc.setQueryData<InfiniteData<ListNarratorDeviceWorkspacesResult>>(key, (old) => {
		if (!old) return old;
		return {
			...old,
			pages: old.pages.map((page) => ({
				...page,
				items: page.items.map((item) =>
					item.deviceId === summary.deviceId && item.bindingRevision <= summary.bindingRevision
						? summary
						: item,
				),
			})),
		};
	});
	void qc.invalidateQueries({ queryKey: deviceWorkspacesKey(intent.narratorId) });
}

/** Original IDs survive unknown outcomes and modal lifetimes; new IDs are never recovery. */
export async function executeDeviceWorkspaceIntent(
	qc: QueryClient,
	input: DeviceWorkspaceIntent,
	recover = false,
): Promise<NarratorDeviceWorkspaceMutationResult> {
	const intent: DeviceWorkspaceIntent =
		input.kind === "set"
			? { narratorId: input.narratorId, kind: "set", request: { ...input.request } }
			: { narratorId: input.narratorId, kind: "select", request: { ...input.request } };
	const actorId = actorIdFromCache(qc);
	const assertActor = () => {
		if (actorIdFromCache(qc) !== actorId) throw new Error("Workspace request actor changed");
	};
	const selection = mutationAffectsSelection(intent);
	const previous = qc.getQueryData<WorkspaceTransition>(transitionKey(intent.narratorId));
	if (isDeviceWorkspaceTransition(previous) && !sameIntent(previous.intent, intent))
		throw new DeviceWorkspaceOperationError(previous.phase);
	const store = (
		phase: DeviceWorkspaceTransition["phase"],
		result?: NarratorDeviceWorkspaceMutationResult,
	) => {
		assertActor();
		setWorkspaceTransition(qc, intent.narratorId, {
			phase,
			intent,
			result,
			affectsSelection: selection || !!result?.selection,
		});
	};
	store(isDeviceWorkspaceTransition(previous) ? previous.phase : "unconfirmed");
	if (selection) {
		await qc.cancelQueries({ queryKey: workspaceContextKey(intent.narratorId) });
		assertActor();
	}
	const readInstalledCurrent = async () => {
		const current = await api.getWorkspaceContext(intent.narratorId);
		assertActor();
		applyWorkspaceContext(qc, intent.narratorId, current);
		const status = await api.getWorkspaceSelectionStatus(intent.narratorId);
		assertActor();
		return status.installed && status.revision === current.revision;
	};
	let operationError: unknown;
	let receipt: DeviceWorkspaceRequestReceipt | undefined;
	try {
		if (!recover) {
			if (intent.kind === "set")
				await api.setNarratorDeviceWorkspace(intent.narratorId, intent.request);
			else await api.selectNarratorDeviceWorkspace(intent.narratorId, intent.request);
		}
	} catch (error) {
		operationError = error;
	}
	assertActor();
	try {
		receipt = await api.getNarratorDeviceWorkspaceRequest(
			intent.narratorId,
			intent.request.requestId,
		);
		assertActor();
		ensureReceipt(intent, receipt);
	} catch (error) {
		assertActor();
		const previousFact = isDeviceWorkspaceTransition(previous) ? previous.phase : undefined;
		const rejectedResponse =
			operationError instanceof ApiError &&
			operationError.status >= 400 &&
			operationError.status < 500 &&
			operationError.data?.code !== "WORKSPACE_CONTEXT_INSTALL_FAILED";
		// Absence during a network timeout is not proof: the original request may still prepare/commit.
		const nonCommitKnown =
			previousFact === "not_committed" ||
			previousFact === "superseded" ||
			(rejectedResponse && previousFact !== "unconfirmed" && previousFact !== "committed_pending");
		if (
			error instanceof ApiError &&
			error.data?.code === "WORKSPACE_REQUEST_NOT_FOUND" &&
			nonCommitKnown
		) {
			// This code is emitted only after the server has authorized the receipt lookup.
			const knownPhase =
				isDeviceWorkspaceTransition(previous) && previous.phase === "superseded"
					? "superseded"
					: "not_committed";
			if (!selection) {
				setWorkspaceTransition(qc, intent.narratorId, false);
				throw new DeviceWorkspaceOperationError(knownPhase, operationError ?? error);
			}
			store(knownPhase);
			try {
				if (await readInstalledCurrent()) setWorkspaceTransition(qc, intent.narratorId, false);
			} catch {
				// Original non-commit is confirmed; readiness of a different current selection is not.
			}
			throw new DeviceWorkspaceOperationError(knownPhase, operationError ?? error);
		}
		const known = isDeviceWorkspaceTransition(previous) ? previous : undefined;
		const phase = known?.phase ?? "unconfirmed";
		store(phase, known?.result);
		throw new DeviceWorkspaceOperationError(phase, operationError ?? error);
	}
	if (receipt.installState === "pending") {
		if (receipt.result.selection)
			applyWorkspaceContext(qc, intent.narratorId, receipt.result.selection.current);
		updateDeviceSummary(qc, intent, receipt.result);
		store("committed_pending", receipt.result);
		if (!recover) throw new DeviceWorkspaceOperationError("committed_pending", operationError);
		try {
			await api.recoverNarratorDeviceWorkspaceRequest(intent.narratorId, intent.request.requestId);
			assertActor();
			receipt = await api.getNarratorDeviceWorkspaceRequest(
				intent.narratorId,
				intent.request.requestId,
			);
			assertActor();
			ensureReceipt(intent, receipt);
		} catch (error) {
			store("committed_pending", receipt.result);
			throw new DeviceWorkspaceOperationError("committed_pending", error);
		}
	}
	if (receipt.installState !== "installed") {
		const phase = receipt.installState === "superseded" ? "superseded" : "committed_pending";
		store(phase, receipt.result);
		if (phase === "superseded") {
			try {
				if (await readInstalledCurrent()) setWorkspaceTransition(qc, intent.narratorId, false);
			} catch {
				/* Keep the actual current selection suspended until its installation is known. */
			}
		}
		throw new DeviceWorkspaceOperationError(phase, operationError);
	}
	if (receipt.result.selection) {
		store("committed_pending", receipt.result);
		try {
			if (!(await readInstalledCurrent()))
				throw new DeviceWorkspaceOperationError("committed_pending");
		} catch (error) {
			throw new DeviceWorkspaceOperationError("committed_pending", error);
		}
	}
	updateDeviceSummary(qc, intent, receipt.result);
	setWorkspaceTransition(qc, intent.narratorId, false);
	return receipt.result;
}

export function useDeviceWorkspaceMutation() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (intent: DeviceWorkspaceIntent) => executeDeviceWorkspaceIntent(qc, intent),
		retry: false,
	});
}
export function useRecoverDeviceWorkspaceMutation() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (intent: DeviceWorkspaceIntent) => executeDeviceWorkspaceIntent(qc, intent, true),
		retry: false,
	});
}
