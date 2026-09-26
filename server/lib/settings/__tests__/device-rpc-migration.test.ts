import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS, narraforkDir, reloadSettings } from "../index";

const path = join(narraforkDir, "settings.json");
let original: string;

beforeEach(() => {
	original = readFileSync(path, "utf8");
});
afterEach(() => {
	writeFileSync(path, original);
	reloadSettings();
});

function writeDevices(devices: Record<string, unknown>) {
	writeFileSync(path, JSON.stringify({ ...JSON.parse(original), devices }));
}

describe("device RPC concurrency defaults migration", () => {
	test("upgrades the persisted legacy 16 once and saves the migration", () => {
		writeDevices({ maxConcurrentRpcPerDevice: 16, rpcTimeoutMs: 9000 });
		expect(reloadSettings().devices?.maxConcurrentRpcPerDevice).toBe(64);
		const saved = JSON.parse(readFileSync(path, "utf8"));
		expect(saved.devices.maxConcurrentRpcPerDevice).toBe(64);
		expect(saved.devices.rpcTimeoutMs).toBe(9000);
		expect(saved.devices.rpcConcurrencyDefaultsVersion).toBe(1);
		saved.devices.maxConcurrentRpcPerDevice = 16;
		writeFileSync(path, JSON.stringify(saved));
		// A deliberate choice made AFTER migration is not repeatedly overwritten.
		expect(reloadSettings().devices?.maxConcurrentRpcPerDevice).toBe(16);
	});

	for (const value of [1, 8, 32, 128]) {
		test(`preserves a custom concurrency limit of ${value}`, () => {
			writeDevices({ maxConcurrentRpcPerDevice: value });
			expect(reloadSettings().devices?.maxConcurrentRpcPerDevice).toBe(value);
		});
	}

	test("new installs and missing configuration get 64", () => {
		writeDevices({});
		expect(reloadSettings().devices?.maxConcurrentRpcPerDevice).toBe(64);
		expect(DEFAULTS.devices?.maxConcurrentRpcPerDevice).toBe(64);
	});
});
