import type { ArchiveRow } from "./main-store";

export interface ArchiveActor {
	userId: string;
	isAdmin: boolean;
}

export class ProjectArchiveAuthorizationError extends Error {
	constructor() {
		super("Project archive requires owner/admin authority for every dependency");
	}
}

/** Project management alone never grants full access to private conversation history. */
export function assertFullExport(row: ArchiveRow, actor: ArchiveActor, root?: ArchiveRow): void {
	const authority = row.type === "subagent" ? root : row;
	if (!actor.isAdmin && authority?.owner_user_id !== actor.userId)
		throw new ProjectArchiveAuthorizationError();
}
