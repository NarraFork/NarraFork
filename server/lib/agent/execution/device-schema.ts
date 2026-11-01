/** Static device parameter shared by filesystem and command tools. */
import type { AgentConfig } from "../types";

/** Device candidates and the session default belong in prompt context, not schemas. */
export function withDeviceParam(baseSchema: Record<string, unknown>): Record<string, unknown> {
	return {
		...baseSchema,
		properties: {
			...((baseSchema.properties as Record<string, unknown>) ?? {}),
			device: {
				type: "string",
				description:
					'Execution target for this operation. Omit to use the session default. "local" means the NarraFork server. Consult the current execution-device context for available targets; execution permissions are checked at call time.',
			},
		},
	};
}

/** Whether the session currently has at least one online device. */
export function hasOnlineDevices(config: AgentConfig): boolean {
	return (config.availableDevices ?? []).some((d) => d.online);
}
