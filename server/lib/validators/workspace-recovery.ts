import { FILE_CHANGE_LIMITS } from "@shared/file-change-protocol";
import { z } from "zod/v4";

/**
 * Human acknowledgements for external workspace-barrier recovery. The server
 * re-observes every unsettled effect at recovery time and requires each
 * acknowledged verdict to still match (TOCTOU guard), so a client can never
 * close the books against a stale preview.
 */
export const recoverWorkspaceBarrierSchema = z.object({
	leaseId: z.string().min(1).max(256).optional(),
	confirmationToken: z.string().regex(/^[a-f0-9]{64}$/),
	acknowledgements: z
		.array(
			z.object({
				effectId: z.string().min(1).max(256),
				verdict: z.enum(["applied", "not_applied", "not_dispatched", "foreign", "unobservable"]),
			}),
		)
		.max(FILE_CHANGE_LIMITS.revertFiles),
	acknowledgeInspected: z.boolean().optional(),
});

export type RecoverWorkspaceBarrierInput = z.infer<typeof recoverWorkspaceBarrierSchema>;

export const beginWorkspaceMaintenanceSchema = z
	.object({
		leaseId: z.string().min(1).max(256).optional(),
		acknowledgeWritersStopped: z.literal(true),
		operatorReason: z.string().trim().min(1).max(1000),
	})
	.strict();
export const workspaceMaintenanceTokenSchema = z
	.object({
		maintenanceToken: z.string().regex(/^[a-f0-9]{64}$/),
	})
	.strict();
export const commitWorkspaceMaintenanceSchema = recoverWorkspaceBarrierSchema
	.omit({ leaseId: true })
	.extend({
		maintenanceToken: z.string().regex(/^[a-f0-9]{64}$/),
	})
	.strict();
