import { z } from "zod";
import { MIN_UNATTENDED_ARM_DELAY_SECONDS } from "../../../shared/unattended";

/**
 * One patch shape for both arming and disarming unattended mode.
 *
 * Ranges mirror the service's own clamps (`services/unattended-mode.ts`): the schema rejects
 * an out-of-range value instead of silently narrowing it, while the service keeps clamping as
 * defence in depth for any caller that bypasses HTTP.
 */
export const unattendedOptionsSchema = z
	.object({
		enabled: z.boolean(),
		powerOff: z.boolean().optional(),
		powerOffCommand: z
			.string()
			.trim()
			.max(500)
			.nullable()
			.optional()
			.refine((value) => value == null || !/[\r\n]/.test(value), "must be a single line"),
		/** 10s floor: shorter windows cannot outlast a single agent turn's tail. */
		quietSeconds: z.number().int().min(10).max(86_400).optional(),
		armDelaySeconds: z.number().int().min(MIN_UNATTENDED_ARM_DELAY_SECONDS).max(3_600).optional(),
	})
	.strict();
