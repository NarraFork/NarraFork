import { describe, expect, mock, test } from "bun:test";
import { normalizePathForComparison } from "../lib/platform-path";
import {
	assertWorkspaceAdmission,
	canonicalWorkspaceAdmissionTarget,
	createLifecycleGuard,
	type LifecycleGuardPorts,
	type ResourceClaim,
	ResourceProtectionError,
	withLifecycleGuardPorts,
	withProtectionReservation,
	withWorkspaceAdmission,
} from "./worktree-lifecycle-guard";

function fixture(claims: ResourceClaim[] = [], complete = true) {
	const ports: LifecycleGuardPorts = {
		canonicalPath: async (path) => path.replace("/alias/", "/real/"),
		readClaims: async () => ({ claims, complete }),
	};
	return { ports, guard: createLifecycleGuard(ports) };
}
const target = { path: "/real/worktree" };

describe("canonical cwd spelling", () => {
	test("Windows cwd keeps filesystem casing while ownership keys still ignore case", async () => {
		const requested = "C:\\Users\\Alice\\MyProject";
		const ports: LifecycleGuardPorts = {
			canonicalAdmissionPath: async () => requested,
			canonicalPath: async (path) => path.replaceAll("\\", "/").toLowerCase(),
			readClaims: async () => ({
				complete: true,
				claims: [{ kind: "narrator", id: "owner", path: "c:/users/alice/myproject" }],
			}),
		};
		const target = await withLifecycleGuardPorts(ports, () =>
			canonicalWorkspaceAdmissionTarget({ deviceId: "local", path: requested }),
		);
		expect(target.canonicalCwd).toBe(requested);
		expect(target.path).toBe(normalizePathForComparison(requested));
		const guard = createLifecycleGuard(ports);
		for (const path of [requested, requested.toUpperCase(), requested.toLowerCase()]) {
			expect((await guard.inspect([{ path }], "delete")).status).toBe("protected");
		}
	});

	test("remote cwd spelling is left untouched and does not probe local filesystem", async () => {
		const canonicalPath = mock(async (path: string) => path.toLowerCase());
		const ports: LifecycleGuardPorts = {
			canonicalPath,
			readClaims: async () => ({ complete: true, claims: [] }),
		};
		const path = "/Work/MyProject";
		const target = await withLifecycleGuardPorts(ports, () =>
			canonicalWorkspaceAdmissionTarget({ deviceId: "remote", path }),
		);
		expect(target.path).toBe(path);
		expect(target.canonicalCwd).toBe(path);
		expect(canonicalPath).not.toHaveBeenCalled();
	});
});

describe("read-only lifecycle protection", () => {
	for (const state of ["preparing", "ready", "unknown"]) {
		test(`inventory ${state} survives owner deletion and cannot be forced away`, async () => {
			const { guard } = fixture([
				{ kind: "registry", id: "owner-deleted", path: target.path, state },
			]);
			const destroy = mock(async () => undefined);
			await expect(
				guard.withProtectionReservation([target], "force shadow destroy", destroy),
			).rejects.toBeInstanceOf(ResourceProtectionError);
			expect(destroy).toHaveBeenCalledTimes(0);
			expect((await guard.inspect([target], "delete")).status).toBe("protected");
		});
	}
	for (const [name, claim] of [
		["nested child", { kind: "registry", id: "nested", path: "/real/worktree/child" }],
		["ancestor", { kind: "registry", id: "ancestor", path: "/real" }],
		["canonical alias", { kind: "registry", id: "alias", path: "/alias/worktree" }],
		["ordinary cwd", { kind: "narrator", id: "cwd", path: "/real/worktree/src" }],
		["ordinary ancestor cwd", { kind: "narrator", id: "cwd", path: "/real" }],
		["receipt", { kind: "receipt", id: "pending", path: "/real/worktree" }],
		["other chapter", { kind: "chapter", id: "shared", path: "/real/worktree" }],
	] satisfies Array<[string, ResourceClaim]>) {
		test(`${name} protects without selecting or registering an owner`, async () => {
			const { guard } = fixture([claim]);
			expect(await guard.inspect([target], "remove")).toMatchObject({
				status: "protected",
				complete: true,
			});
		});
	}
	test("shared dormant shadow key protects with no worktreePath", async () => {
		const { guard } = fixture([
			{ kind: "chapter", id: "dormant", shadowKey: "local\0/real/worktree" },
		]);
		expect((await guard.inspect([target], "shadow force")).status).toBe("protected");
	});
	test("same-repository inventory outside project gitPath protects project deletion", async () => {
		const { guard } = fixture([
			{ kind: "registry", id: "external", path: "/external/worktree", repositoryKey: "repo" },
		]);
		expect(
			(await guard.inspect([{ path: "/real/project", repositoryKey: "repo" }], "project delete"))
				.status,
		).toBe("protected");
	});
	test("different device is not local ownership, remote destructive paths fail closed", async () => {
		const { guard } = fixture([
			{ kind: "registry", id: "remote", deviceId: "device", path: target.path },
		]);
		expect((await guard.inspect([target], "local remove")).status).toBe("clear");
		expect((await guard.inspect([{ ...target, deviceId: "device" }], "remote remove")).status).toBe(
			"unavailable",
		);
	});
	for (const reason of ["truncated", "read error", "aborted", "over budget", "empty target"]) {
		test(`${reason} never becomes complete ownership evidence`, async () => {
			const { ports } = fixture([], reason !== "truncated");
			if (reason === "read error")
				ports.readClaims = async () => {
					throw new Error("unreadable");
				};
			if (reason === "over budget")
				ports.readClaims = async () => ({
					complete: true,
					claims: [{ kind: "registry", id: "x".repeat(256 * 1024), path: "/elsewhere" }],
				});
			const guard = createLifecycleGuard(ports);
			const controller = new AbortController();
			if (reason === "aborted") controller.abort();
			const result = await guard.inspect(
				reason === "empty target" ? [{}] : [target],
				"delete",
				undefined,
				controller.signal,
			);
			expect(result).toMatchObject({ status: "unavailable", complete: false });
		});
	}
	test("unclaimed legacy removal keeps command dispatch and its ordinary failure", async () => {
		const { guard } = fixture();
		const remove = mock(async () => {
			throw new Error("ordinary git failure");
		});
		await expect(
			guard.withProtectionReservation([target], "legacy remove", remove),
		).rejects.toThrow("ordinary git failure");
		expect(remove).toHaveBeenCalledTimes(1);
	});
});

describe("Git-root compatibility requires positive identity proof", () => {
	test("repo-root chapter/cwd does not own a distinct linked child worktree", async () => {
		const { ports } = fixture([
			{ kind: "chapter", id: "root", path: "/real" },
			{ kind: "narrator", id: "root-session", path: "/real" },
		]);
		ports.probeGitRoot = async (path) => ({ root: path, common: "/real/.git" });
		expect(
			(await createLifecycleGuard(ports).inspect([target], "remove legacy child")).status,
		).toBe("clear");
	});
	test("no distinct-root exception for an ordinary subdirectory or durable inventory", async () => {
		const { ports } = fixture([{ kind: "narrator", id: "root-session", path: "/real" }]);
		ports.probeGitRoot = async () => ({ root: "/real", common: "/real/.git" });
		expect((await createLifecycleGuard(ports).inspect([target], "remove directory")).status).toBe(
			"protected",
		);
		ports.readClaims = async () => ({
			complete: true,
			claims: [{ kind: "registry", id: "independent", path: "/real" }],
		});
		ports.probeGitRoot = async (path) => ({ root: path, common: "/real/.git" });
		expect((await createLifecycleGuard(ports).inspect([target], "force")).status).toBe("protected");
	});
});

test("cwd ordinary subdirectory is not an exact Git root and cannot waive its child claim", async () => {
	const { ports } = fixture([
		{ kind: "narrator", id: "ordinary-subdir", path: "/real/repo/subdir" },
	]);
	ports.probeGitRoot = async (path) => ({
		root: path === "/real/repo/subdir" ? "/real/repo" : path,
		common: "/real/repo/.git",
	});
	expect(
		(
			await createLifecycleGuard(ports).inspect(
				[{ path: "/real/repo/subdir/linked" }],
				"delete child",
			)
		).status,
	).toBe("protected");
});

describe("same-process reservation and workspace admission", () => {
	test("aborted retirement has no claim-read or destructive dispatch", async () => {
		const controller = new AbortController();
		controller.abort();
		const destroy = mock(async () => undefined);
		await expect(
			withProtectionReservation([target], "cancelled delete", destroy, controller.signal),
		).rejects.toBeInstanceOf(ResourceProtectionError);
		expect(destroy).toHaveBeenCalledTimes(0);
	});
	test("hung canonicalization stops at the five-second budget and releases admission", async () => {
		const { ports } = fixture();
		ports.canonicalPath = () => new Promise<string>(() => undefined);
		const guard = createLifecycleGuard(ports);
		const destroy = mock(async () => undefined);
		await expect(
			guard.withProtectionReservation([target], "hung prepare", destroy),
		).rejects.toBeInstanceOf(ResourceProtectionError);
		expect(destroy).toHaveBeenCalledTimes(0);
		expect(() => assertWorkspaceAdmission(target)).not.toThrow();
	}, 6000);
	test("late registry/switch commit is rejected until retirement releases; retry succeeds", async () => {
		const { guard } = fixture();
		let enter!: () => void;
		let release!: () => void;
		const entered = new Promise<void>((resolve) => {
			enter = resolve;
		});
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		const retirement = guard.withProtectionReservation([target], "retire", async () => {
			enter();
			await released;
		});
		await entered;
		const register = mock(async () => undefined);
		try {
			expect(() => assertWorkspaceAdmission({ path: "/real/worktree/nested" })).toThrow(
				ResourceProtectionError,
			);
			await expect(withWorkspaceAdmission(target, register)).rejects.toBeInstanceOf(
				ResourceProtectionError,
			);
			expect(register).toHaveBeenCalledTimes(0);
		} finally {
			release();
			await retirement;
		}
		await withWorkspaceAdmission(target, register);
		expect(register).toHaveBeenCalledTimes(1);
	});
	test("claim commit in flight blocks retirement before durable registration exists", async () => {
		const { guard } = fixture();
		await withWorkspaceAdmission(target, async () => {
			const destroy = mock(async () => undefined);
			await expect(
				guard.withProtectionReservation([target], "retire", destroy),
			).rejects.toBeInstanceOf(ResourceProtectionError);
			expect(destroy).toHaveBeenCalledTimes(0);
		});
	});
	test("nested sink reuses reservation without reentrant mutex deadlock", async () => {
		const { guard } = fixture();
		const sink = mock(async () => "removed");
		expect(
			await guard.withProtectionReservation([target], "entry", () =>
				guard.withProtectionReservation([target], "sink", sink),
			),
		).toBe("removed");
		expect(sink).toHaveBeenCalledTimes(1);
	});
	test("preparing canonicalization blocks admission before its first await completes", async () => {
		let release!: () => void;
		const waiting = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { ports } = fixture();
		ports.canonicalPath = async (path) => {
			await waiting;
			return path;
		};
		const guard = createLifecycleGuard(ports);
		const retirement = guard.withProtectionReservation([target], "retire", async () => undefined);
		expect(() => assertWorkspaceAdmission(target)).toThrow(ResourceProtectionError);
		release();
		await retirement;
		expect(() => assertWorkspaceAdmission(target)).not.toThrow();
	});
});
