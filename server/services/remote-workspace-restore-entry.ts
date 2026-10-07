import { AppError } from "../lib/errors";
import type { NarratorPrincipal } from "./narrator-acl";
import {
	getRemoteWorkspaceHistoryRuntime,
	type RemoteWorkspaceHistoryRuntime,
} from "./remote-workspace-history-runtime";
import {
	type RemoteWorkspaceRestoreConfirmation,
	RemoteWorkspaceRestoreService,
} from "./remote-workspace-restore-service";

const services = new WeakMap<RemoteWorkspaceHistoryRuntime, RemoteWorkspaceRestoreService>();
async function service() {
	const registry = await getRemoteWorkspaceHistoryRuntime();
	let current = services.get(registry);
	if (!current) {
		current = new RemoteWorkspaceRestoreService({ registry });
		services.set(registry, current);
	}
	return current;
}

async function checked<Result>(body: () => Promise<Result>): Promise<Result> {
	try {
		return await body();
	} catch (error) {
		if (error instanceof AppError) throw error;
		throw new AppError(
			error instanceof Error ? error.message : "Workspace snapshot restore refused",
			409,
			"REMOTE_WORKSPACE_RESTORE_REFUSED",
		);
	}
}
/** Purpose-specific application entry: no narrator undo selection or directory fallback. */
export async function previewRemoteWorkspaceRestore(
	principal: NarratorPrincipal,
	narratorId: string,
	input: { captureId: string; idempotencyKey: string; signal?: AbortSignal },
) {
	return checked(async () => (await service()).prepare({ principal, narratorId, ...input }));
}
export async function applyRemoteWorkspaceRestore(
	principal: NarratorPrincipal,
	narratorId: string,
	input: {
		planId: string;
		planHash: string;
		confirmation: RemoteWorkspaceRestoreConfirmation;
		signal?: AbortSignal;
		onMutationDispatch?: () => void;
	},
) {
	return checked(async () => (await service()).apply({ principal, narratorId, ...input }));
}
export async function recoverRemoteWorkspaceRestore(
	principal: NarratorPrincipal,
	narratorId: string,
	input: {
		planId: string;
		planHash: string;
		confirmation: RemoteWorkspaceRestoreConfirmation;
		signal?: AbortSignal;
	},
) {
	return checked(async () => (await service()).recover({ principal, narratorId, ...input }));
}
