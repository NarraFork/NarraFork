import type { WorkspaceContext } from "@shared/workspace-context";
import { useQuery } from "@tanstack/react-query";
import { nanoid } from "nanoid";
import { useEffect, useMemo, useRef, useState } from "react";
import {
	type PendingSnapshotRestore,
	SnapshotRestoreFlow,
} from "../components/narrator/workspace/snapshot-restore-flow";
import { SnapshotRestoreReceiptStore } from "../components/narrator/workspace/snapshot-restore-receipt-store";
import { workspaceSnapshotRestoreApi } from "../lib/api/workspace-snapshot-restores";

export function restoreViewScope(narratorId: string, context: WorkspaceContext | undefined) {
	return context
		? JSON.stringify([narratorId, context.deviceId, context.contextKey, context.revision])
		: null;
}
export function useWorkspaceSnapshots(
	narratorId: string,
	context: WorkspaceContext | undefined,
	cursor?: string,
) {
	return useQuery({
		queryKey: [
			"workspaceSnapshots",
			narratorId,
			context?.deviceId,
			context?.contextKey,
			context?.revision,
			cursor ?? null,
		],
		queryFn: ({ signal }) => workspaceSnapshotRestoreApi.list(narratorId, cursor, signal),
		enabled: !!narratorId,
		retry: false,
		staleTime: 0,
		gcTime: 30_000,
	});
}
export function useWorkspaceSnapshotRestoreFlow(
	narratorId: string,
	actorId: string,
	context: WorkspaceContext | undefined,
) {
	const scope = restoreViewScope(narratorId, context);
	const scopeRef = useRef(scope);
	scopeRef.current = scope;
	const owner = useMemo(() => {
		let store: SnapshotRestoreReceiptStore | undefined, error: string | undefined;
		try {
			store = new SnapshotRestoreReceiptStore(localStorage, actorId, narratorId);
		} catch {
			error = "snapshotRestore.receiptUnavailable";
		}
		let pending: PendingSnapshotRestore | undefined;
		try {
			pending = store?.load();
		} catch {
			error = "snapshotRestore.receiptUnavailable";
		}
		const flow = new SnapshotRestoreFlow(
			{
				scope: () => scopeRef.current,
				now: () => Date.now(),
				requestId: () => nanoid(),
				preview: (input, signal) => workspaceSnapshotRestoreApi.preview(narratorId, input, signal),
				apply: (input) => workspaceSnapshotRestoreApi.apply(narratorId, input),
				recover: (input) => workspaceSnapshotRestoreApi.recover(narratorId, input),
				save: (value) => {
					if (error || !store) throw new Error("snapshotRestore.receiptUnavailable");
					store.save(value);
				},
				complete: (request) => {
					if (!store) throw new Error("snapshotRestore.receiptUnavailable");
					store.complete(request);
				},
			},
			pending,
		);
		return { flow, error };
	}, [narratorId, actorId]);
	const [state, setState] = useState(owner.flow.state);
	useEffect(() => {
		setState(owner.flow.state);
		return owner.flow.subscribe(setState);
	}, [owner]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: source view revisions must invalidate consent even though the flow reads them through a live ref
	useEffect(() => {
		owner.flow.observeScope();
	}, [owner, scope]);
	useEffect(
		() => () => {
			owner.flow.cancel();
		},
		[owner],
	);
	return { flow: owner.flow, state, storageError: owner.error };
}
