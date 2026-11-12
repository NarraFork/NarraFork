/**
 * Which working directory belongs to which execution device, for the details panel.
 *
 * Extracted so the rule is testable without rendering the panel: a device shows its
 * OWN recorded directory, and only the currently effective device may fall back to the
 * session's effective `cwd`. That fallback matters for rows written before the map
 * existed (and for a session created before any switch); letting another device inherit
 * it would display a path that does not exist on that machine.
 */

import type { WorkspaceDirectoryMap } from "../../../lib/api/narrators";

export interface DeviceDirectoryRow {
	id: string;
	name: string;
	/** Recorded directory on that device, or null when it still needs one. */
	cwd: string | null;
}

export interface DeviceDirectoryInput {
	directories?: WorkspaceDirectoryMap;
	currentDeviceId: string;
	/** The session's effective directory (`workspaceContext.cwd`, else the row's cwd). */
	currentCwd?: string | null;
	devices: readonly { id: string; name: string }[];
	/** Label for the server itself. */
	localLabel: string;
}

/** The directory recorded for one device, with the current device's legacy fallback. */
export function deviceDirectoryCwd(input: DeviceDirectoryInput, deviceId: string): string | null {
	const recorded = input.directories?.[deviceId]?.cwd;
	if (recorded) return recorded;
	if (deviceId !== input.currentDeviceId) return null;
	return input.currentCwd?.trim() || null;
}

/**
 * Selecting a device for editing: the directory its editor starts from.
 *
 * Always that device's OWN recorded directory, never the previous device's text — a
 * Windows path left in the box while the panel switches to the server (or the reverse)
 * would be saved as if it belonged to the other machine. Re-selecting the device the
 * session already runs on means "no pending change", so the save button stays disabled
 * instead of offering a no-op switch.
 */
export function beginEditingDevice(
	input: DeviceDirectoryInput,
	deviceId: string,
): { editingDeviceId: string | null; cwd: string } {
	return {
		editingDeviceId: deviceId === input.currentDeviceId ? null : deviceId,
		cwd: deviceDirectoryCwd(input, deviceId) ?? "",
	};
}

/** The server first, then every visible device, each with its own directory. */
export function describeDeviceDirectories(input: DeviceDirectoryInput): DeviceDirectoryRow[] {
	return [
		{ id: "local", name: input.localLabel, cwd: deviceDirectoryCwd(input, "local") },
		...input.devices.map((device) => ({
			id: device.id,
			name: device.name,
			cwd: deviceDirectoryCwd(input, device.id),
		})),
	];
}

/** Device name for a badge: the server has its own label, a remote device keeps its name. */
export function deviceDisplayName(
	input: Pick<DeviceDirectoryInput, "devices" | "localLabel">,
	deviceId: string,
): string {
	if (deviceId === "local") return input.localLabel;
	return input.devices.find((device) => device.id === deviceId)?.name ?? deviceId;
}
