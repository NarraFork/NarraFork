import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { workspaceExecutionOwners } from "@server/db/schema";
import type {
	WorkspaceProcessIdentity,
	WorkspaceProcessObservation,
} from "@server/lib/workspace-process-identity";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { __testing, assertWorkspaceOwnerEndedEvidence } from "./workspace-execution-owner";

const databases: Database[] = [];
function fixture() {
	const client = new Database(":memory:");
	databases.push(client);
	client.exec(`CREATE TABLE workspace_execution_owners(owner_epoch TEXT PRIMARY KEY, identity_json TEXT, created_at TEXT NOT NULL);
		CREATE TABLE workspace_write_leases(lease_id TEXT PRIMARY KEY, owner_epoch TEXT NOT NULL);`);
	const db = drizzle(client);
	return { client, db };
}
const identity: WorkspaceProcessIdentity = {
	version: 1,
	pid: 42,
	birth: "12345678901234567",
	domain: {
		platform: "linux",
		machine: "1234567890abcdef1234567890abcdef",
		boot: "12345678-1234-1234-1234-123456789012",
		pidNamespace: "pid:[123]",
		timeNamespace: "time:[789]",
	},
};
function authority(initial: WorkspaceProcessObservation = { kind: "present", identity }) {
	let observation = initial;
	let probes = 0;
	const deps = {
		pid: 42,
		now: () => "2026-01-01T00:00:00.000Z",
		observe: async () => {
			probes++;
			return observation;
		},
	};
	return {
		...__testing.createAuthority(deps),
		deps,
		set(value: WorkspaceProcessObservation) {
			observation = value;
		},
		probes: () => probes,
	};
}
function seed(db: ReturnType<typeof fixture>["db"], value: unknown = identity) {
	db.insert(workspaceExecutionOwners)
		.values({ ownerEpoch: "old", identityJson: value, createdAt: "old-time" })
		.run();
}
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});

describe("immutable workspace execution owner", () => {
	it("registers once asynchronously, sharing pending calls and hot reload state", async () => {
		const { db, client } = fixture();
		const a = authority();
		const first = a.initializeWorkspaceExecutionOwner(db, "new");
		expect(a.initializeWorkspaceExecutionOwner(db, "new")).toBe(first);
		await first;
		const reloaded = __testing.createAuthority(a.deps, a.state);
		await reloaded.initializeWorkspaceExecutionOwner(drizzle(client), "new");
		expect(a.probes()).toBe(1);
		expect(a.getWorkspaceOwnerRegistration(db, "new")?.identityJson).toEqual(identity);
		await expect(a.initializeWorkspaceExecutionOwner(db, "different")).rejects.toThrow(
			"already initialized",
		);
	});

	it("awaits lock certification once before startup registration resolves", async () => {
		const { db } = fixture();
		let finish: () => void = () => {};
		const pending = new Promise<void>((resolve) => {
			finish = resolve;
		});
		let registrations = 0;
		const a = __testing.createAuthority({
			pid: identity.pid,
			now: () => "now",
			observe: async () => ({ kind: "present", identity }),
			registerLockIdentity: async (value) => {
				registrations++;
				expect(value).toEqual(identity);
				expect(a.getWorkspaceOwnerRegistration(db, "new")?.identityJson).toEqual(identity);
				await pending;
			},
		});
		let completed = false;
		const started = a.initializeWorkspaceExecutionOwner(db, "new").then(() => {
			completed = true;
		});
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		expect(registrations).toBe(1);
		expect(completed).toBe(false);
		finish();
		await started;
		await a.initializeWorkspaceExecutionOwner(db, "new");
		expect(registrations).toBe(1);
		expect(completed).toBe(true);
	});

	it("never registers an epoch already referenced by a legacy lease", async () => {
		const { db, client } = fixture();
		client.exec("INSERT INTO workspace_write_leases VALUES('lease', 'old')");
		const a = authority();
		await expect(a.initializeWorkspaceExecutionOwner(db, "old")).rejects.toThrow("historical");
		expect(a.getWorkspaceOwnerRegistration(db, "old")).toBeUndefined();
		expect(a.probes()).toBe(0);
	});

	it("never overwrites or adopts an existing registered epoch", async () => {
		const { db } = fixture();
		seed(db);
		const a = authority();
		await expect(a.initializeWorkspaceExecutionOwner(db, "old")).rejects.toThrow("historical");
		expect(a.getWorkspaceOwnerRegistration(db, "old")?.identityJson).toEqual(identity);
	});

	it("retains unknown registration, without retry/backfill after probe improves", async () => {
		const { db } = fixture();
		const a = authority({ kind: "unknown" });
		await a.initializeWorkspaceExecutionOwner(db, "new");
		a.set({ kind: "present", identity });
		await a.initializeWorkspaceExecutionOwner(db, "new");
		expect(a.probes()).toBe(1);
		expect(a.getWorkspaceOwnerRegistration(db, "new")?.identityJson).toBeNull();
		expect(await a.proveWorkspaceOwnerEnded(db, "new")).toBeNull();
	});

	it("cannot prove missing, malformed or unknown historical owners ended", async () => {
		for (const value of [null, {}, { ...identity, birth: null }, { ...identity, version: 2 }]) {
			const { db } = fixture();
			seed(db, value);
			const a = authority({ kind: "absent", domain: identity.domain });
			expect(await a.proveWorkspaceOwnerEnded(db, "old")).toBeNull();
			expect(await a.proveWorkspaceOwnerEnded(db, "missing")).toBeNull();
			expect(a.probes()).toBe(0);
		}
	});

	it("exact birth mismatch proves PID reuse; live same birth never does", async () => {
		const { db } = fixture();
		seed(db);
		const a = authority();
		expect(await a.proveWorkspaceOwnerEnded(db, "old")).toBeNull();
		a.set({ kind: "present", identity: { ...identity, birth: "12345678901234568" } });
		const proof = await a.proveWorkspaceOwnerEnded(db, "old");
		expect(proof?.reason).toBe("pid_reused");
		expect(() => a.assertWorkspaceOwnerEndedEvidence(proof, "old")).not.toThrow();
	});

	it("failed probes and different machine, boot or namespace never prove death", async () => {
		const { db } = fixture();
		seed(db);
		const a = authority();
		for (const observation of [
			{ kind: "unknown" },
			{ kind: "absent", domain: { ...identity.domain, machine: "other" } },
			{ kind: "absent", domain: { ...identity.domain, boot: "other" } },
			{ kind: "absent", domain: { ...identity.domain, pidNamespace: "pid:[456]" } },
			{ kind: "absent", domain: { ...identity.domain, timeNamespace: "time:[456]" } },
		] as WorkspaceProcessObservation[]) {
			a.set(observation);
			expect(await a.proveWorkspaceOwnerEnded(db, "old")).toBeNull();
		}
	});

	it("proves a changed exact Linux boot only within matching machine and PID namespace", async () => {
		const { db } = fixture();
		seed(db);
		const nextBoot = { ...identity.domain, boot: "87654321-1234-1234-1234-123456789012" };
		const a = authority({ kind: "present", identity: { ...identity, domain: nextBoot } });
		expect((await a.proveWorkspaceOwnerEnded(db, "old"))?.reason).toBe("boot_changed");
		a.set({ kind: "absent", domain: nextBoot });
		expect((await a.proveWorkspaceOwnerEnded(db, "old"))?.reason).toBe("boot_changed");
		for (const domain of [
			{ ...nextBoot, machine: "abcdef1234567890abcdef1234567890" },
			{ ...nextBoot, pidNamespace: "pid:[456]" },
		]) {
			a.set({ kind: "absent", domain });
			expect(await a.proveWorkspaceOwnerEnded(db, "old")).toBeNull();
		}
	});

	it("does not mistake a time-namespace offset change for PID reuse", async () => {
		const { db } = fixture();
		seed(db);
		const a = authority({
			kind: "present",
			identity: {
				...identity,
				birth: "99999999999999999",
				domain: { ...identity.domain, timeNamespace: "time:[456]" },
			},
		});
		expect(await a.proveWorkspaceOwnerEnded(db, "old")).toBeNull();
	});

	it("keeps Windows creation identity exact, despite clock changes and sub-millisecond reuse", async () => {
		const { db } = fixture();
		const windows: WorkspaceProcessIdentity = {
			...identity,
			domain: {
				...identity.domain,
				platform: "win32",
				boot: "133000000000000000",
				pidNamespace: "windows-local-cim",
				timeNamespace: "windows-system",
			},
			birth: "133123456789012345",
		};
		seed(db, windows);
		const a = authority({ kind: "present", identity: windows });
		a.deps.now = () => "1999-01-01T00:00:00.000Z";
		expect(await a.proveWorkspaceOwnerEnded(db, "old")).toBeNull();
		a.set({ kind: "present", identity: { ...windows, birth: "133123456789012346" } });
		expect((await a.proveWorkspaceOwnerEnded(db, "old"))?.reason).toBe("pid_reused");
		const nextBoot = { ...windows.domain, boot: "133000000000000001" };
		a.set({ kind: "absent", domain: nextBoot });
		expect((await a.proveWorkspaceOwnerEnded(db, "old"))?.reason).toBe("pid_absent");
		a.set({ kind: "present", identity: { ...windows, domain: nextBoot } });
		expect(await a.proveWorkspaceOwnerEnded(db, "old")).toBeNull();
		a.set({
			kind: "present",
			identity: { ...windows, domain: nextBoot, birth: "133123456789012346" },
		});
		expect((await a.proveWorkspaceOwnerEnded(db, "old"))?.reason).toBe("pid_reused");
		a.set({
			kind: "absent",
			domain: { ...nextBoot, machine: "abcdef1234567890abcdef123456789012" },
		});
		expect(await a.proveWorkspaceOwnerEnded(db, "old")).toBeNull();
	});

	it("opaque proofs reject fabricated, copied, serialized and wrong-epoch evidence", async () => {
		const { db } = fixture();
		seed(db);
		const a = authority({ kind: "absent", domain: identity.domain });
		const proof = await a.proveWorkspaceOwnerEnded(db, "old");
		expect(proof).not.toBeNull();
		expect(Object.isFrozen(proof)).toBe(true);
		expect(Object.isFrozen(proof?.identity.domain)).toBe(true);
		for (const invalid of [{}, { ...proof }, JSON.parse(JSON.stringify(proof)), null]) {
			expect(() => a.assertWorkspaceOwnerEndedEvidence(invalid, "old")).toThrow();
		}
		expect(() => a.assertWorkspaceOwnerEndedEvidence(proof, "wrong")).toThrow();
		const reloaded = __testing.createAuthority(a.deps, a.state);
		expect(() => reloaded.assertWorkspaceOwnerEndedEvidence(proof, "old")).not.toThrow();
		// An injected test issuer cannot mint production capabilities.
		expect(() => assertWorkspaceOwnerEndedEvidence(proof, "old")).toThrow();
	});
});
