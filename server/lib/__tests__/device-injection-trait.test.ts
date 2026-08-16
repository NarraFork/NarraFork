import { describe, expect, test } from "bun:test";
import {
	DEFAULT_DEVICE_INJECTION_MODE,
	DEVICE_INJECTION_TRAIT_PREFIX,
	type DeviceInjectionTrait,
	encodeDeviceInjectionTrait,
	type InjectionCandidate,
	mergeDeviceInjection,
	normalizeDeviceInjectionMode,
	normalizeDeviceInjectionTrait,
	parseDeviceInjectionTrait,
	resolveInjectedDevices,
} from "../device-injection-trait";

function trait(overrides: Partial<DeviceInjectionTrait> = {}): DeviceInjectionTrait {
	return normalizeDeviceInjectionTrait({
		version: 1,
		defaultMode: overrides.defaultMode ?? DEFAULT_DEVICE_INJECTION_MODE,
		devices: overrides.devices ?? {},
	});
}

function device(
	id: string,
	options: { online?: boolean; owned?: boolean } = {},
): InjectionCandidate {
	return {
		id,
		online: options.online ?? true,
		ownedByActingUser: options.owned ?? false,
	};
}

describe("normalization", () => {
	test("defaults to injecting everything, matching pre-trait behaviour", () => {
		// Deliberate: an existing deployment must not silently lose the devices its
		// narrators were already using. Trimming context is opt-in.
		expect(DEFAULT_DEVICE_INJECTION_MODE).toBe("all");
		expect(normalizeDeviceInjectionTrait({}).defaultMode).toBe("all");
	});

	test("unknown modes fall back to the default rather than throwing", () => {
		expect(normalizeDeviceInjectionMode("everything")).toBe("all");
		expect(normalizeDeviceInjectionMode(null)).toBe("all");
		expect(normalizeDeviceInjectionMode(7)).toBe("all");
	});

	test("inherit overrides are dropped because they carry no information", () => {
		const normalized = normalizeDeviceInjectionTrait({
			devices: { d1: "inherit", d2: "on", d3: "off" },
		});
		expect(normalized.devices).toEqual({ d2: "on", d3: "off" });
	});

	test("malformed override values degrade to absent", () => {
		const normalized = normalizeDeviceInjectionTrait({
			devices: { d1: "yes", d2: 3, d3: null },
		});
		expect(normalized.devices).toEqual({});
	});

	test("the override map is bounded", () => {
		const devices: Record<string, string> = {};
		for (let i = 0; i < 400; i++) devices[`d${i}`] = "on";
		expect(
			Object.keys(normalizeDeviceInjectionTrait({ devices }).devices).length,
		).toBeLessThanOrEqual(200);
	});
});

describe("encode/decode", () => {
	test("round-trips", () => {
		const original = trait({ defaultMode: "all", devices: { d1: "off" } });
		const encoded = encodeDeviceInjectionTrait(original);
		expect(encoded.startsWith(DEVICE_INJECTION_TRAIT_PREFIX)).toBe(true);
		expect(parseDeviceInjectionTrait([encoded])).toEqual(original);
	});

	test("absent or malformed traits parse as null", () => {
		expect(parseDeviceInjectionTrait([])).toBeNull();
		expect(parseDeviceInjectionTrait(["plan", "named"])).toBeNull();
		expect(parseDeviceInjectionTrait([`${DEVICE_INJECTION_TRAIT_PREFIX}not-base64!!`])).toBeNull();
		expect(parseDeviceInjectionTrait(null)).toBeNull();
	});

	test("a future version is ignored rather than misread", () => {
		const future = `${DEVICE_INJECTION_TRAIT_PREFIX}${Buffer.from(
			JSON.stringify({ version: 2, defaultMode: "all" }),
			"utf-8",
		).toString("base64url")}`;
		expect(parseDeviceInjectionTrait([future])).toBeNull();
	});
});

describe("layer merging (preference semantics)", () => {
	test("the nearest declared mode wins", () => {
		expect(
			mergeDeviceInjection({
				user: trait({ defaultMode: "all" }),
				narrator: trait({ defaultMode: "none" }),
			}).mode,
		).toBe("none");
	});

	test("an absent layer inherits", () => {
		expect(mergeDeviceInjection({ project: trait({ defaultMode: "all" }) }).mode).toBe("all");
		expect(mergeDeviceInjection({}).mode).toBe(DEFAULT_DEVICE_INJECTION_MODE);
	});

	test("a narrator may switch off a device a project switched on", () => {
		const resolved = mergeDeviceInjection({
			project: trait({ devices: { d1: "on" } }),
			narrator: trait({ devices: { d1: "off" } }),
		});
		expect(resolved.overrides.d1).toBe("off");
	});

	test("per-device overrides resolve independently", () => {
		const resolved = mergeDeviceInjection({
			user: trait({ devices: { d1: "on", d2: "off" } }),
			narrator: trait({ devices: { d2: "on" } }),
		});
		expect(resolved.overrides).toEqual({ d1: "on", d2: "on" });
	});
});

describe("resolveInjectedDevices", () => {
	test("mode private injects only the acting user's own devices", () => {
		const devices = [device("own", { owned: true }), device("communal")];
		const injected = resolveInjectedDevices(devices, { mode: "private", overrides: {} });
		expect(injected.map((d) => d.id)).toEqual(["own"]);
	});

	test("mode none injects nothing", () => {
		const devices = [device("own", { owned: true }), device("communal")];
		expect(resolveInjectedDevices(devices, { mode: "none", overrides: {} })).toEqual([]);
	});

	test("mode all injects every online authorized device", () => {
		const devices = [device("own", { owned: true }), device("communal")];
		expect(
			resolveInjectedDevices(devices, { mode: "all", overrides: {} }).map((d) => d.id),
		).toEqual(["own", "communal"]);
	});

	test("an explicit on override beats a restrictive mode", () => {
		const injected = resolveInjectedDevices([device("communal")], {
			mode: "none",
			overrides: { communal: "on" },
		});
		expect(injected.map((d) => d.id)).toEqual(["communal"]);
	});

	test("an explicit off override beats a permissive mode", () => {
		const injected = resolveInjectedDevices([device("communal")], {
			mode: "all",
			overrides: { communal: "off" },
		});
		expect(injected).toEqual([]);
	});

	test("offline devices are never injected, even when switched on", () => {
		// Naming an unreachable device only invites failed tool calls.
		const injected = resolveInjectedDevices([device("d1", { online: false, owned: true })], {
			mode: "all",
			overrides: { d1: "on" },
		});
		expect(injected).toEqual([]);
	});
});

describe("no regression for deployments with no injection trait", () => {
	test("with no trait at all, every authorized online device is still injected", () => {
		// This is the upgrade path: nobody has configured injection yet, so the set
		// must be identical to what the old "inject every online device" code did.
		const authorized = [device("communal-a"), device("communal-b"), device("own", { owned: true })];
		const injection = mergeDeviceInjection({});
		expect(resolveInjectedDevices(authorized, injection).map((d) => d.id)).toEqual([
			"communal-a",
			"communal-b",
			"own",
		]);
	});

	test("offline devices were excluded before and still are", () => {
		const authorized = [device("online-one"), device("offline-one", { online: false })];
		expect(resolveInjectedDevices(authorized, mergeDeviceInjection({})).map((d) => d.id)).toEqual([
			"online-one",
		]);
	});
});

describe("injection ⊆ authorization invariant", () => {
	test("the result is always a subset of the input", () => {
		const authorized = [device("a", { owned: true }), device("b"), device("c", { online: false })];
		const authorizedIds = new Set(authorized.map((d) => d.id));
		const modes = ["none", "private", "all"] as const;
		const toggles = ["on", "off"] as const;

		for (const mode of modes) {
			for (const toggle of toggles) {
				for (const target of ["a", "b", "c", "unknown-device"]) {
					const injected = resolveInjectedDevices(authorized, {
						mode,
						overrides: { [target]: toggle },
					});
					// Nothing may appear that was not authorized, including an override
					// naming a device that was never granted.
					for (const item of injected) {
						expect(authorizedIds.has(item.id)).toBe(true);
					}
					expect(injected.length).toBeLessThanOrEqual(authorized.length);
				}
			}
		}
	});

	test("an override for an unauthorized device cannot conjure it", () => {
		const injected = resolveInjectedDevices([device("a")], {
			mode: "none",
			overrides: { "not-authorized": "on" },
		});
		expect(injected).toEqual([]);
	});

	test("an empty authorized set always yields an empty injection set", () => {
		for (const mode of ["none", "private", "all"] as const) {
			expect(resolveInjectedDevices([], { mode, overrides: { x: "on" } })).toEqual([]);
		}
	});
});
