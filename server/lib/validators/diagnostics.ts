import { z } from "zod";
import {
	DEFAULT_CPU_PROFILE_DURATION_MS,
	MAX_CPU_PROFILE_DURATION_MS,
} from "../../services/cpu-profiler";

export const cpuProfileSchema = z.strictObject({
	durationMs: z
		.number()
		.int()
		.min(1)
		.max(MAX_CPU_PROFILE_DURATION_MS)
		.default(DEFAULT_CPU_PROFILE_DURATION_MS),
});
