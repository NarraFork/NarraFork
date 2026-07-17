import { describe, expect, test } from "bun:test";
import type {
	CurrentPackagePointer,
	CurrentPointerFile,
	PackageInstallOptions,
	SetCurrentOptions,
} from "../plugin-package-store";
import { PluginUpgradeCoordinator } from "../plugin-upgrade-coordinator";

const oldPointer = { version: "1.0.0", hash: "a".repeat(64) };
const nextPointer = { version: "2.0.0", hash: "b".repeat(64) };
const thirdPointer = { version: "3.0.0", hash: "c".repeat(64) };
const externalPointer = { version: "9.0.0", hash: "d".repeat(64) };

type FakeStoreOptions = {
	candidates?: CurrentPackagePointer[];
	failRestore?: boolean;
	beforeSetCurrent?: () => void;
};

function pointerEqual(
	left: CurrentPackagePointer | undefined,
	right: CurrentPackagePointer | null,
) {
	if (!left || !right) return !left && !right;
	return left.version === right.version && left.hash === right.hash;
}

function makeStore(options: FakeStoreOptions = {}) {
	const current: CurrentPointerFile = {
		version: 1,
		plugins: { "com.example.test": { ...oldPointer } },
	};
	const candidates = [...(options.candidates ?? [nextPointer])];
	const starts: string[] = [];
	const store = {
		readCurrent: async () => structuredClone(current),
		install: async (_source: string, installOptions: PackageInstallOptions = {}) => {
			const pointer = candidates.shift() ?? nextPointer;
			if (installOptions.updateCurrent !== false) {
				await store.setCurrent("com.example.test", pointer, {
					expectedCurrent: installOptions.expectedCurrent,
				});
			}
			return {
				pluginId: "com.example.test",
				version: pointer.version,
				hash: pointer.hash,
				packagePath: "/pkg",
				path: "/pkg",
				manifest: {} as never,
				alreadyInstalled: false,
				currentUpdated: installOptions.updateCurrent !== false,
			};
		},
		setCurrent: async (
			pluginId: string,
			pointer: CurrentPackagePointer | undefined,
			setOptions: SetCurrentOptions = {},
		) => {
			if (options.beforeSetCurrent) {
				options.beforeSetCurrent();
				options.beforeSetCurrent = undefined;
			}
			const actual = current.plugins[pluginId];
			if (
				setOptions.expectedCurrent !== undefined &&
				!pointerEqual(actual, setOptions.expectedCurrent)
			) {
				throw new Error("current pointer CAS conflict");
			}
			if (options.failRestore && pointer?.hash === oldPointer.hash) {
				throw new Error("simulated pointer restore failure");
			}
			if (pointer) current.plugins[pluginId] = { ...pointer };
			else delete current.plugins[pluginId];
			return structuredClone(current);
		},
	};
	return { store, getCurrent: () => current, starts };
}

function makeRuntime(starts: string[], failHashes = new Set<string>()) {
	return {
		drain: async (pluginId: string) => {
			starts.push(`drain:${pluginId}`);
		},
		stop: async (pluginId: string) => {
			starts.push(`stop:${pluginId}`);
		},
		start: async (pluginId: string, pointer: CurrentPackagePointer) => {
			starts.push(`${pluginId}:${pointer.hash}`);
			if (failHashes.has(pointer.hash)) throw new Error(`runtime start failed for ${pointer.hash}`);
		},
	};
}

describe("plugin upgrade coordinator", () => {
	test("stages a candidate and restores old pointer/runtime when health fails", async () => {
		const fake = makeStore();
		const coordinator = new PluginUpgradeCoordinator({
			store: fake.store,
			runtime: makeRuntime(fake.starts),
			healthCheck: async () => false,
		});
		let thrown:
			| (Error & {
					upgrade?: {
						status: string;
						candidate?: CurrentPackagePointer;
						to?: CurrentPackagePointer;
					};
			  })
			| undefined;
		try {
			await coordinator.upgrade("com.example.test", "/new");
		} catch (error) {
			thrown = error as typeof thrown;
		}
		if (!thrown) throw new Error("expected upgrade to fail");
		expect(fake.getCurrent().plugins["com.example.test"]).toEqual(oldPointer);
		expect(fake.starts).toContain(`com.example.test:${oldPointer.hash}`);
		expect(thrown.upgrade?.status).toBe("rolled-back");
		expect(thrown.upgrade?.candidate).toEqual(nextPointer);
		expect(thrown.upgrade?.to).toEqual(oldPointer);
		expect(coordinator.getLastKnownGood("com.example.test")).toEqual(oldPointer);
	});

	test("serializes upgrades per plugin and retains the previous healthy pointer as rollback target", async () => {
		const fake = makeStore({ candidates: [nextPointer, thirdPointer] });
		const coordinator = new PluginUpgradeCoordinator({
			store: fake.store,
			runtime: makeRuntime(fake.starts),
		});
		const [first, second] = await Promise.all([
			coordinator.upgrade("com.example.test", "/first"),
			coordinator.upgrade("com.example.test", "/second"),
		]);
		expect(first.status).toBe("succeeded");
		expect(second.status).toBe("succeeded");
		expect(second.from).toEqual(nextPointer);
		expect(coordinator.getLastKnownGood("com.example.test")).toEqual(thirdPointer);
		expect(coordinator.getRollbackTarget("com.example.test")).toEqual(nextPointer);
	});

	test("rollback failure compensates pointer and runtime back to the pre-rollback package", async () => {
		const fake = makeStore({ candidates: [nextPointer, thirdPointer] });
		const starts: string[] = [];
		const failHashes = new Set<string>();
		const coordinator = new PluginUpgradeCoordinator({
			store: fake.store,
			runtime: makeRuntime(starts, failHashes),
		});
		await coordinator.upgrade("com.example.test", "/first");
		await coordinator.upgrade("com.example.test", "/second");
		failHashes.add(nextPointer.hash);
		let thrown: (Error & { upgrade?: { status: string } }) | undefined;
		try {
			await coordinator.rollback("com.example.test");
		} catch (error) {
			thrown = error as typeof thrown;
		}
		if (!thrown) throw new Error("expected rollback to fail");
		expect(fake.getCurrent().plugins["com.example.test"]).toEqual(thirdPointer);
		expect(starts).toContain(`com.example.test:${thirdPointer.hash}`);
		expect(thrown.upgrade?.status).toBe("rolled-back");
	});

	test("does not clobber a concurrent pointer change after CAS failure", async () => {
		const fake = makeStore({
			beforeSetCurrent: () => {
				fake.getCurrent().plugins["com.example.test"] = { ...externalPointer };
			},
		});
		const coordinator = new PluginUpgradeCoordinator({
			store: fake.store,
			runtime: makeRuntime(fake.starts),
		});
		let thrown: (Error & { upgrade?: { status: string } }) | undefined;
		try {
			await coordinator.upgrade("com.example.test", "/new");
		} catch (error) {
			thrown = error as typeof thrown;
		}
		if (!thrown) throw new Error("expected CAS conflict");
		expect(fake.getCurrent().plugins["com.example.test"]).toEqual(externalPointer);
		expect(thrown.upgrade?.status).toBe("failed");
	});
});
