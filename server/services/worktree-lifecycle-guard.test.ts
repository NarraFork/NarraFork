import { describe, expect, mock, test } from "bun:test";
import { resolve } from "node:path";
import { localPathSemantics } from "../lib/agent/execution/path-semantics";
import { treeSnapshotKey, treeSnapshotPhysicalDir } from "./tree-snapshot-paths";
import {
	assertWorkspaceAdmission,
	canonicalWorkspaceAdmissionTarget,
	createLifecycleGuard,
	type LifecycleGuardPorts,
	type ResourceClaim,
	ResourceProtectionError,
	revalidateLifecycleTarget,
	withLifecycleContext,
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

function latch() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

describe("explicit deletion effects and identity contexts", () => {
	test("identity context permits shared use without reading inventory", async () => {
		const { ports } = fixture();
		ports.pathIdentity = async () => "device:inode";
		const readClaims = mock(async () => {
			throw new Error("must not inventory normal use");
		});
		ports.readClaims = readClaims;
		await withLifecycleGuardPorts(ports, () =>
			withLifecycleContext([target.path], async () => {
				expect(await revalidateLifecycleTarget(target.path)).toBe(target.path);
				await withWorkspaceAdmission(target, async () => undefined);
				expect(() => assertWorkspaceAdmission({ path: "/real/worktree/child" })).not.toThrow();
			}),
		);
		expect(readClaims).not.toHaveBeenCalled();
	});
	test("identity context cannot waive a subsequent real sink's claims", async () => {
		const { ports } = fixture([{ kind: "registry", id: "independent", ...target }]);
		ports.pathIdentity = async () => "device:inode";
		const readClaims = mock(ports.readClaims);
		ports.readClaims = readClaims;
		const sink = mock(async () => undefined);
		await withLifecycleGuardPorts(ports, () =>
			withLifecycleContext([target.path], async () => {
				await expect(withProtectionReservation([target], "real sink", sink)).rejects.toBeInstanceOf(
					ResourceProtectionError,
				);
				expect(() => assertWorkspaceAdmission(target)).not.toThrow();
			}),
		);
		expect(readClaims).toHaveBeenCalledTimes(1);
		expect(sink).not.toHaveBeenCalled();
	});
	test("target-free context can publish a later real sink and block only that target", async () => {
		const { ports } = fixture();
		ports.pathIdentity = async () => "device:inode";
		await withLifecycleGuardPorts(ports, () =>
			withLifecycleContext([], async () => {
				expect(
					await withProtectionReservation([target], "real sink", async () => {
						expect(() => assertWorkspaceAdmission(target)).toThrow(ResourceProtectionError);
						expect(() => assertWorkspaceAdmission({ path: "/real/sibling" })).not.toThrow();
						await withProtectionReservation([target], "real sink fallback", async () => undefined);
						return "removed";
					}),
				).toBe("removed");
			}),
		);
		expect(() => assertWorkspaceAdmission(target)).not.toThrow();
	});
	test("a nested real sink rereads claims rather than inheriting prior deletion authority", async () => {
		const claims: ResourceClaim[] = [];
		const { ports } = fixture(claims);
		ports.pathIdentity = async () => "device:inode";
		const sink = mock(async () => undefined);
		await withLifecycleGuardPorts(ports, () =>
			withLifecycleContext([target.path], () =>
				withProtectionReservation([target], "entry", async () => {
					claims.push({ kind: "registry", id: "late-independent-owner", ...target });
					await expect(
						withProtectionReservation([target], "real sink fallback", sink),
					).rejects.toMatchObject({ inspection: { status: "protected" } });
					expect(() => assertWorkspaceAdmission(target)).toThrow(ResourceProtectionError);
				}),
			),
		);
		expect(sink).not.toHaveBeenCalled();
		expect(() => assertWorkspaceAdmission(target)).not.toThrow();
	});
	test("aborted identity context does not prepare paths or dispatch its body", async () => {
		const { ports } = fixture();
		const canonicalPath = mock(ports.canonicalPath);
		ports.canonicalPath = canonicalPath;
		const controller = new AbortController();
		controller.abort();
		const body = mock(async () => undefined);
		await withLifecycleGuardPorts(ports, async () => {
			await expect(
				withLifecycleContext([target.path], body, controller.signal),
			).rejects.toBeInstanceOf(ResourceProtectionError);
		});
		expect(canonicalPath).not.toHaveBeenCalled();
		expect(body).not.toHaveBeenCalled();
	});
	test("nested identity context observes cancellation after preparation before body dispatch", async () => {
		const { ports } = fixture();
		const controller = new AbortController();
		const nestedPath = "/real/sibling";
		ports.canonicalPath = async (path) => {
			if (path === nestedPath) controller.abort();
			return path;
		};
		ports.pathIdentity = async () => "device:inode";
		const body = mock(async () => undefined);
		await withLifecycleGuardPorts(ports, () =>
			withLifecycleContext([target.path], async () => {
				await expect(
					withLifecycleContext([nestedPath], body, controller.signal),
				).rejects.toBeInstanceOf(ResourceProtectionError);
				expect(await revalidateLifecycleTarget(target.path)).toBe(target.path);
				expect(() => assertWorkspaceAdmission(target)).not.toThrow();
			}),
		);
		expect(body).not.toHaveBeenCalled();
	});
	test("identity contexts still reject inode replacement", async () => {
		const { ports } = fixture();
		let identity = "device:before";
		ports.pathIdentity = async () => identity;
		await withLifecycleGuardPorts(ports, () =>
			withLifecycleContext([target.path], async () => {
				identity = "device:after";
				await expect(revalidateLifecycleTarget(target.path)).rejects.toBeInstanceOf(
					ResourceProtectionError,
				);
			}),
		);
	});
	test("native footprint identities do not merge POSIX literal backslashes with separators", async () => {
		const literal = resolve(
			process.platform === "win32" ? "/real/literal-worktree" : "/real/literal\\worktree",
		);
		const nested = resolve("/real/literal/worktree");
		const { ports } = fixture();
		ports.pathIdentity = async (path) => (path === literal ? "device:literal" : "device:nested");
		await withLifecycleGuardPorts(ports, () =>
			withLifecycleContext([literal, nested], async () => {
				expect(await revalidateLifecycleTarget(literal)).toBe(literal);
				expect(await revalidateLifecycleTarget(nested)).toBe(nested);
			}),
		);
	});
	test("identity contexts still reject alias redirection", async () => {
		const { ports } = fixture();
		let canonical = target.path;
		ports.pathIdentity = async () => "device:inode";
		ports.canonicalPath = async (path) => (path === "/alias/worktree" ? canonical : path);
		await withLifecycleGuardPorts(ports, () =>
			withLifecycleContext(["/alias/worktree"], async () => {
				canonical = "/real/replacement";
				await expect(revalidateLifecycleTarget("/alias/worktree")).rejects.toBeInstanceOf(
					ResourceProtectionError,
				);
			}),
		);
	});
	test("metadata barrier blocks only its project and never inventories unrelated disk", async () => {
		const { ports, guard } = fixture();
		const readClaims = mock(async () => {
			throw new Error("unrelated inventory unavailable");
		});
		ports.readClaims = readClaims;
		await guard.withProtectionReservation(
			[{ scopeProjectId: "project-a" }],
			"project metadata",
			async () => {
				expect(() =>
					assertWorkspaceAdmission({ scopeProjectId: "project-a", deviceId: "remote" }),
				).toThrow(ResourceProtectionError);
				await withWorkspaceAdmission(
					{ scopeProjectId: "project-b", ...target },
					async () => undefined,
				);
				expect(() => assertWorkspaceAdmission(target)).not.toThrow();
			},
		);
		expect(readClaims).not.toHaveBeenCalled();
	});
	test("a same-project admission protects metadata retirement even at another device", async () => {
		const { guard } = fixture();
		await withWorkspaceAdmission(
			{ scopeProjectId: "project-a", deviceId: "remote", path: "/work" },
			async () => {
				await expect(
					guard.withProtectionReservation(
						[{ scopeProjectId: "project-a" }],
						"project metadata",
						async () => undefined,
					),
				).rejects.toBeInstanceOf(ResourceProtectionError);
			},
		);
	});
	test("a deletion resolving aliases observes an in-flight claim published during preparation", async () => {
		const { ports } = fixture();
		const entered = latch();
		const prepared = latch();
		ports.canonicalPath = async (path) => {
			if (path === "/alias/worktree") {
				entered.release();
				await prepared.promise;
			}
			return path.replace("/alias/", "/real/");
		};
		const guard = createLifecycleGuard(ports);
		const sink = mock(async () => undefined);
		const deletion = guard.withProtectionReservation(
			[{ path: "/alias/worktree" }],
			"retire alias",
			sink,
		);
		await entered.promise;
		await withLifecycleGuardPorts(ports, () =>
			withWorkspaceAdmission(target, async () => {
				prepared.release();
				await expect(deletion).rejects.toBeInstanceOf(ResourceProtectionError);
			}),
		);
		expect(sink).not.toHaveBeenCalled();
	});
});

describe("canonical cwd spelling", () => {
	test("local cwd keeps filesystem casing and uses native ownership identity", async () => {
		const requested =
			process.platform === "win32" ? "C:\\Users\\Alice\\MyProject" : "/Users/Alice/MyProject";
		const key = localPathSemantics.identityKey(resolve(requested));
		const ports: LifecycleGuardPorts = {
			canonicalAdmissionPath: async () => requested,
			canonicalPath: async (path) => localPathSemantics.identityKey(resolve(path)),
			readClaims: async () => ({
				complete: true,
				claims: [{ kind: "narrator", id: "owner", path: key }],
			}),
		};
		const target = await withLifecycleGuardPorts(ports, () =>
			canonicalWorkspaceAdmissionTarget({ deviceId: "local", path: requested }),
		);
		expect(target.canonicalCwd).toBe(requested);
		expect(target.path).toBe(key);
		const guard = createLifecycleGuard(ports);
		for (const path of [requested, requested.toUpperCase(), requested.toLowerCase()]) {
			expect((await guard.inspect([{ path }], "delete")).status).toBe(
				path === requested || process.platform === "win32" ? "protected" : "clear",
			);
		}
	});

	test("native admission distinguishes POSIX literal backslashes from path separators", async () => {
		const literal = resolve(
			process.platform === "win32" ? "/real/literal-worktree" : "/real/literal\\worktree",
		);
		const nested = resolve("/real/literal/worktree");
		const { ports, guard } = fixture();
		await withLifecycleGuardPorts(ports, async () => {
			const admission = await canonicalWorkspaceAdmissionTarget({ path: literal });
			expect(admission.canonicalCwd).toBe(literal);
			expect(admission.path).toBe(localPathSemantics.identityKey(literal));
			expect(admission.path).not.toBe(localPathSemantics.identityKey(nested));
			await guard.withProtectionReservation(
				[{ path: literal }],
				"delete literal name",
				async () => {
					await expect(
						withWorkspaceAdmission({ path: literal }, async () => undefined),
					).rejects.toBeInstanceOf(ResourceProtectionError);
					expect(await withWorkspaceAdmission({ path: nested }, async () => "independent")).toBe(
						"independent",
					);
				},
			);
		});
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
		["dot-prefixed child", { kind: "registry", id: "dot-child", path: "/real/worktree/..cache" }],
		["ancestor", { kind: "registry", id: "ancestor", path: "/real" }],
		["canonical alias", { kind: "registry", id: "alias", path: "/alias/worktree" }],
		["ordinary cwd", { kind: "narrator", id: "cwd", path: "/real/worktree/src" }],
		["ordinary ancestor cwd", { kind: "narrator", id: "cwd", path: "/real" }],
		["receipt", { kind: "receipt", id: "pending", path: "/real/worktree" }],
	] satisfies Array<[string, ResourceClaim]>) {
		test(`${name} protects without selecting or registering an owner`, async () => {
			const { guard } = fixture([claim]);
			expect(await guard.inspect([target], "remove")).toMatchObject({
				status: "protected",
				complete: true,
			});
		});
	}
	test("ordinary checkout cwd is not a claim on shadow storage", async () => {
		const { guard } = fixture([{ kind: "narrator", id: "cwd", path: target.path }]);
		expect(
			(
				await guard.inspect(
					[
						{ deviceId: "local", shadowKey: treeSnapshotKey("local", target.path) },
						{ deviceId: "local", path: treeSnapshotPhysicalDir("local", target.path) },
					],
					"shadow destroy",
				)
			).status,
		).toBe("clear");
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
	for (const path of [
		"C:\\Work\\Project",
		"\\\\server\\share\\Project",
		"/Work/literal\\Project",
	]) {
		test(`remote shadow syntax is validated independently of the host: ${path}`, async () => {
			const { ports } = fixture([
				{ kind: "registry", id: "remote-shadow", deviceId: "remote", shadowKey: `remote\0${path}` },
			]);
			const canonicalPath = mock(ports.canonicalPath);
			ports.canonicalPath = canonicalPath;
			expect((await createLifecycleGuard(ports).inspect([target], "local delete")).status).toBe(
				"clear",
			);
			expect(canonicalPath).not.toHaveBeenCalledWith(path);
		});
	}
	for (const path of ["relative/project", "C:drive-relative", "\\drive-rooted"]) {
		test(`ambiguous remote shadow syntax remains unverifiable: ${path}`, async () => {
			const { guard } = fixture([
				{ kind: "registry", id: "remote-shadow", deviceId: "remote", shadowKey: `remote\0${path}` },
			]);
			expect((await guard.inspect([target], "local delete")).status).toBe("unavailable");
		});
	}
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
				controller.signal,
			);
			expect(result).toMatchObject({ status: "unavailable", complete: false });
		});
	}
	test("operation labels cannot bypass incomplete legacy inventory", async () => {
		const { guard } = fixture([], false);
		const sink = mock(async () => undefined);
		for (const operation of [
			"shadow initialization",
			"shadow initialization rollback",
			"shadow destroy",
		]) {
			expect((await guard.inspect([target], operation)).status).toBe("unavailable");
			await expect(
				guard.withProtectionReservation([target], operation, sink),
			).rejects.toMatchObject({ inspection: { status: "unavailable" } });
		}
		expect(sink).not.toHaveBeenCalled();
	});

	test("real shadow deletion refuses direct physical owners", async () => {
		const physical = treeSnapshotPhysicalDir("local", target.path);
		for (const kind of ["narrator", "registry"] as const) {
			const { guard } = fixture([{ kind, id: "direct-D-owner", path: physical }]);
			const sink = mock(async () => undefined);
			await expect(
				guard.withProtectionReservation(
					[{ deviceId: "local", path: physical }],
					"shadow destroy",
					sink,
				),
			).rejects.toMatchObject({ inspection: { status: "protected" } });
			expect(sink).not.toHaveBeenCalled();
		}
	});
	test("real shadow deletion refuses a live lineage reference without a cwd", async () => {
		const physical = treeSnapshotPhysicalDir("local", target.path);
		const { guard } = fixture([
			{ kind: "registry", id: "independent", shadowKey: treeSnapshotKey("local", target.path) },
		]);
		const sink = mock(async () => undefined);
		await expect(
			guard.withProtectionReservation([{ path: physical }], "shadow destroy", sink),
		).rejects.toMatchObject({ inspection: { status: "protected" } });
		expect(sink).not.toHaveBeenCalled();
	});

	test("streamed references do not inherit a global historical byte cap", async () => {
		const { ports } = fixture();
		ports.readClaims = async (_deadline, _signal, targets) => {
			expect(targets).toEqual([target]);
			return {
				complete: true,
				claims: (async function* () {
					for (let i = 0; i < 4000; i++) {
						yield {
							kind: "narrator" as const,
							id: `historical-${i}`,
							path: `/unrelated/workspace-${i}`,
						};
					}
				})(),
			};
		};
		expect((await createLifecycleGuard(ports).inspect([target], "remove")).status).toBe("clear");
	});

	test("a streamed read error cannot become missing-reference evidence", async () => {
		const { ports } = fixture();
		ports.readClaims = async () => ({
			complete: true,
			claims: (async function* () {
				yield { kind: "narrator" as const, id: "other", path: "/unrelated" };
				throw new Error("source changed during inspection");
			})(),
		});
		expect(await createLifecycleGuard(ports).inspect([target], "remove")).toMatchObject({
			status: "unavailable",
			complete: false,
		});
	});

	test("one independent reference refuses without collecting all resource users", async () => {
		const { ports } = fixture();
		let reads = 0;
		ports.readClaims = async () => ({
			complete: true,
			claims: (async function* () {
				reads++;
				yield { kind: "registry" as const, id: "owner", path: target.path };
				reads++;
				throw new Error("must not need the rest of the owner list");
			})(),
		});
		expect((await createLifecycleGuard(ports).inspect([target], "remove")).status).toBe(
			"protected",
		);
		expect(reads).toBe(1);
	});

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
	test("repo-root cwd does not own a distinct linked child worktree", async () => {
		const { ports } = fixture([{ kind: "narrator", id: "root-session", path: "/real" }]);
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
	test("dot-prefixed children remain contained for both retirement and in-flight admission", async () => {
		const { ports, guard } = fixture();
		const child = { path: `${target.path}/..cache/nested` };
		const sink = mock(async () => undefined);
		await withLifecycleGuardPorts(ports, async () => {
			await guard.withProtectionReservation([target], "retire parent", async () => {
				await expect(withWorkspaceAdmission(child, sink)).rejects.toBeInstanceOf(
					ResourceProtectionError,
				);
				await withWorkspaceAdmission({ path: "/real/sibling" }, async () => undefined);
			});
			await withWorkspaceAdmission(child, async () => {
				await expect(
					guard.withProtectionReservation([target], "retire parent", sink),
				).rejects.toBeInstanceOf(ResourceProtectionError);
			});
		});
		expect(sink).not.toHaveBeenCalled();
	});
	test("retiring a child checkout permits a new parent cwd but still rejects exact or nested references", async () => {
		const { ports, guard } = fixture();
		await withLifecycleGuardPorts(ports, () =>
			guard.withProtectionReservation([target], "retire child", async () => {
				expect(() => assertWorkspaceAdmission({ path: "/real" })).not.toThrow();
				await withWorkspaceAdmission(
					{ path: "/real", scopeProjectId: "other-project" },
					async () => undefined,
				);
				for (const path of [target.path, `${target.path}/nested`, "/alias/worktree"]) {
					await expect(
						withWorkspaceAdmission({ path }, async () => undefined),
					).rejects.toBeInstanceOf(ResourceProtectionError);
				}
			}),
		);
	});
	test("an in-flight parent cwd admission does not own every child checkout", async () => {
		const { ports, guard } = fixture();
		await withLifecycleGuardPorts(ports, () =>
			withWorkspaceAdmission({ path: "/real" }, async () => {
				expect(
					await guard.withProtectionReservation(
						[target],
						"retire linked child",
						async () => "removed",
					),
				).toBe("removed");
			}),
		);
	});
	for (const [first, second] of [
		["/real", "/real/worktree"],
		["/real/worktree", "/real"],
	]) {
		test(`deletion versus deletion stays symmetric: ${first} then ${second}`, async () => {
			const { guard } = fixture();
			const entered = latch();
			const finish = latch();
			const deletion = guard.withProtectionReservation(
				[{ path: first }],
				"first deletion",
				async () => {
					entered.release();
					await finish.promise;
				},
			);
			await entered.promise;
			try {
				await expect(
					guard.withProtectionReservation(
						[{ path: second }],
						"independent deletion",
						async () => undefined,
					),
				).rejects.toBeInstanceOf(ResourceProtectionError);
			} finally {
				finish.release();
				await deletion;
			}
		});
	}
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
	test("private canonicalization permits admissions; a new same-target durable claim stops deletion", async () => {
		let release!: () => void;
		let enter!: () => void;
		const waiting = new Promise<void>((resolve) => {
			release = resolve;
		});
		const entered = new Promise<void>((resolve) => {
			enter = resolve;
		});
		const claims: ResourceClaim[] = [];
		const { ports } = fixture(claims);
		ports.canonicalPath = async (path) => {
			enter();
			await waiting;
			return path;
		};
		const guard = createLifecycleGuard(ports);
		const destroy = mock(async () => undefined);
		const retirement = guard.withProtectionReservation([target], "retire", destroy);
		await entered;
		try {
			for (const admission of [
				target,
				{ path: "/unrelated" },
				{
					deviceId: "remote",
					path: "/remote/worktree",
				},
			])
				expect(() => assertWorkspaceAdmission(admission)).not.toThrow();
			await withWorkspaceAdmission(
				{ deviceId: "remote", path: "/remote/worktree" },
				async () => undefined,
			);
			claims.push({ kind: "registry", id: "committed-during-resolution", ...target });
		} finally {
			release();
		}
		await expect(retirement).rejects.toBeInstanceOf(ResourceProtectionError);
		expect(destroy).toHaveBeenCalledTimes(0);
		expect(() => assertWorkspaceAdmission(target)).not.toThrow();
	});
	test("an alias admission is published canonical before its durable write", async () => {
		const { ports, guard } = fixture();
		await withLifecycleGuardPorts(ports, () =>
			withWorkspaceAdmission({ path: "/alias/worktree" }, async () => {
				await expect(
					guard.withProtectionReservation([target], "retire", async () => undefined),
				).rejects.toBeInstanceOf(ResourceProtectionError);
			}),
		);
	});
	test("two shared admissions run concurrently and do not block sibling deletion", async () => {
		const { ports, guard } = fixture();
		await withLifecycleGuardPorts(ports, () =>
			withWorkspaceAdmission(target, () =>
				withWorkspaceAdmission({ path: "/alias/worktree" }, async () => {
					expect(
						await guard.withProtectionReservation(
							[{ path: "/real/sibling" }],
							"sibling delete",
							async () => "removed",
						),
					).toBe("removed");
				}),
			),
		);
	});
});
