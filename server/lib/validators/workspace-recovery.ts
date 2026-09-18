import { z } from "zod/v4";

/**
 * Human acknowledgements for external workspace-barrier recovery. The server
 * re-observes every unsettled effect at recovery time and requires each
 * acknowledged verdict to still match (TOCTOU guard), so a client can never
 * close the books against a stale preview.
 */
export const recoverWorkspaceBarrierSchema = z.object({
	acknowledgements: z
		.array(
			z.object({
				effectId: z.string().min(1).max(256),
				verdict: z.enum(["applied", "not_applied", "not_dispatched", "foreign", "unobservable"]),
			}),
		)
		.max(1024),
	acknowledgeInspected: z.boolean().optional(),
});

export type RecoverWorkspaceBarrierInput = z.infer<typeof recoverWorkspaceBarrierSchema>;
