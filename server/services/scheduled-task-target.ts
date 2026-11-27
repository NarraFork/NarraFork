import { createHash } from "node:crypto";
import { AppError, NotFoundError, ValidationError } from "../lib/errors";
import { loadNarratorForAccess } from "./narrator-acl";
import { resolveNarratorProjectId } from "./narrator-project";
import { resolveTaskPrincipal, type ScheduledTaskPrincipal } from "./scheduled-task-acl";

export interface ScheduledTaskExpectedTarget {
	id: string;
	fingerprint: string;
}

/** Use the same write gate as an interactive conversation, refreshed for the task owner. */
export async function resolveScheduledTaskTarget(
	principal: ScheduledTaskPrincipal,
	targetId: string,
) {
	if (!targetId) throw new ValidationError("Existing narrator mode requires a target narrator");
	const live = await resolveTaskPrincipal(principal.userId);
	const target = await loadNarratorForAccess(targetId, live, "write");
	if (target.status === "archived") throw new NotFoundError("Narrator", targetId);
	const projectId = await resolveNarratorProjectId(target);
	// Conversation progress must not invalidate an approved configuration. ACL is
	// rechecked above; this fingerprint fences the settings the approval displayed.
	const fingerprint = createHash("sha256")
		.update(
			JSON.stringify({
				id: target.id,
				title: target.title,
				type: target.type,
				ownerUserId: target.ownerUserId,
				visibility: target.visibility,
				writeAudience: target.writeAudience,
				aclRootNarratorId: target.aclRootNarratorId,
				projectId,
				cwd: target.cwd,
				defaultDeviceId: target.defaultDeviceId,
				model: target.model,
				permissionMode: target.permissionMode,
				systemPrompt: target.systemPrompt,
				traits: target.traits,
				planMode: target.planMode,
				relaxedPlan: target.relaxedPlan,
				oauthPolicySnapshotJson: target.oauthPolicySnapshotJson,
			}),
		)
		.digest("hex");
	return { target, projectId, fingerprint };
}

export function assertScheduledTaskTargetVersion(
	resolved: Awaited<ReturnType<typeof resolveScheduledTaskTarget>>,
	expected?: ScheduledTaskExpectedTarget,
): void {
	if (
		expected &&
		(expected.id !== resolved.target.id || expected.fingerprint !== resolved.fingerprint)
	)
		throw new AppError(
			"Target narrator changed after approval; review the updated target before retrying",
			409,
			"SCHEDULED_TASK_TARGET_CHANGED",
		);
}
