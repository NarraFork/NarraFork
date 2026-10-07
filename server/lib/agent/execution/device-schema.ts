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
	const defaultId = config.workspaceContext?.deviceId ?? config.defaultDeviceId ?? LOCAL_DEVICE_ID;
	const online = devices.filter((d) => d.online);
	if (online.length === 0 && defaultId === LOCAL_DEVICE_ID) return null;

	const enumValues = [
		...(config.allowLocalExecution === false ? [] : [LOCAL_DEVICE_ID]),
		...online.map((d) => d.id),
		...(defaultId !== LOCAL_DEVICE_ID && !online.some((d) => d.id === defaultId)
			? [defaultId]
			: []),
	];

	const lines = online.map((d) => {
		const platform = d.platform
			? ` [${d.platform.os}/${d.platform.arch}; shell: ${d.platform.shellType ?? "unreported"}]`
			: "";
		const purpose = d.description ? ` — ${d.description}` : "";
		return `  • "${d.id}" (${d.name})${platform}${purpose}`;
	});

	const selected = devices.find((d) => d.id === defaultId);
	const cwd =
		config.workspaceContext?.cwd ??
		(defaultId === LOCAL_DEVICE_ID ? config.cwd : selected?.defaultCwd);
	const offline =
		defaultId !== LOCAL_DEVICE_ID && !selected?.online
			? " This device is offline/unavailable; calls fail rather than fall back to local."
			: "";
	const description =
		`Execution target for this operation. Omit (or select the same device) to use the frozen session workspace ("${defaultId}", cwd: ${cwd ?? "uninitialized"}).${offline}\n` +
		`Selecting a different device is a one-call override: relative paths use that device's own default directory or explicit workdir, never the current workspace cwd. It does not switch the session.\n` +
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
