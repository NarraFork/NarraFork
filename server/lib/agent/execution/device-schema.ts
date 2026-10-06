/**
 * Dynamic `device` parameter injection for file/command tools.
 *
 * When a narrator session has one or more online remote devices, the affected
 * tools expose an optional `device` parameter so the model can target a
 * specific machine per call. When there are no devices, the parameter is
 * omitted entirely — the model never sees it, so there's zero added cognitive
 * load for the common (local-only) case.
 */
import type { AgentConfig } from "../types";
import { LOCAL_DEVICE_ID } from "./backend";

/** Build the enum + description for the `device` parameter from the session's devices. */
function buildDeviceProperty(config: AgentConfig): Record<string, unknown> | null {
	const devices = config.availableDevices ?? [];
	if (devices.length === 0) return null;

	const online = devices.filter((d) => d.online);
	if (online.length === 0) return null;

	const enumValues = [LOCAL_DEVICE_ID, ...online.map((d) => d.id)];
	const defaultId = config.defaultDeviceId ?? LOCAL_DEVICE_ID;

	const lines = online.map((d) => {
		const platform = d.platform ? ` [${d.platform.os}/${d.platform.arch}]` : "";
		const purpose = d.description ? ` — ${d.description}` : "";
		return `  • "${d.id}" (${d.name})${platform}${purpose}`;
	});

	const description =
		`Execution target for this operation. Omit to use the session default ("${defaultId}").\n` +
		`"${LOCAL_DEVICE_ID}" = the NarraFork server itself. Available remote devices:\n${lines.join("\n")}`;

	return { type: "string", enum: enumValues, description };
}

/**
 * Return a copy of `baseSchema` with a `device` property appended when the
 * session has online devices; otherwise return `baseSchema` unchanged.
 *
 * The `device` parameter is always optional (never added to `required`).
 */
export function withDeviceParam(
	baseSchema: Record<string, unknown>,
	config: AgentConfig,
): Record<string, unknown> {
	const deviceProp = buildDeviceProperty(config);
	if (!deviceProp) return baseSchema;

	const properties = {
		...((baseSchema.properties as Record<string, unknown>) ?? {}),
		device: deviceProp,
	};
	return { ...baseSchema, properties };
}

/** Whether the session currently has at least one online device. */
export function hasOnlineDevices(config: AgentConfig): boolean {
	return (config.availableDevices ?? []).some((d) => d.online);
}
