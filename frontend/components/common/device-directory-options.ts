/**
 * Device option data for the pickers that can target another machine.
 *
 * Pure and dependency-free on purpose: it is imported by hosts that never load the
 * directory browser chunk, and the remote build substitutes that chunk's module (see
 * `frontend/build/remote-boundaries.ts`). Keeping the option list here means a remote
 * build still labels devices correctly instead of shipping a stub.
 */

/** The pseudo device id meaning "the NarraFork server itself". */
export const LOCAL_DEVICE = "local";

/**
 * The parts of an execution device a picker needs.
 *
 * Structural rather than a slice of `NarratorExecutionDevice`, so the pre-creation list
 * (which has no narrator behind it) and the per-narrator list both fit.
 */
export type DeviceOption = {
	id: string;
	name: string;
	online: boolean;
	defaultCwd?: string | null;
};

/**
 * Options for the device `Select` that precedes a directory control.
 *
 * Local is always first and always selectable; a remote device that is offline carries
 * that reason and is disabled, because a session created there would fail. Hosts keep
 * their own `<Select>` (label, description and width differ per surface) and share only
 * the options — which is precisely where they used to disagree.
 */
export function deviceSelectData(
	devices: readonly DeviceOption[],
	labels: { local: string; offline: string },
): { value: string; label: string; disabled?: boolean }[] {
	return [
		{ value: LOCAL_DEVICE, label: labels.local },
		...devices
			.filter((device) => device.id !== LOCAL_DEVICE)
			.map((device) => ({
				value: device.id,
				label: device.online ? device.name : `${device.name} · ${labels.offline}`,
				disabled: !device.online,
			})),
	];
}
