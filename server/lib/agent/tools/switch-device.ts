import { z } from "zod/v4";
import { LOCAL_DEVICE_ID } from "../execution/backend";
import type { AgentConfig, ToolDefinition, ToolResult } from "../types";

/**
 * SwitchDevice — changes the session's default execution target for file /
 * command tools. After a switch, tools that don't specify a `device` parameter
 * run on the new default.
 *
 * The tool schema stays static; current device candidates live in prompt context.
 * Every switch validates the current device inventory and runtime permissions.
 */
export const switchDeviceTool: ToolDefinition = {
	name: "SwitchDevice",
	description:
		"Change the default execution device for this session's file and command tools " +
		'(Read/Write/Edit/Glob/Grep/Bash). Pass a device id, or "local" for the NarraFork ' +
		"server itself. Subsequent tool calls that omit the `device` parameter run on the new " +
		"default. Use the per-call `device` parameter instead when you only need a single " +
		"operation on another machine.",
	rawJsonSchema: {
		type: "object",
		properties: {
			device: {
				type: "string",
				description: 'The device id to switch to, or "local" for the NarraFork server.',
			},
		},
		required: ["device"],
		additionalProperties: false,
	},
	parameters: z.object({
		device: z.string().describe('The device id to switch to, or "local".'),
	}),
	async execute(args, ctx): Promise<ToolResult> {
		const { device } = args as { device: string };
		const target = device.trim();

		// Validate against the session's known devices.
		const devices = ctx.availableDevices ?? [];
		if (target === LOCAL_DEVICE_ID && ctx.allowLocalExecution === false) {
			return {
				output: "Local execution is not allowed by this narrator's runtime policy.",
				isError: true,
			};
		}
		if (target !== LOCAL_DEVICE_ID) {
			const match = devices.find((d) => d.id === target || d.slug === target);
			if (!match) {
				return {
					output:
						`Unknown device "${target}". Available: ${LOCAL_DEVICE_ID}, ` +
						devices.map((d) => d.id).join(", "),
					isError: true,
				};
			}
			if (!match.online) {
				return { output: `Device "${match.name}" is offline.`, isError: true };
			}
		}

		const resolvedId =
			target === LOCAL_DEVICE_ID ? LOCAL_DEVICE_ID : normalizeToId(target, devices);
		// Persist + apply the new default via the session hook when available.
		const applied = await ctx.setDefaultDevice?.(
			resolvedId === LOCAL_DEVICE_ID ? null : resolvedId,
		);
		if (ctx.setDefaultDevice && applied === false) {
			return { output: "Failed to switch device (session not found).", isError: true };
		}

		if (resolvedId === LOCAL_DEVICE_ID) {
			return { output: "Switched default execution target to local (NarraFork server)." };
		}
		const dev = devices.find((d) => d.id === resolvedId);
		const platform = dev?.platform ? ` [${dev.platform.os}/${dev.platform.arch}]` : "";
		const cwd = dev?.defaultCwd ? `\nDefault working directory: ${dev.defaultCwd}` : "";
		return {
			output: `Switched default execution target to "${dev?.name ?? resolvedId}"${platform}.${cwd}`,
		};
	},
};

function normalizeToId(ref: string, devices: NonNullable<AgentConfig["availableDevices"]>): string {
	const match = devices.find((d) => d.id === ref || d.slug === ref);
	return match?.id ?? ref;
}
