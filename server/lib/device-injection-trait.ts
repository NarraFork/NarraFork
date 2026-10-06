/**
 * Device injection policy.
 *
 * Authorization ("may this session use the device") and injection ("does the
 * model get told the device exists") are separate concerns. Before this trait
 * they were the same thing: every authorized online device was listed in the
 * system prompt, so a communal build machine polluted every session's context and
 * invited tool calls nobody asked for.
 *
 * Injection is therefore a *preference*-kind trait: the nearest layer that states
 * something wins, and `inherit` defers. It is deliberately not a restriction —
 * a narrator must be able to switch a project-level device off for one task
 * without weakening any security boundary, because injection grants nothing.
 *
 * The one hard rule is the inverse: injection can never be a privilege
 * escalation, so the resolved injection set is always intersected with the
 * authorized set (see `resolveInjectedDevices`).
 */
import { parseTraits } from "./narrator-utils";
import {
	mergeToggleMapTrait,
	mergeValueTrait,
	normalizeTraitToggle,
	type TraitLayerInput,
	type TraitToggle,
} from "./trait-layers";

export const DEVICE_INJECTION_TRAIT_PREFIX = "custom-device-injection:";

/**
 * What to do with devices that have no explicit per-device override.
 *
 * - `none`: inject nothing; every device must be switched on deliberately.
 * - `private`: inject the acting user's own devices only — useful when communal
 *   machines would otherwise pollute every session.
 * - `global`: inject only devices an administrator made global. The default.
 * - `all`: inject every authorized online device, including project-scoped ones
 *   another member registered. Means literally all; only meaningful as a
 *   deliberate choice.
 *
 * `global` rather than `all` is the default because any authenticated user may
 * register a device. Availability and injection are two different levels: being
 * authorized to use a device does not mean it should announce itself in everyone's
 * sessions. Auto-injecting every shared device would let one member place a
 * machine they control into their colleagues' contexts, so "present by default"
 * stays an administrative act (registering it global).
 */
export const DEVICE_INJECTION_MODES = ["none", "private", "global", "all"] as const;
export type DeviceInjectionMode = (typeof DEVICE_INJECTION_MODES)[number];

export const DEFAULT_DEVICE_INJECTION_MODE: DeviceInjectionMode = "global";

export interface DeviceInjectionTrait {
	version: 1;
	defaultMode: DeviceInjectionMode;
	/** Per-device tri-state overrides, keyed by device id. */
	devices: Record<string, TraitToggle>;
}

export function normalizeDeviceInjectionMode(value: unknown): DeviceInjectionMode {
	return typeof value === "string" && (DEVICE_INJECTION_MODES as readonly string[]).includes(value)
		? (value as DeviceInjectionMode)
		: DEFAULT_DEVICE_INJECTION_MODE;
}

/** Bound the override map so a trait payload cannot grow without limit. */
const MAX_DEVICE_OVERRIDES = 200;

export function normalizeDeviceInjectionTrait(input: unknown): DeviceInjectionTrait {
	const source =
		input && typeof input === "object" && !Array.isArray(input)
			? (input as { defaultMode?: unknown; devices?: unknown })
			: {};
	const devices: Record<string, TraitToggle> = {};
	if (source.devices && typeof source.devices === "object" && !Array.isArray(source.devices)) {
		for (const [key, value] of Object.entries(source.devices)) {
			const deviceId = key.trim();
			if (!deviceId || deviceId.length > 64) continue;
			const toggle = normalizeTraitToggle(value);
			// "inherit" is the absence of an override, so storing it is redundant.
			if (toggle === "inherit") continue;
			devices[deviceId] = toggle;
			if (Object.keys(devices).length >= MAX_DEVICE_OVERRIDES) break;
		}
	}
	return {
		version: 1,
		defaultMode: normalizeDeviceInjectionMode(source.defaultMode),
		devices,
	};
}

function decode(trait: string): DeviceInjectionTrait | null {
	if (!trait.startsWith(DEVICE_INJECTION_TRAIT_PREFIX)) return null;
	try {
		const json = Buffer.from(
			trait.slice(DEVICE_INJECTION_TRAIT_PREFIX.length),
			"base64url",
		).toString("utf-8");
		const parsed = JSON.parse(json) as { version?: unknown };
		if (parsed.version !== 1) return null;
		return normalizeDeviceInjectionTrait(parsed);
	} catch {
		return null;
	}
}

/** Read the injection trait out of one layer's traits array. */
export function parseDeviceInjectionTrait(traits: unknown): DeviceInjectionTrait | null {
	for (const trait of parseTraits(traits)) {
		const decoded = decode(trait);
		if (decoded) return decoded;
	}
	return null;
}

export function encodeDeviceInjectionTrait(trait: DeviceInjectionTrait): string {
	return `${DEVICE_INJECTION_TRAIT_PREFIX}${Buffer.from(
		JSON.stringify(normalizeDeviceInjectionTrait(trait)),
		"utf-8",
	).toString("base64url")}`;
}

export interface ResolvedDeviceInjection {
	mode: DeviceInjectionMode;
	overrides: Record<string, TraitToggle>;
}

/**
 * Merge the injection trait across layers under preference semantics.
 *
 * The mode takes the nearest declared value; per-device overrides resolve
 * independently, so a project can switch a device on while one narrator switches
 * that same device back off.
 */
export function mergeDeviceInjection(
	layers: TraitLayerInput<DeviceInjectionTrait>,
): ResolvedDeviceInjection {
	const modeLayers: TraitLayerInput<DeviceInjectionMode> = {};
	const overrideLayers: TraitLayerInput<Record<string, TraitToggle>> = {};
	for (const [layer, trait] of Object.entries(layers) as Array<
		[keyof typeof layers, DeviceInjectionTrait | null | undefined]
	>) {
		if (!trait) continue;
		modeLayers[layer] = trait.defaultMode;
		overrideLayers[layer] = trait.devices;
	}
	return {
		mode: mergeValueTrait(modeLayers) ?? DEFAULT_DEVICE_INJECTION_MODE,
		overrides: mergeToggleMapTrait(overrideLayers),
	};
}

/** Minimal device shape needed to decide injection. */
export interface InjectionCandidate {
	id: string;
	online: boolean;
	/** True when this device belongs to the acting user (owner axis "private"). */
	ownedByActingUser?: boolean;
	/**
	 * Project axis. Only `"global"` devices are injected by default under mode
	 * `all`, and registering one is admin-only — so "appears in every session
	 * without being asked for" stays an administrative decision.
	 */
	scope?: "global" | "project";
}

/**
 * Decide which authorized devices to describe to the model.
 *
 * Callers must pass devices that are already authorized — this function narrows,
 * never widens, so it cannot become an escalation path. Offline devices are
 * excluded because naming a device the agent cannot reach only invites failed
 * tool calls.
 *
 * Availability and injection are deliberately two different levels:
 *
 * - Not authorized → never injected (enforced by the caller's authorized set).
 * - Authorized → still not injected *by default* unless an administrator made the
 *   device global. Any user may register a device, so auto-injecting every shared
 *   device would let one member push a machine they control into everyone else's
 *   sessions. A project-scoped device is opted in per narrator/project instead.
 *
 * An explicit per-device override always wins in both directions.
 */
export function resolveInjectedDevices<T extends InjectionCandidate>(
	authorized: readonly T[],
	injection: ResolvedDeviceInjection,
): T[] {
	return authorized.filter((device) => {
		if (!device.online) return false;
		const override = injection.overrides[device.id];
		if (override === "on") return true;
		if (override === "off") return false;
		switch (injection.mode) {
			case "all":
				return true;
			case "none":
				return false;
			case "private":
				return device.ownedByActingUser === true;
			default:
				// "global": an administrator marked this device as reachable from every
				// project. A device with no scope (rows predating the project axis) is
				// treated as project-scoped, so the safer branch is the fallback.
				return device.scope === "global";
		}
	});
}
