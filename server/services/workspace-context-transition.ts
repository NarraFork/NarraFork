import type {
	SwitchWorkingDirectoryRequest,
	SwitchWorkingDirectoryResult,
	WorkspaceContext,
} from "@shared/workspace-context";
import { AppError } from "../lib/errors";

export interface WorkspaceTransitionPorts {
	read(): Promise<WorkspaceContext>;
	prepare(
		previous: WorkspaceContext,
		request: SwitchWorkingDirectoryRequest,
	): Promise<WorkspaceContext>;
	/** Must hold the same short admission mutex as start/history/revert publication. */
	admit<T>(action: () => Promise<T>): Promise<T>;
	checkAdmission(): void;
	commit(previous: WorkspaceContext, current: WorkspaceContext): Promise<boolean>;
	install(current: WorkspaceContext): Promise<void>;
	pause(current: WorkspaceContext): void;
	publish(result: SwitchWorkingDirectoryResult): void;
}

export function workspaceConflict(message: string, code = "WORKSPACE_CONTEXT_CONFLICT"): AppError {
	return new AppError(message, 409, code);
}

/** Prepare off-lock; recheck admission and revision; CAS; install; then publish. */
export async function transitionWorkspaceContext(
	request: SwitchWorkingDirectoryRequest,
	ports: WorkspaceTransitionPorts,
): Promise<SwitchWorkingDirectoryResult> {
	ports.checkAdmission();
	const previous = await ports.read();
	ports.checkAdmission();
	if (previous.revision !== request.expectedRevision)
		throw workspaceConflict("Workspace revision changed");
	const prepared = await ports.prepare(previous, request);
	return ports.admit(async () => {
		ports.checkAdmission();
		const latest = await ports.read();
		if (latest.revision !== previous.revision || latest.contextKey !== previous.contextKey)
			throw workspaceConflict("Workspace changed while preparing the switch");
		if (prepared.contextKey === previous.contextKey)
			return { changed: false, previous: latest, current: latest };
		const current = Object.freeze({ ...prepared, revision: previous.revision + 1 });
		if (!(await ports.commit(previous, current)))
			throw workspaceConflict("Workspace revision changed");
		try {
			await ports.install(current);
		} catch {
			// Persistence already won. Never roll cwd back or run tools with a half-installed context.
			ports.pause(current);
			throw workspaceConflict(
				"Workspace committed; runtime paused until persisted context is restored",
				"WORKSPACE_CONTEXT_INSTALL_FAILED",
			);
		}
		const result = { changed: true, previous, current };
		ports.publish(result);
		return result;
	});
}
