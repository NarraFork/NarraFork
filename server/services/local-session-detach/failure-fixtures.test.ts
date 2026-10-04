import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { ordinaryDetachFixture } from "../../../tests/fixtures/local-session-detach";
import {
	boundedSnapshot,
	digest,
	FIXTURE_DETACH_LIMITS,
	type FixtureEffectContext,
	type FixtureEffectStage,
	type FixturePorts,
	type FixturePreparationContext,
	type FixtureReservation,
	type NormalizedSnapshot,
	snapshotDigest,
} from "./contract";
import { applyFixtureDetach } from "./executor";
import { detachedImage, planFixtureDetach } from "./planner";
import { type FixtureToken, IsolatedFixtureDetachStore } from "./store";

const stores: IsolatedFixtureDetachStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
});
function harness(initial = ordinaryDetachFixture()) {
	const store = new IsolatedFixtureDetachStore(initial);
	stores.push(store);
	const calls: string[] = [];
	let held = false;
	let admitted = false;
	let retained = false;
	let assertion = 0;
	let failAssertion = 0;
	let reserveHook: (() => void) | undefined;
	let admissionHook: (() => void) | undefined;
	let installHook: (() => void) | undefined;
	let verifyHook: (() => void) | undefined;
	let publishHook: (() => void) | undefined;
	const ports: FixturePorts = {
		fixtureAuthority: store.fixtureAuthority,
		async reserve(scope) {
			store.assertFixtureWorkAllowed();
			expect(scope.fixtureAuthority).toBe(store.fixtureAuthority);
			calls.push("reserve");
			reserveHook?.();
			held = true;
			return {
				fixtureAuthority: store.fixtureAuthority,
				id: "fixture:reservation",
				owned: () => held,
				release() {
					calls.push("release");
					held = false;
				},
				retainProtection() {
					calls.push("retain");
					retained = true;
				},
			};
		},
		async withAdmission(_scope, body) {
			store.assertFixtureWorkAllowed();
			calls.push("admit");
			admitted = true;
			try {
				admissionHook?.();
				return await body();
			} finally {
				admitted = false;
			}
		},
		assertAdmission() {
			assertion++;
			if (!admitted || !held || assertion === failAssertion) throw new Error("ADMISSION_DENIED");
		},
		async installRuntime() {
			calls.push("install");
			installHook?.();
		},
		async verifyRuntime() {
			calls.push("verify");
			verifyHook?.();
		},
		async publish() {
			calls.push("publish");
			publishHook?.();
		},
		pause() {
			calls.push("pause");
		},
	};
	const token = store.prepare(initial.authority.actorId, 1000);
	const apply = (
		options: {
			token?: FixtureToken;
			actorId?: `fixture:${string}`;
			signal?: AbortSignal;
			now?: () => number;
			ports?: FixturePorts;
			effectMilliseconds?: number;
			preparationMilliseconds?: number;
		} = {},
	) =>
		applyFixtureDetach({
			store,
			ports,
			token,
			actorId: initial.authority.actorId,
			now: () => 1001,
			...options,
		});
	return {
		store,
		token,
		ports,
		calls,
		apply,
		protection: () => held && retained,
		assertionCount: () => assertion,
		failAssertion: (n: number) => {
			failAssertion = n;
		},
		loseReservation: () => {
			held = false;
		},
		onReserve: (f: () => void) => {
			reserveHook = f;
		},
		onAdmission: (f: () => void) => {
			admissionHook = f;
		},
		onInstall: (f: () => void) => {
			installHook = f;
		},
		onVerify: (f: () => void) => {
			verifyHook = f;
		},
		onPublish: (f: () => void) => {
			publishHook = f;
		},
	};
}
function expectRestored(before: NormalizedSnapshot, current: NormalizedSnapshot) {
	const expected = structuredClone(before);
	expected.narrator.workspaceRevision += 2;
	const context = JSON.parse(expected.narrator.workspaceContext);
	context.revision = expected.narrator.workspaceRevision;
	expected.narrator.workspaceContext = JSON.stringify(context);
	expect(current).toEqual(expected);
}

describe("isolated fixture detach executor", () => {
	test("single ordinary fixture commits only planned fields; IDs, ACL, bytes, lazy refs stay exact", async () => {
		const before = ordinaryDetachFixture();
		const h = harness(before);
		expect(await h.apply()).toEqual({
			status: "committed",
			protectionRetained: false,
			rollbackScope: "none",
		});
		const after = h.store.read();
		expect(after).toEqual(detachedImage(before));
		expect(after.narrator.chapterId).toBeNull();
		expect(after.narrator.contextProjectId).toBe(before.chapter.projectId);
		expect(after.narrator.defaultDeviceId).toBeNull();
		expect(after.narrator.workspaceRevision).toBe(5);
		expect(JSON.parse(after.narrator.workspaceContext).contextKey).toBe("fixture:context");
		expect(after.closure).toEqual(before.closure);
		expect(after.acl).toEqual(before.acl);
		expect(after.beforeRows).toEqual(before.beforeRows);
		expect(after.chapter).toEqual(before.chapter);
		expect(h.calls).toEqual(["reserve", "admit", "install", "verify", "publish", "release"]);
	});
	test("dry run has no effect ports, token, tree capture, ref repair or session start", () => {
		const before = ordinaryDetachFixture();
		const bytes = boundedSnapshot(before);
		const plan = planFixtureDetach(before);
		expect(plan.ready).toBe(true);
		expect(plan.effects).toBe("none");
		expect(plan).not.toHaveProperty("token");
		expect(boundedSnapshot(before)).toBe(bytes);
	});
	test("pre-existing resource row is preserved exactly", async () => {
		const before = ordinaryDetachFixture();
		before.resource.row = detachedImage(before).resource.row;
		if (before.resource.row) before.resource.row.rawExtra = '{ "untouched": true }';
		const h = harness(before);
		expect((await h.apply()).status).toBe("committed");
		expect(h.store.read().resource.row).toEqual(before.resource.row);
	});

	test("chapter project is verified even when legacy narrator project context is null", async () => {
		const before = ordinaryDetachFixture();
		before.narrator.contextProjectId = null;
		const h = harness(before);
		expect((await h.apply()).status).toBe("committed");
		expect(h.store.read().narrator.contextProjectId).toBe(before.chapter.projectId);
	});
	test("ordinary primary on a trunk retains original traits and parent identity", async () => {
		const before = ordinaryDetachFixture();
		before.chapter.role = "trunk";
		const h = harness(before);
		expect((await h.apply()).status).toBe("committed");
		expect(h.store.read().narrator.traits).toBe(before.narrator.traits);
		expect(h.store.read().narrator.parentNarratorId).toBe(before.narrator.parentNarratorId);
	});
	const blockedCases: Array<[string, (s: NormalizedSnapshot) => void]> = [
		[
			"narrator readonly mode",
			(s) => {
				s.narrator.permissionMode = "readOnly";
			},
		],
		[
			"narrator readonly field",
			(s) => {
				s.narrator.readOnly = true;
			},
		],
		[
			"narrator background",
			(s) => {
				s.narrator.isBackground = true;
			},
		],
		[
			"narrator ask in passing",
			(s) => {
				s.narrator.isAskInPassing = true;
			},
		],
		[
			"narrator background trait",
			(s) => {
				s.narrator.traits = '["background"]';
			},
		],
		[
			"narrator nonprimary variant",
			(s) => {
				s.narrator.variant = "subagent:review";
			},
		],
		[
			"narrator missing owner",
			(s) => {
				s.narrator.ownerUserId = null;
			},
		],
		[
			"narrator persisted working",
			(s) => {
				s.narrator.status = "working";
			},
		],
		[
			"narrator OAuth shadow",
			(s) => {
				s.narrator.oauthOwnerGrantId = "fixture:grant";
			},
		],
		[
			"permission root mismatch",
			(s) => {
				s.acl.permissionLineage[0].rootId = "fixture:other-root";
			},
		],
		[
			"shared owner",
			(s) => {
				s.acl.shared = true;
			},
		],
		[
			"unknown owner",
			(s) => {
				s.acl.ownerNarratorIds = [];
			},
		],
		[
			"multiple owners",
			(s) => {
				s.acl.ownerNarratorIds.push("fixture:other");
			},
		],
		[
			"deleted owner",
			(s) => {
				s.acl.ownerExists = false;
			},
		],
		[
			"remote",
			(s) => {
				s.identity.local = false;
			},
		],
		[
			"dormant",
			(s) => {
				s.chapter.state = "dormant";
			},
		],
		[
			"merged",
			(s) => {
				s.chapter.state = "merged";
			},
		],
		[
			"review",
			(s) => {
				s.chapter.role = "review";
			},
		],
		[
			"read only",
			(s) => {
				s.acl.readOnly = true;
			},
		],
		[
			"missing deny rules",
			(s) => {
				s.acl.denyRulesKnown = false;
			},
		],
		[
			"missing permission lineage",
			(s) => {
				s.acl.permissionLineage = [];
			},
		],
		[
			"oauth source",
			(s) => {
				s.acl.source = "oauth";
			},
		],
		[
			"unknown source",
			(s) => {
				s.acl.source = "unknown";
			},
		],
		[
			"cross project",
			(s) => {
				s.narrator.contextProjectId = "fixture:other";
			},
		],
		[
			"tree cross cwd",
			(s) => {
				s.identity.treeBoundaryPath = "fixture:other";
			},
		],
		[
			"historical paths unknown",
			(s) => {
				s.closure.historicalPathsKnown = false;
			},
		],
		[
			"missing closure",
			(s) => {
				s.closure.complete = false;
			},
		],
		[
			"missing ref",
			(s) => {
				s.closure.objects = s.closure.objects.filter((o) => o.kind !== "ref");
			},
		],
		[
			"missing object",
			(s) => {
				s.closure.objects[0].available = false;
			},
		],
		[
			"corrupt bytes",
			(s) => {
				s.closure.objects[0].rawBase64 = "YQ==";
			},
		],
		[
			"missing collection",
			(s) => {
				s.collection.complete = false;
			},
		],
		[
			"truncated",
			(s) => {
				s.collection.truncated = true;
			},
		],
		[
			"historical snapshot",
			(s) => {
				s.collection.currentSnapshot = false;
			},
		],
		[
			"resource evidence absent",
			(s) => {
				s.resource.evidenceComplete = false;
			},
		],
		[
			"unknown registry",
			(s) => {
				s.resource.row = { state: "unknown" };
			},
		],
		[
			"non-idle queue",
			(s) => {
				s.runtime.queues = ["fixture:queue"];
			},
		],
		[
			"child running",
			(s) => {
				s.runtime.activeChildren = ["fixture:child"];
			},
		],
		[
			"waiting permission",
			(s) => {
				s.runtime.waitingPermissions = ["fixture:permission"];
			},
		],
		[
			"leased runtime",
			(s) => {
				s.runtime.leases = ["fixture:lease"];
			},
		],
		[
			"quarantined",
			(s) => {
				s.runtime.quarantined = true;
			},
		],
		[
			"unknown observations",
			(s) => {
				s.runtime.observationsComplete = false;
			},
		],
		[
			"device mismatch",
			(s) => {
				s.narrator.defaultDeviceId = "fixture:other-device";
			},
		],
		[
			"repository mismatch",
			(s) => {
				s.identity.cwdRepositoryKey = "fixture:other-repo";
			},
		],
		[
			"shadow mismatch",
			(s) => {
				s.chapter.snapshotShadowKey = "fixture:other-shadow";
			},
		],
	];
	for (const kind of ["terminal", "container", "port", "volume"] as const) {
		blockedCases.push([
			`${kind} dependency`,
			(s) => {
				s.resource.dependencies.push({ id: "fixture:dependency", kind });
			},
		]);
	}
	for (const [label, mutate] of blockedCases)
		test(`blocks ${label} without mutation`, () => {
			const before = ordinaryDetachFixture();
			mutate(before);
			const bytes = boundedSnapshot(before);
			expect(planFixtureDetach(before).ready).toBe(false);
			expect(boundedSnapshot(before)).toBe(bytes);
		});

	const staleCases: Array<[string, (s: NormalizedSnapshot) => void]> = [
		[
			"ACL revoked",
			(s) => {
				s.authority.canDetach = false;
			},
		],
		[
			"admin downgraded",
			(s) => {
				s.authority.admin = false;
				s.authority.revision++;
			},
		],
		[
			"owner deleted",
			(s) => {
				s.acl.ownerExists = false;
			},
		],
		[
			"directory inode changed",
			(s) => {
				s.identity.directoryIdentity = "fixture:inode-2";
			},
		],
		[
			"symlink changed",
			(s) => {
				s.identity.symlinkIdentity = "fixture:symlink-2";
			},
		],
		[
			"late queue",
			(s) => {
				s.runtime.queues.push("fixture:late-queue");
			},
		],
		[
			"late child",
			(s) => {
				s.runtime.activeChildren.push("fixture:child");
			},
		],
		[
			"late lease version",
			(s) => {
				s.runtime.leaseVersion++;
			},
		],
		[
			"owner epoch",
			(s) => {
				s.runtime.ownerEpoch++;
			},
		],
		[
			"runtime generation",
			(s) => {
				s.runtime.generation++;
			},
		],
		[
			"runtime fence",
			(s) => {
				s.runtime.fence++;
			},
		],
		[
			"message version",
			(s) => {
				s.narrator.messageVersion++;
			},
		],
		[
			"structure version",
			(s) => {
				s.narrator.messageStructureVersion++;
			},
		],
		[
			"business field",
			(s) => {
				s.narrator.title = "concurrent writer";
			},
		],
	];
	for (const [label, mutate] of staleCases)
		test(`re-reads ${label} with valid signature`, async () => {
			const initial = ordinaryDetachFixture();
			initial.authority.admin = true;
			const h = harness(initial);
			h.onReserve(() => h.store.mutateFixture(mutate));
			expect((await h.apply()).status).toBe("rejected");
			expect(h.store.read().narrator.chapterId).toBe(initial.chapter.id);
			expect(h.calls).not.toContain("install");
		});

	for (const label of [
		"signature",
		"actor",
		"namespace",
		"instance",
		"expiry",
		"backup digest",
	] as const) {
		test(`rejects token ${label}`, async () => {
			const h = harness();
			const token = { ...h.token };
			if (label === "signature") token.signature = "00".repeat(32);
			if (label === "namespace") token.namespace = "fixture:other";
			if (label === "instance") token.instance = "fixture:other";
			if (label === "backup digest") token.backupDigest = "bad";
			const before = snapshotDigest(h.store.read());
			const result = await h.apply({
				token,
				actorId: label === "actor" ? "fixture:attacker" : "fixture:user",
				now: () => (label === "expiry" ? token.expiresAt : 1001),
			});
			expect(result.status).toBe("rejected");
			expect(snapshotDigest(h.store.read())).toBe(before);
			expect(h.calls).toEqual([]);
		});
	}
	test("replayed consumed token cannot write", async () => {
		const h = harness();
		expect((await h.apply()).status).toBe("committed");
		const after = snapshotDigest(h.store.read());
		h.calls.splice(0);
		expect((await h.apply()).reason).toBe("TOKEN_REPLAYED");
		expect(snapshotDigest(h.store.read())).toBe(after);
		expect(h.calls).toEqual([]);
	});
	test("cross-store identical snapshot still has different signing key", async () => {
		const h = harness();
		const other = harness();
		expect((await other.apply({ token: h.token })).reason).toBe("TOKEN_SIGNATURE");
		expect(other.calls).toEqual([]);
	});
	test("missing whole beforeimage blocks writes", async () => {
		const h = harness();
		h.store.removeFixtureBackup(h.token.backupId);
		expect((await h.apply()).reason).toBe("BACKUP_INCOMPLETE");
		expect(h.calls).toEqual([]);
	});
	test("no implicit production adapter, even matching namespace DTO", async () => {
		const h = harness();
		const ports = { ...h.ports, fixtureAuthority: { ...h.store.fixtureAuthority } };
		expect((await h.apply({ ports })).reason).toBe("FIXTURE_AUTHORITY_REQUIRED");
		expect(h.calls).toEqual([]);
	});
	test("real narrator ID cannot be fixture alias or physical path", () => {
		const fixture = ordinaryDetachFixture();
		fixture.narrator.id = "real-narrator-id" as never;
		expect(() => new IsolatedFixtureDetachStore(fixture)).toThrow("FIXTURE_ID_REQUIRED");
		fixture.narrator.id = "fixture:narrator";
		fixture.identity.path = "/home/user/real" as never;
		expect(planFixtureDetach(fixture).ready).toBe(false);
	});
	test("reservation failure is nochange", async () => {
		const h = harness();
		h.onReserve(() => {
			throw new Error("RESERVATION_FAILED");
		});
		expect((await h.apply()).reason).toBe("RESERVATION_FAILED");
		expect(h.store.read()).toEqual(ordinaryDetachFixture());
	});
	test("late change immediately before SQL is rejected by full-state CAS", async () => {
		const h = harness();
		h.onAdmission(() =>
			h.store.mutateFixture((s) => {
				s.narrator.unplanned = "late";
			}),
		);
		expect((await h.apply()).status).toBe("rejected");
		expect(h.store.read().narrator.unplanned).toBe("late");
		expect(h.store.read().resource.row).toBeNull();
	});
	test("SQLite CAS write failure is atomic and does not consume token", async () => {
		const h = harness();
		h.store.setFixtureWriteFailure(true);
		expect((await h.apply()).reason).toBe("CAS_FAILED");
		expect(h.store.read()).toEqual(ordinaryDetachFixture());
		h.store.setFixtureWriteFailure(false);
		expect((await h.apply()).status).toBe("committed");
	});
	test("store rejects an unplanned afterimage even with a valid fixture token", () => {
		const h = harness();
		const after = detachedImage(h.store.read());
		after.narrator.title = "unplanned";
		expect(() => h.store.commit(h.token, "fixture:user", after, () => {}, 1001)).toThrow(
			"UNPLANNED_AFTERIMAGE",
		);
		expect(h.store.read()).toEqual(ordinaryDetachFixture());
	});
	test("forged beforeimage cannot enter whole-image compensation", () => {
		const h = harness();
		const backup = h.store.validate(h.token, "fixture:user", 1001);
		backup.id = "fixture:forged";
		expect(() => h.store.compensate(backup, detachedImage(backup.before), () => {})).toThrow(
			"BACKUP_INCOMPLETE",
		);
		expect(h.store.read()).toEqual(ordinaryDetachFixture());
	});
	test("oversized token and invalid clock fail before reservation", async () => {
		const h = harness();
		const token = { ...h.token, nonce: "x".repeat(4097) };
		expect((await h.apply({ token })).reason).toBe("TOKEN_BUDGET");
		expect((await h.apply({ now: () => Number.NaN })).reason).toBe("FIXTURE_CLOCK_INVALID");
		expect(h.calls).toEqual([]);
	});
	test("failed pause cannot be reported as safely compensated", async () => {
		const h = harness();
		h.onInstall(() => {
			throw new Error("install-failed");
		});
		const ports = {
			...h.ports,
			pause: () => {
				throw new Error("pause-failed");
			},
		};
		const result = await h.apply({ ports });
		expect(result.status).toBe("recovery-required");
		expect(result.reason).toBe("PROTECTION_UNCERTAIN");
		expect(result.rollbackScope).toBe("database-only");
		expectRestored(ordinaryDetachFixture(), h.store.read());
		expect(h.calls).not.toContain("release");
	});
	test("transaction fault after SQL update atomically restores image and token", async () => {
		const h = harness();
		h.failAssertion(3);
		expect((await h.apply()).status).toBe("rejected");
		expect(h.store.read()).toEqual(ordinaryDetachFixture());
		h.failAssertion(0);
		expect((await h.apply()).status).toBe("committed");
	});
	for (const stage of ["install", "verify", "publish"] as const) {
		test(`${stage} failure restores whole database image; revisions remain monotone`, async () => {
			const before = ordinaryDetachFixture();
			const h = harness(before);
			const hook = () => {
				throw new Error(`${stage}-failed`);
			};
			if (stage === "install") h.onInstall(hook);
			if (stage === "verify") h.onVerify(hook);
			if (stage === "publish") h.onPublish(hook);
			const result = await h.apply();
			expect(result.status).toBe("compensated");
			expect(result.rollbackScope).toBe("database-only");
			expectRestored(before, h.store.read());
			expect(h.store.read().resource.row).toBeNull();
			expect(h.protection()).toBe(true);
			expect(h.calls).not.toContain("release");
		});
	}
	test("compensation never deletes a resource which existed before", async () => {
		const before = ordinaryDetachFixture();
		before.resource.row = detachedImage(before).resource.row;
		const h = harness(before);
		h.onPublish(() => {
			throw new Error("publish-failed");
		});
		expect((await h.apply()).status).toBe("compensated");
		expectRestored(before, h.store.read());
	});
	test("later business edit cannot be overwritten during compensation", async () => {
		const h = harness();
		h.onInstall(() => {
			h.store.mutateFixture((s) => {
				s.narrator.title = "new editor value";
			});
			throw new Error("install-failed");
		});
		expect((await h.apply()).status).toBe("recovery-required");
		expect(h.store.read().narrator.title).toBe("new editor value");
		expect(h.store.read().narrator.chapterId).toBeNull();
		expect(h.protection()).toBe(true);
		expect(h.calls).not.toContain("release");
	});
	test("lost reservation prevents compensation and pauses without mutating the lost receipt", async () => {
		const h = harness();
		h.onInstall(() => {
			h.loseReservation();
			throw new Error("install-failed");
		});
		const result = await h.apply();
		expect(result.status).toBe("recovery-required");
		expect(result.cleanupObservation).toEqual({ retain: "not-owned", pause: "completed" });
		expect(h.store.read().narrator.chapterId).toBeNull();
		expect(h.calls).not.toContain("retain");
		expect(h.calls).toContain("pause");
		expect(h.calls).not.toContain("release");
	});
	for (const stage of ["before", "reserve", "admission", "install", "verify", "publish"] as const) {
		test(`abort at ${stage}`, async () => {
			const h = harness();
			const controller = new AbortController();
			const abort = () => controller.abort();
			if (stage === "before") abort();
			if (stage === "reserve") h.onReserve(abort);
			if (stage === "admission") h.onAdmission(abort);
			if (stage === "install") h.onInstall(abort);
			if (stage === "verify") h.onVerify(abort);
			if (stage === "publish") h.onPublish(abort);
			const result = await h.apply({ signal: controller.signal });
			if (stage === "before") {
				expect(result.status).toBe("rejected");
				expect(h.store.read()).toEqual(ordinaryDetachFixture());
			} else if (stage === "reserve" || stage === "admission") {
				expect(result.status).toBe("recovery-required");
				expect(result.reason).toBe(`PREPARATION_ABORTED:${stage}`);
				expect(result.uncertainPreparation).toEqual({ stage, casCommitted: false });
				expect(h.store.read()).toEqual(ordinaryDetachFixture());
				expect(h.calls).not.toContain("install");
			} else {
				// Cancellation during an invoked effect is uncertain even if this test port returns soon.
				expect(result.status).toBe("recovery-required");
				expect(result.reason).toBe(`EFFECT_ABORTED:${stage}`);
				expect(result.rollbackScope).toBe("none");
				expect(h.store.read()).toEqual(detachedImage(ordinaryDetachFixture()));
				expect(h.protection()).toBe(true);
				expect(h.calls).not.toContain("release");
			}
		});
	}
});

describe("required snapshot evidence", () => {
	const identityKeys = [
		"deviceId",
		"path",
		"cwd",
		"worktree",
		"repositoryKey",
		"cwdRepositoryKey",
		"directoryIdentity",
		"symlinkIdentity",
		"shadowKey",
		"treeBoundaryPath",
		"local",
		"known",
	];
	const authorityKeys = [
		"actorId",
		"exists",
		"canDetach",
		"admin",
		"revision",
		"policyFingerprint",
	];
	const runtimeKeys = [
		"ownerEpoch",
		"generation",
		"fence",
		"leaseVersion",
		"leaseId",
		"leases",
		"quarantined",
		"paused",
		"state",
		"queues",
		"activeChildren",
		"waitingPermissions",
		"observationsComplete",
	];
	for (const [section, keys] of [
		["identity", identityKeys],
		["authority", authorityKeys],
		["runtime", runtimeKeys],
	] as const) {
		for (const key of keys)
			test(`missing ${section}.${key} blocks dry run and token preparation`, () => {
				const s = ordinaryDetachFixture();
				Reflect.deleteProperty(s[section], key);
				expect(planFixtureDetach(s).ready).toBe(false);
				expect(() => new IsolatedFixtureDetachStore(s).prepare("fixture:user", 1000)).toThrow(
					"SNAPSHOT_REQUIRED_FIELD",
				);
			});
	}
	for (const key of identityKeys.filter((key) => !["local", "known"].includes(key))) {
		for (const value of ["", null, 0])
			test(`invalid required identity.${key} (${String(value)}) cannot mint`, () => {
				const s = ordinaryDetachFixture();
				Reflect.set(s.identity, key, value);
				expect(planFixtureDetach(s).ready).toBe(false);
				expect(() => new IsolatedFixtureDetachStore(s).prepare("fixture:user", 1000)).toThrow();
			});
	}
	for (const value of ["", " ", "not-a-fingerprint", null, 1])
		test(`invalid policy fingerprint (${String(value)}) blocks`, () => {
			const s = ordinaryDetachFixture();
			Reflect.set(s.authority, "policyFingerprint", value);
			expect(planFixtureDetach(s).ready).toBe(false);
			expect(() => new IsolatedFixtureDetachStore(s).prepare("fixture:user", 1000)).toThrow(
				"SNAPSHOT_FINGERPRINT_REQUIRED",
			);
		});
	test("declared nullable evidence must exist; omission is never proof of null", () => {
		for (const [section, key] of [
			["narrator", "contextProjectId"],
			["narrator", "defaultDeviceId"],
			["runtime", "leaseId"],
			["resource", "row"],
		] as const) {
			const s = ordinaryDetachFixture();
			Reflect.deleteProperty(s[section], key);
			expect(planFixtureDetach(s).ready).toBe(false);
			expect(() => new IsolatedFixtureDetachStore(s)).toThrow("SNAPSHOT_REQUIRED_FIELD");
		}
	});
	test("explicit legal nulls and complete canonical evidence remain ready", () => {
		const s = ordinaryDetachFixture();
		s.narrator.contextProjectId = null;
		expect(planFixtureDetach(s).ready).toBe(true);
		const store = new IsolatedFixtureDetachStore(s);
		stores.push(store);
		expect(store.prepare("fixture:user", 1000).kind).toBe("fixture-detach-token");
	});
	test("blank schema or missing closure row presence cannot be complete", () => {
		const s = ordinaryDetachFixture();
		s.schema = " ";
		expect(planFixtureDetach(s).ready).toBe(false);
		s.schema = "fixture-schema";
		Reflect.deleteProperty(s.beforeRows[1], "row");
		expect(() => new IsolatedFixtureDetachStore(s)).toThrow("SNAPSHOT_REQUIRED_FIELD");
	});
});

function deferredEffect() {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}
function pendingFixtureEffect(h: ReturnType<typeof harness>, stage: FixtureEffectStage) {
	const entered = deferredEffect();
	const completion = deferredEffect();
	let context: FixtureEffectContext | undefined;
	const ports: FixturePorts = { ...h.ports };
	const run = async (_scope: unknown, _after: unknown, effect: FixtureEffectContext) => {
		h.calls.push(stage);
		context = effect;
		entered.resolve();
		await completion.promise;
	};
	if (stage === "install") ports.installRuntime = run;
	if (stage === "verify") ports.verifyRuntime = run;
	if (stage === "publish") ports.publish = run;
	return { ports, entered: entered.promise, completion, context: () => context };
}

describe("bounded fixture reservation and admission", () => {
	for (const stage of ["reserve", "admission"] as const) {
		for (const stop of ["timeout", "cancel"] as const)
			test(`never-resolving ${stage} after ${stop} is finite and cannot write`, async () => {
				const h = harness();
				const entered = deferredEffect();
				const controller = new AbortController();
				let context: FixturePreparationContext | undefined;
				const ports: FixturePorts = { ...h.ports };
				if (stage === "reserve")
					ports.reserve = async (_scope, _signal, preparation) => {
						h.calls.push("reserve");
						context = preparation;
						entered.resolve();
						return await new Promise<never>(() => {});
					};
				else
					ports.withAdmission = async (_scope, _body, preparation) => {
						h.calls.push("admit");
						context = preparation;
						entered.resolve();
						return await new Promise<never>(() => {});
					};
				const applying = h.apply({ ports, signal: controller.signal, preparationMilliseconds: 30 });
				await entered.promise;
				if (stop === "cancel") controller.abort();
				const result = await applying;
				expect(result.status).toBe("recovery-required");
				expect(result.reason).toBe(
					`PREPARATION_${stop === "cancel" ? "ABORTED" : "TIMEOUT"}:${stage}`,
				);
				expect(result.uncertainPreparation).toEqual({ stage, casCommitted: false });
				expect(h.store.read()).toEqual(ordinaryDetachFixture());
				expect(context?.signal.aborted).toBe(true);
				expect(h.calls).toContain("pause");
				expect(h.calls).not.toContain("install");
				expect(h.calls).not.toContain("release");
				if (stage === "admission") expect(h.protection()).toBe(true);
			}, 1000);
	}
	for (const stop of ["timeout", "cancel"] as const)
		test(`late verified reservation after ${stop} is released without admission or SQL`, async () => {
			const h = harness();
			const entered = deferredEffect();
			const controller = new AbortController();
			let resolve!: (reservation: FixtureReservation) => void;
			let owned = false;
			let releases = 0;
			const waiting = new Promise<FixtureReservation>((done) => {
				resolve = done;
			});
			const ports: FixturePorts = {
				...h.ports,
				async reserve() {
					h.calls.push("reserve");
					entered.resolve();
					return waiting;
				},
			};
			const applying = h.apply({ ports, signal: controller.signal, preparationMilliseconds: 30 });
			await entered.promise;
			if (stop === "cancel") controller.abort();
			expect((await applying).status).toBe("recovery-required");
			owned = true;
			resolve({
				fixtureAuthority: h.store.fixtureAuthority,
				id: "fixture:late-reservation",
				owned: () => owned,
				release() {
					releases++;
					owned = false;
				},
				retainProtection() {},
			});
			await waiting;
			await Promise.resolve();
			await Promise.resolve();
			expect(releases).toBe(1);
			expect(owned).toBe(false);
			expect(h.calls).not.toContain("admit");
			expect(h.store.read()).toEqual(ordinaryDetachFixture());
			expect(h.assertionCount()).toBe(0);
			expect(h.store.validate(h.token, "fixture:user", 1001).complete).toBe(true);
		}, 1000);
	test("late foreign reservation is not released by fixture authority", async () => {
		const h = harness();
		let resolve!: (reservation: FixtureReservation) => void;
		let releases = 0;
		const waiting = new Promise<FixtureReservation>((done) => {
			resolve = done;
		});
		const ports: FixturePorts = {
			...h.ports,
			async reserve() {
				return waiting;
			},
		};
		expect((await h.apply({ ports, preparationMilliseconds: 30 })).status).toBe(
			"recovery-required",
		);
		resolve({
			fixtureAuthority: { ...h.store.fixtureAuthority },
			id: "fixture:foreign",
			owned: () => true,
			release() {
				releases++;
			},
			retainProtection() {},
		});
		await waiting;
		await Promise.resolve();
		await Promise.resolve();
		expect(releases).toBe(0);
		expect(h.calls).not.toContain("admit");
		expect(h.store.read()).toEqual(ordinaryDetachFixture());
	}, 1000);
	for (const stop of ["timeout", "cancel"] as const)
		test(`late admission body after ${stop} cannot call commit or consume token`, async () => {
			const h = harness();
			const entered = deferredEffect();
			const gate = deferredEffect();
			const controller = new AbortController();
			const commit = spyOn(h.store, "commit");
			try {
				const ports: FixturePorts = {
					...h.ports,
					async withAdmission(scope, body, preparation) {
						entered.resolve();
						await gate.promise;
						return h.ports.withAdmission(scope, body, preparation);
					},
				};
				const applying = h.apply({ ports, signal: controller.signal, preparationMilliseconds: 30 });
				await entered.promise;
				if (stop === "cancel") controller.abort();
				const result = await applying;
				expect(result.status).toBe("recovery-required");
				expect(h.protection()).toBe(true);
				expect(commit).toHaveBeenCalledTimes(0);
				gate.resolve();
				await gate.promise;
				await Promise.resolve();
				await Promise.resolve();
				await Promise.resolve();
				expect(commit).toHaveBeenCalledTimes(0);
				expect(h.assertionCount()).toBe(0);
				expect(h.store.read()).toEqual(ordinaryDetachFixture());
				expect(h.protection()).toBe(true);
				expect(h.calls).not.toContain("install");
				expect(h.calls).not.toContain("release");
				expect(h.store.validate(h.token, "fixture:user", 1001).complete).toBe(true);
			} finally {
				commit.mockRestore();
			}
		}, 1000);
	for (const stop of ["timeout", "cancel"] as const)
		test(`admission completion after committed body and ${stop} never releases protection`, async () => {
			const h = harness();
			const tailEntered = deferredEffect();
			const tail = deferredEffect();
			const controller = new AbortController();
			const ports: FixturePorts = {
				...h.ports,
				async withAdmission(scope, body, preparation) {
					const outcome = await h.ports.withAdmission(scope, body, preparation);
					tailEntered.resolve();
					await tail.promise;
					return outcome;
				},
			};
			const applying = h.apply({ ports, signal: controller.signal, preparationMilliseconds: 60 });
			await tailEntered.promise;
			expect(h.calls).not.toContain("release");
			if (stop === "cancel") controller.abort();
			const result = await applying;
			expect(result.status).toBe("recovery-required");
			expect(result.uncertainPreparation).toEqual({ stage: "admission", casCommitted: true });
			expect(h.store.read()).toEqual(detachedImage(ordinaryDetachFixture()));
			expect(h.protection()).toBe(true);
			const calls = [...h.calls];
			tail.resolve();
			await tail.promise;
			await Promise.resolve();
			await Promise.resolve();
			expect(h.calls).toEqual(calls);
			expect(h.calls.filter((call) => call === "publish")).toHaveLength(1);
			expect(h.calls).not.toContain("release");
			expect(h.protection()).toBe(true);
		}, 1000);
	test("admission return must confirm unchanged afterimage and owned reservation before release", async () => {
		const h = harness();
		const ports: FixturePorts = {
			...h.ports,
			async withAdmission(scope, body, preparation) {
				const outcome = await h.ports.withAdmission(scope, body, preparation);
				h.store.mutateFixture((s) => {
					s.narrator.title = "late admission postlude writer";
				});
				return outcome;
			},
		};
		expect((await h.apply({ ports })).reason).toBe("ADMISSION_COMPLETION_EVIDENCE_CHANGED");
		expect(h.store.read().narrator.title).toBe("late admission postlude writer");
		expect(h.store.read().narrator.chapterId).toBeNull();
		expect(h.protection()).toBe(true);
		expect(h.calls).not.toContain("release");
	});
	test("foreign reservation cannot receive cleanup release or retain callbacks", async () => {
		const h = harness();
		let releases = 0;
		let retains = 0;
		const ports: FixturePorts = {
			...h.ports,
			async reserve() {
				return {
					fixtureAuthority: { ...h.store.fixtureAuthority },
					id: "fixture:foreign",
					owned: () => true,
					release() {
						releases++;
					},
					retainProtection() {
						retains++;
					},
				};
			},
		};
		expect((await h.apply({ ports })).reason).toBe("RESERVATION_AUTHORITY");
		expect(releases).toBe(0);
		expect(retains).toBe(0);
		expect(h.store.read()).toEqual(ordinaryDetachFixture());
		expect(h.calls).toContain("pause");
	});
	test("rejected admission never releases a reservation whose ownership was lost", async () => {
		const h = harness();
		h.onAdmission(() => h.loseReservation());
		const result = await h.apply();
		expect(result.status).toBe("recovery-required");
		expect(result.reason).toBe("RESERVATION_LOST");
		expect(h.store.read()).toEqual(ordinaryDetachFixture());
		expect(h.calls).not.toContain("release");
		expect(h.calls).toContain("pause");
	});
	test("preparation limits cannot be disabled or extended by fixture request", async () => {
		for (const preparationMilliseconds of [
			0,
			-1,
			Number.NaN,
			FIXTURE_DETACH_LIMITS.preparationMilliseconds + 1,
		]) {
			const h = harness();
			expect((await h.apply({ preparationMilliseconds })).reason).toBe(
				"FIXTURE_PREPARATION_BUDGET_INVALID",
			);
			expect(h.calls).toEqual([]);
			expect(h.store.read()).toEqual(ordinaryDetachFixture());
		}
	});
});

describe("bounded uncertain fixture effects", () => {
	for (const stage of ["install", "verify", "publish"] as const) {
		test(`never-resolving ${stage} reaches finite recovery and keeps afterimage protected`, async () => {
			const h = harness();
			const pending = pendingFixtureEffect(h, stage);
			const started = performance.now();
			const result = await h.apply({ ports: pending.ports, effectMilliseconds: 30 });
			expect(performance.now() - started).toBeLessThan(500);
			expect(result.status).toBe("recovery-required");
			expect(result.reason).toBe(`EFFECT_TIMEOUT:${stage}`);
			expect(result.rollbackScope).toBe("none");
			expect(result.uncertainEffect).toEqual({
				stage,
				afterImageDigest: snapshotDigest(h.store.read()),
				reservationId: "fixture:reservation",
				leaseVersion: h.store.read().runtime.leaseVersion,
			});
			expect(h.store.read()).toEqual(detachedImage(ordinaryDetachFixture()));
			expect(pending.context()?.signal.aborted).toBe(true);
			expect(h.protection()).toBe(true);
			expect(h.calls).toContain("pause");
			expect(h.calls).not.toContain("release");
			if (stage !== "publish") expect(h.calls).not.toContain("publish");
		}, 1000);
		for (const stop of ["timeout", "cancel"] as const)
			test(`late ${stage} resolution after ${stop} never resumes publication or releases`, async () => {
				const h = harness();
				const pending = pendingFixtureEffect(h, stage);
				const controller = new AbortController();
				const applying = h.apply({
					ports: pending.ports,
					signal: controller.signal,
					effectMilliseconds: 30,
				});
				await pending.entered;
				if (stop === "cancel") controller.abort();
				const result = await applying;
				expect(result.reason).toBe(`EFFECT_${stop === "cancel" ? "ABORTED" : "TIMEOUT"}:${stage}`);
				expect(result.status).toBe("recovery-required");
				const calls = [...h.calls];
				const assertions = h.assertionCount();
				const state = snapshotDigest(h.store.read());
				pending.completion.resolve();
				await pending.completion.promise;
				await Promise.resolve();
				await Promise.resolve();
				await Promise.resolve();
				expect(h.calls).toEqual(calls);
				expect(h.assertionCount()).toBe(assertions);
				expect(snapshotDigest(h.store.read())).toBe(state);
				expect(h.protection()).toBe(true);
				expect(pending.context()?.signal.aborted).toBe(true);
				expect(h.calls).not.toContain("release");
				if (stage === "publish")
					expect(h.calls.filter((call) => call === "publish")).toHaveLength(1);
				else expect(h.calls).not.toContain("publish");
				expect((await h.apply()).reason).toBe("TOKEN_REPLAYED");
				expect(h.calls).toEqual(calls);
			}, 1000);
	}
	test("cooperative abort signal arrives even when the injected promise ignores cancellation", async () => {
		const h = harness();
		const pending = pendingFixtureEffect(h, "install");
		const controller = new AbortController();
		const applying = h.apply({
			ports: pending.ports,
			signal: controller.signal,
			effectMilliseconds: 100,
		});
		await pending.entered;
		expect(pending.context()?.signal.aborted).toBe(false);
		controller.abort();
		const result = await applying;
		expect(result.status).toBe("recovery-required");
		expect(pending.context()?.signal.aborted).toBe(true);
		expect(h.protection()).toBe(true);
		expect(h.calls).not.toContain("verify");
		expect(h.calls).not.toContain("publish");
	}, 1000);
	test("late rejecting port cannot trigger compensation or an unhandled rejection", async () => {
		const h = harness();
		const pending = pendingFixtureEffect(h, "publish");
		expect((await h.apply({ ports: pending.ports, effectMilliseconds: 30 })).status).toBe(
			"recovery-required",
		);
		const state = snapshotDigest(h.store.read());
		const calls = [...h.calls];
		pending.completion.reject(new Error("LATE_PUBLISH_FAILURE"));
		await pending.completion.promise.catch(() => {});
		await Promise.resolve();
		await Promise.resolve();
		expect(h.calls).toEqual(calls);
		expect(snapshotDigest(h.store.read())).toBe(state);
		expect(h.protection()).toBe(true);
	}, 1000);
	test("late unknown effect cannot cover later business edits with a stale compensation", async () => {
		const h = harness();
		const pending = pendingFixtureEffect(h, "install");
		expect((await h.apply({ ports: pending.ports, effectMilliseconds: 30 })).status).toBe(
			"recovery-required",
		);
		h.store.mutateFixture((s) => {
			s.narrator.title = "fixture concurrent edit after deadline";
		});
		pending.completion.resolve();
		await pending.completion.promise;
		await Promise.resolve();
		await Promise.resolve();
		expect(h.store.read().narrator.title).toBe("fixture concurrent edit after deadline");
		expect(h.store.read().narrator.workspaceRevision).toBe(5);
		expect(h.store.read().narrator.chapterId).toBeNull();
		expect(h.protection()).toBe(true);
		expect(h.calls).not.toContain("publish");
		expect(h.calls).not.toContain("release");
	}, 1000);
	test("all effect stages receive the same deadline rather than refreshing per-stage budgets", async () => {
		const h = harness();
		const contexts: FixtureEffectContext[] = [];
		const ports: FixturePorts = {
			...h.ports,
			async installRuntime(_scope, _after, context) {
				contexts.push(context);
			},
			async verifyRuntime(_scope, _after, context) {
				contexts.push(context);
			},
			async publish(_scope, _after, context) {
				contexts.push(context);
			},
		};
		expect((await h.apply({ ports, effectMilliseconds: 100 })).status).toBe("committed");
		expect(contexts.map((context) => context.stage)).toEqual(["install", "verify", "publish"]);
		expect(new Set(contexts.map((context) => context.deadlineAt)).size).toBe(1);
		expect(new Set(contexts.map((context) => context.signal)).size).toBe(1);
	});
	test("total deadline expires across individually short effect stages", async () => {
		const h = harness();
		const ports: FixturePorts = {
			...h.ports,
			async installRuntime() {
				h.calls.push("install");
				await new Promise((done) => setTimeout(done, 50));
			},
			async verifyRuntime() {
				h.calls.push("verify");
				await new Promise((done) => setTimeout(done, 50));
			},
		};
		const result = await h.apply({ ports, effectMilliseconds: 80 });
		expect(result.status).toBe("recovery-required");
		expect(result.reason).toBe("EFFECT_TIMEOUT:verify");
		expect(h.protection()).toBe(true);
		expect(h.calls).not.toContain("publish");
		expect(h.calls).not.toContain("release");
	}, 1000);
	test("resolving an awaited effect rechecks changed lease and refuses stale compensation", async () => {
		const h = harness();
		const pending = pendingFixtureEffect(h, "install");
		const applying = h.apply({ ports: pending.ports, effectMilliseconds: 100 });
		await pending.entered;
		h.store.mutateFixture((s) => {
			s.runtime.leaseVersion++;
			s.narrator.title = "new writer during awaited install";
		});
		pending.completion.resolve();
		const result = await applying;
		expect(result.status).toBe("recovery-required");
		expect(result.reason).toBe("COMPENSATION_CONFLICT");
		expect(h.store.read().runtime.leaseVersion).toBe(3);
		expect(h.store.read().narrator.title).toBe("new writer during awaited install");
		expect(h.protection()).toBe(true);
		expect(h.calls).not.toContain("publish");
		expect(h.calls).not.toContain("release");
	}, 1000);
	test("fixture callers can shorten but never extend or disable the hard effect budget", async () => {
		for (const effectMilliseconds of [
			0,
			-1,
			Number.NaN,
			FIXTURE_DETACH_LIMITS.effectMilliseconds + 1,
		]) {
			const h = harness();
			const result = await h.apply({ effectMilliseconds });
			expect(result.reason).toBe("FIXTURE_EFFECT_BUDGET_INVALID");
			expect(h.calls).toEqual([]);
			expect(h.store.read()).toEqual(ordinaryDetachFixture());
		}
	});
});

describe("review P2 fixture boundaries", () => {
	test("hidden serialization getter is rejected without being read", () => {
		const s = ordinaryDetachFixture();
		let reads = 0;
		Object.defineProperty(s.narrator, "toJSON", {
			get() {
				reads++;
				return undefined;
			},
		});
		expect(planFixtureDetach(s).ready).toBe(false);
		expect(reads).toBe(0);
	});
	test("admission rejecting while install is pending permanently closes the owned body", async () => {
		const h = harness();
		const pending = pendingFixtureEffect(h, "install");
		let bodyCompletion: Promise<unknown> | undefined;
		pending.ports.withAdmission = async (scope, body, preparation) => {
			bodyCompletion = h.ports.withAdmission(scope, body, preparation);
			throw new Error("EARLY_ADMISSION_REJECTION");
		};
		const result = await h.apply({ ports: pending.ports });
		expect(result.status).toBe("recovery-required");
		expect(pending.context()?.signal.aborted).toBe(true);
		pending.completion.resolve();
		await bodyCompletion;
		expect(h.calls).not.toContain("verify");
		expect(h.calls).not.toContain("publish");
		expect(h.calls).not.toContain("release");
	});
	test("async never release is not reported as committed or released", async () => {
		const h = harness();
		const reserve = h.ports.reserve;
		h.ports.reserve = async (...args) => {
			const reservation = await reserve(...args);
			return {
				...reservation,
				async release() {
					h.calls.push("async-release");
					await new Promise<never>(() => {});
				},
			};
		};
		const result = await h.apply();
		expect(result.status).toBe("recovery-required");
		expect(result.protectionRetained).toBe(true);
		expect(h.protection()).toBe(true);
	});
});

describe("review P2 descriptor and canonical data coverage", () => {
	for (const target of ["snapshot", "narrator", "blob", "array"] as const)
		for (const kind of ["getter", "function"] as const)
			test(`hidden ${kind} toJSON on ${target} has zero executions at every fixture boundary`, () => {
				const s = ordinaryDetachFixture();
				const object =
					target === "snapshot"
						? s
						: target === "narrator"
							? s.narrator
							: target === "blob"
								? s.narrator.opaqueBlob
								: s.closure.objects;
				let executions = 0;
				const hook = () => {
					executions++;
					return undefined;
				};
				Object.defineProperty(
					object,
					"toJSON",
					kind === "getter" ? { get: hook } : { value: hook },
				);
				expect(planFixtureDetach(s).ready).toBe(false);
				expect(() => boundedSnapshot(s)).toThrow();
				expect(() => snapshotDigest(s)).toThrow();
				expect(() => detachedImage(s)).toThrow();
				expect(() => new IsolatedFixtureDetachStore(s)).toThrow();
				expect(executions).toBe(0);
			});
	for (const target of ["narrator", "nested"] as const)
		test(`shape-preserving ${target} custom prototype cannot run a hook`, () => {
			const s = ordinaryDetachFixture();
			let executions = 0;
			const prototype = Object.create(null);
			Object.defineProperty(prototype, "toJSON", {
				get() {
					executions++;
					return undefined;
				},
			});
			Object.setPrototypeOf(target === "narrator" ? s.narrator : s.narrator.opaqueBlob, prototype);
			expect(planFixtureDetach(s).reasons).toEqual(["SNAPSHOT_NON_JSON_VALUE"]);
			expect(executions).toBe(0);
		});
	test("symbol keys and hidden nonhook accessors are classified without executing getters", () => {
		for (const key of [Symbol("opaque"), "opaque"] as const) {
			const s = ordinaryDetachFixture();
			let reads = 0;
			Object.defineProperty(s.narrator, key, {
				get() {
					reads++;
					return "metadata";
				},
			});
			expect(planFixtureDetach(s).reasons).toEqual([
				typeof key === "symbol" ? "SNAPSHOT_NON_JSON_KEY" : "SNAPSHOT_ACCESSOR",
			]);
			expect(reads).toBe(0);
		}
	});
	test("hidden plain data stays outside canonical bytes, plan digest and persisted image", async () => {
		const before = ordinaryDetachFixture();
		const canonical = JSON.stringify(before);
		const expectedPlan = planFixtureDetach(before);
		Object.defineProperty(before.narrator, "hiddenMetadata", { value: "opaque metadata" });
		Object.setPrototypeOf(before.narrator, null);
		expect(boundedSnapshot(before)).toBe(canonical);
		expect(snapshotDigest(before)).toBe(digest(canonical));
		expect(planFixtureDetach(before)).toEqual(expectedPlan);
		const h = harness(before);
		expect(boundedSnapshot(h.store.read())).toBe(canonical);
		expect((await h.apply()).status).toBe("committed");
		expect(h.store.read().narrator.rawBusinessJson).toBe(before.narrator.rawBusinessJson);
		expect(h.store.read().narrator.opaqueBlob).toEqual({ blobBase64: "AP9h" });
		expect(digest(new Uint8Array([0, 255, 97]))).toBe(digest(Buffer.from("AP9h", "base64")));
	});
	test("nonenumerable array indices preserve original JSON bytes and holes fail closed", () => {
		const s = ordinaryDetachFixture();
		Object.defineProperty(s.closure.rootIds, "0", { enumerable: false });
		expect(boundedSnapshot(s)).toBe(JSON.stringify(s));
		delete s.closure.rootIds[0];
		expect(planFixtureDetach(s).reasons).toEqual(["SNAPSHOT_ARRAY_HOLE"]);
	});
});

describe("review P2 exceptional admission closure", () => {
	for (const completion of ["resolve", "reject"] as const)
		test(`ordinary admission rejection owns and aborts pending install, including late ${completion}`, async () => {
			const h = harness();
			const pending = pendingFixtureEffect(h, "install");
			let ownedBody: Promise<unknown> | undefined;
			pending.ports.withAdmission = async (scope, body, preparation) => {
				ownedBody = h.ports.withAdmission(scope, body, preparation);
				throw new Error("EARLY_ADMISSION_REJECTION");
			};
			const result = await h.apply({ ports: pending.ports });
			expect(result.status).toBe("recovery-required");
			expect(result.uncertainPreparation).toEqual({ stage: "admission", casCommitted: true });
			expect(result.uncertainEffect?.stage).toBe("install");
			expect(pending.context()?.signal.aborted).toBe(true);
			expect(h.protection()).toBe(true);
			await ownedBody;
			const after = snapshotDigest(h.store.read());
			const calls = [...h.calls];
			if (completion === "resolve") pending.completion.resolve();
			else pending.completion.reject(new Error("LATE_INSTALL_REJECTION"));
			await pending.completion.promise.catch(() => {});
			await Promise.resolve();
			await Promise.resolve();
			expect(h.calls).toEqual(calls);
			expect(snapshotDigest(h.store.read())).toBe(after);
			expect(h.calls).not.toContain("verify");
			expect(h.calls).not.toContain("publish");
			expect(h.calls).not.toContain("release");
			expect(h.calls.filter((call) => call === "retain")).toHaveLength(1);
			expect((await h.apply()).reason).toBe("TOKEN_REPLAYED");
		});
	test("ordinary rejection before CAS closes a started harness body and preserves unused token", async () => {
		const h = harness();
		const gate = deferredEffect();
		let ownedBody: Promise<unknown> | undefined;
		let context: FixturePreparationContext | undefined;
		const commit = spyOn(h.store, "commit");
		try {
			const ports: FixturePorts = {
				...h.ports,
				async withAdmission(scope, body, preparation) {
					context = preparation;
					ownedBody = h.ports.withAdmission(
						scope,
						async () => {
							await gate.promise;
							return body();
						},
						preparation,
					);
					throw new Error("EARLY_ADMISSION_REJECTION");
				},
			};
			const result = await h.apply({ ports });
			expect(result.status).toBe("recovery-required");
			expect(result.uncertainPreparation).toEqual({ stage: "admission", casCommitted: false });
			expect(context?.signal.aborted).toBe(true);
			expect(h.protection()).toBe(true);
			gate.resolve();
			await ownedBody;
			expect(commit).toHaveBeenCalledTimes(0);
			expect(h.assertionCount()).toBe(0);
			expect(h.store.read()).toEqual(ordinaryDetachFixture());
			expect(h.calls).not.toContain("install");
			expect(h.calls).not.toContain("publish");
			expect(h.calls).not.toContain("release");
			expect(h.store.validate(h.token, "fixture:user", 1001).complete).toBe(true);
		} finally {
			commit.mockRestore();
		}
	});
	test("admission cannot invoke the body twice to duplicate CAS or publication", async () => {
		const h = harness();
		const commit = spyOn(h.store, "commit");
		try {
			const ports: FixturePorts = {
				...h.ports,
				async withAdmission(scope, body, preparation) {
					return h.ports.withAdmission(
						scope,
						async () => {
							const outcome = await body();
							await body();
							return outcome;
						},
						preparation,
					);
				},
			};
			expect((await h.apply({ ports })).status).toBe("committed");
			expect(commit).toHaveBeenCalledTimes(1);
			expect(h.calls.filter((call) => call === "publish")).toHaveLength(1);
			expect(h.calls.filter((call) => call === "release")).toHaveLength(1);
		} finally {
			commit.mockRestore();
		}
	});
});

describe("review P2 settled body evidence", () => {
	for (const tail of ["throw", "return-second-body"] as const)
		test(`${tail} after real synchronous effect failure preserves actual database-only rollback`, async () => {
			const h = harness();
			h.onInstall(() => {
				throw new Error("INSTALL_THROW");
			});
			const ports: FixturePorts = {
				...h.ports,
				async withAdmission(scope, body, preparation) {
					return h.ports.withAdmission(
						scope,
						async () => {
							await body();
							if (tail === "throw") throw new Error("ADMISSION_TAIL_THROW");
							return body();
						},
						preparation,
					);
				},
			};
			const result = await h.apply({ ports });
			expect(result.status).toBe("recovery-required");
			expect(result.rollbackScope).toBe("database-only");
			expectRestored(ordinaryDetachFixture(), h.store.read());
			expect(h.calls.filter((call) => call === "retain")).toHaveLength(1);
			expect(h.calls).not.toContain("release");
			expect(h.calls).not.toContain("publish");
		});
});

describe("review P2 late release independent protection", () => {
	test("late owned release removes the old lease but cannot remove recovery quarantine or start future work", async () => {
		const h = harness();
		const gate = deferredEffect();
		let receipt: FixtureReservation | undefined;
		let drained = 0;
		let blockedDrain = 0;
		const reserve = h.ports.reserve;
		h.ports.reserve = async (...args) => {
			receipt = await reserve(...args);
			const ownedReceipt = receipt;
			return {
				...ownedReceipt,
				async release() {
					await gate.promise;
					ownedReceipt.release();
					try {
						h.store.assertFixtureWorkAllowed();
						drained++;
					} catch (error) {
						if (error instanceof Error && error.message === "FIXTURE_RECOVERY_QUARANTINED")
							blockedDrain++;
						else throw error;
					}
				},
			};
		};
		const result = await h.apply();
		gate.resolve();
		await gate.promise;
		await Promise.resolve();
		await Promise.resolve();
		expect(receipt?.owned()).toBe(false);
		expect(h.protection()).toBe(false);
		expect(drained).toBe(0);
		expect(blockedDrain).toBe(1);
		expect(result.status).toBe("recovery-required");
		expect(result.cleanupObservation?.retain).toBe("unknown");
		expect(result.fixtureQuarantine?.held).toBe(true);
		expect(h.store.hasFixtureRecoveryHold()).toBe(true);
		expect(() => h.store.assertFixtureWorkAllowed()).toThrow("FIXTURE_RECOVERY_QUARANTINED");
		let futureWork = 0;
		expect(() => {
			h.store.assertFixtureWorkAllowed();
			futureWork++;
		}).toThrow("FIXTURE_RECOVERY_QUARANTINED");
		expect(futureWork).toBe(0);
		const after = h.store.read();
		const scope = {
			fixtureAuthority: h.store.fixtureAuthority,
			narratorId: after.narrator.id,
			identity: after.identity,
		};
		await expect(
			h.ports.withAdmission(scope, async () => {
				futureWork++;
			}),
		).rejects.toThrow("FIXTURE_RECOVERY_QUARANTINED");
		await expect(reserve(scope)).rejects.toThrow("FIXTURE_RECOVERY_QUARANTINED");
		expect(futureWork).toBe(0);
		expect(() => h.store.prepare("fixture:user", 1001)).toThrow("FIXTURE_RECOVERY_QUARANTINED");
		expect(() => h.store.commit(h.token, "fixture:user", after, () => {}, 1001)).toThrow(
			"FIXTURE_RECOVERY_QUARANTINED",
		);
		const holdId = result.fixtureQuarantine?.holdId;
		if (!holdId) throw new Error("MISSING_QUARANTINE_PROOF");
		expect(() =>
			h.store.releaseFixtureRecoveryHold({
				kind: "fixture-store-recovery-quarantine",
				fixtureAuthority: h.store.fixtureAuthority,
				id: holdId,
			}),
		).toThrow("FIXTURE_QUARANTINE_AUTHORITY");
		expect(h.store.hasFixtureRecoveryHold()).toBe(true);
		expect(snapshotDigest(h.store.read())).toBe(snapshotDigest(after));
	});
});

describe("review P2 independent quarantine execution gates", () => {
	test("known synchronous release owns an independent gate during dispatch and clears it only after proof", async () => {
		const h = harness();
		const reserve = h.ports.reserve;
		let dispatched = 0;
		h.ports.reserve = async (...args) => {
			const receipt = await reserve(...args);
			return {
				...receipt,
				release() {
					dispatched++;
					expect(h.store.hasFixtureRecoveryHold()).toBe(true);
					expect(() => h.store.assertFixtureWorkAllowed()).toThrow("FIXTURE_RECOVERY_QUARANTINED");
					receipt.release();
				},
			};
		};
		const result = await h.apply();
		expect(result).toEqual({
			status: "committed",
			protectionRetained: false,
			rollbackScope: "none",
		});
		expect(dispatched).toBe(1);
		expect(h.store.hasFixtureRecoveryHold()).toBe(false);
		expect(() => h.store.assertFixtureWorkAllowed()).not.toThrow();
	});
	test("async release that already removed ownership still cannot remove the independent gate", async () => {
		const h = harness();
		const gate = deferredEffect();
		const reserve = h.ports.reserve;
		h.ports.reserve = async (...args) => {
			const receipt = await reserve(...args);
			return {
				...receipt,
				async release() {
					receipt.release();
					await gate.promise;
				},
			};
		};
		const result = await h.apply();
		expect(result.status).toBe("recovery-required");
		expect(result.cleanupObservation).toEqual({
			release: "unknown",
			retain: "not-owned",
			pause: "completed",
		});
		expect(h.protection()).toBe(false);
		expect(result.protectionRetained).toBe(true);
		expect(result.fixtureQuarantine?.held).toBe(true);
		gate.reject(new Error("LATE_ALREADY_RELEASED_FAILURE"));
		await gate.promise.catch(() => {});
		await Promise.resolve();
		expect(h.store.hasFixtureRecoveryHold()).toBe(true);
		expect(() => h.store.assertFixtureWorkAllowed()).toThrow("FIXTURE_RECOVERY_QUARANTINED");
		expect(h.calls.filter((call) => call === "release")).toHaveLength(1);
	});
	test("a late pre-CAS receipt release cannot lift recovery quarantine or consume its unused token", async () => {
		const h = harness();
		let arrive!: (receipt: FixtureReservation) => void;
		const pending = new Promise<FixtureReservation>((resolve) => {
			arrive = resolve;
		});
		const completion = deferredEffect();
		let owned = true;
		let retained = false;
		let releases = 0;
		const ports: FixturePorts = {
			...h.ports,
			async reserve() {
				return pending;
			},
		};
		const result = await h.apply({ ports, preparationMilliseconds: 30 });
		expect(result.status).toBe("recovery-required");
		expect(result.fixtureQuarantine?.held).toBe(true);
		arrive({
			fixtureAuthority: h.store.fixtureAuthority,
			id: "fixture:late-owned-recovery",
			owned: () => owned,
			async release() {
				releases++;
				await completion.promise;
				owned = false;
				retained = false;
			},
			retainProtection() {
				retained = true;
			},
		});
		await pending;
		await Promise.resolve();
		await Promise.resolve();
		expect(owned && retained).toBe(true);
		completion.resolve();
		await completion.promise;
		await Promise.resolve();
		expect(owned).toBe(false);
		expect(retained).toBe(false);
		expect(releases).toBe(1);
		expect(h.store.hasFixtureRecoveryHold()).toBe(true);
		expect(h.store.validate(h.token, "fixture:user", 1001).complete).toBe(true);
		const before = h.store.read();
		expect(() =>
			h.store.commit(h.token, "fixture:user", detachedImage(before), () => {}, 1001),
		).toThrow("FIXTURE_RECOVERY_QUARANTINED");
		expect(h.store.read()).toEqual(before);
		expect(h.calls).not.toContain("admit");
		expect(h.calls).not.toContain("publish");
	});
	test("a copied or foreign hold cannot clear another store's active quarantine", () => {
		const a = harness();
		const b = harness();
		const hold = a.store.acquireFixtureRecoveryHold();
		expect(() => a.store.releaseFixtureRecoveryHold({ ...hold })).toThrow(
			"FIXTURE_QUARANTINE_AUTHORITY",
		);
		expect(() => b.store.releaseFixtureRecoveryHold(hold)).toThrow("FIXTURE_QUARANTINE_AUTHORITY");
		expect(a.store.hasFixtureRecoveryHold(hold)).toBe(true);
		expect(() => a.store.assertFixtureWorkAllowed()).toThrow("FIXTURE_RECOVERY_QUARANTINED");
		expect(() => b.store.assertFixtureWorkAllowed()).not.toThrow();
		a.store.releaseFixtureRecoveryHold(hold);
		expect(() => a.store.assertFixtureWorkAllowed()).not.toThrow();
	});
});

describe("review P2 synchronous cleanup port enforcement", () => {
	for (const kind of [
		"never",
		"resolve",
		"reject",
		"throw",
		"then-getter",
		"nonundefined",
	] as const)
		test(`${kind} release cannot claim committed/released and is never retried`, async () => {
			const h = harness();
			const completion = deferredEffect();
			let reads = 0;
			const reserve = h.ports.reserve;
			h.ports.reserve = async (...args) => {
				const receipt = await reserve(...args);
				return {
					...receipt,
					release() {
						h.calls.push("cleanup-release");
						if (kind === "throw") throw new Error("RELEASE_THROW");
						if (kind === "nonundefined") return 1;
						if (kind === "then-getter")
							// biome-ignore lint/suspicious/noThenProperty: Intentional hostile thenable regression fixture.
							return Object.defineProperty({}, "then", {
								get() {
									reads++;
									throw new Error("THEN_GETTER");
								},
							});
						return (async () => {
							await completion.promise;
							if (kind === "resolve") receipt.release();
						})();
					},
				};
			};
			const started = performance.now();
			const result = await h.apply();
			expect(performance.now() - started).toBeLessThan(500);
			expect(result.status).toBe("recovery-required");
			expect(result.reason).toBe("RELEASE_UNCERTAIN");
			expect(result.protectionRetained).toBe(true);
			expect(result.cleanupObservation).toEqual({
				release: kind === "throw" ? "failed" : "unknown",
				retain: "unknown",
				pause: "completed",
			});
			expect(h.protection()).toBe(true);
			expect(reads).toBe(0);
			const state = snapshotDigest(h.store.read());
			if (kind === "resolve") completion.resolve();
			if (kind === "reject") completion.reject(new Error("LATE_RELEASE_REJECTION"));
			if (kind === "resolve" || kind === "reject") await completion.promise.catch(() => {});
			await Promise.resolve();
			await Promise.resolve();
			expect(h.calls.filter((call) => call === "cleanup-release")).toHaveLength(1);
			expect(h.calls.filter((call) => call === "publish")).toHaveLength(1);
			expect(h.calls.filter((call) => call === "release")).toHaveLength(kind === "resolve" ? 1 : 0);
			expect(h.protection()).toBe(kind !== "resolve");
			expect(h.store.hasFixtureRecoveryHold()).toBe(true);
			expect(result.fixtureQuarantine?.held).toBe(true);
			expect(() => h.store.assertFixtureWorkAllowed()).toThrow("FIXTURE_RECOVERY_QUARANTINED");
			expect(snapshotDigest(h.store.read())).toBe(state);
		});
	for (const stage of ["retain", "pause", "both"] as const)
		for (const completion of ["never", "resolve", "reject"] as const)
			test(`async ${stage} with ${completion} cannot claim safe database compensation`, async () => {
				const h = harness();
				const pending = deferredEffect();
				h.onInstall(() => {
					throw new Error("INSTALL_THROW");
				});
				const reserve = h.ports.reserve;
				if (stage !== "pause")
					h.ports.reserve = async (...args) => {
						const receipt = await reserve(...args);
						return {
							...receipt,
							async retainProtection() {
								h.calls.push("async-retain");
								await pending.promise;
							},
						};
					};
				if (stage !== "retain")
					h.ports.pause = async () => {
						h.calls.push("async-pause");
						await pending.promise;
					};
				const result = await h.apply();
				expect(result.status).toBe("recovery-required");
				expect(result.reason).toBe("PROTECTION_UNCERTAIN");
				expect(result.rollbackScope).toBe("database-only");
				expect(result.cleanupObservation).toEqual({
					retain: stage === "pause" ? "completed" : "unknown",
					pause: stage === "retain" ? "completed" : "unknown",
				});
				expectRestored(ordinaryDetachFixture(), h.store.read());
				const calls = [...h.calls];
				if (completion === "resolve") pending.resolve();
				if (completion === "reject") pending.reject(new Error("LATE_CLEANUP_REJECTION"));
				if (completion !== "never") await pending.promise.catch(() => {});
				await Promise.resolve();
				await Promise.resolve();
				expect(h.calls).toEqual(calls);
				expect(h.calls).not.toContain("publish");
				expect(h.calls).not.toContain("release");
			});
	for (const kind of ["then-getter", "throw"] as const)
		test(`${kind} retain/pause callback is recorded without assimilating a getter`, async () => {
			const h = harness();
			let reads = 0;
			const callback = () => {
				if (kind === "throw") throw new Error("CLEANUP_THROW");
				// biome-ignore lint/suspicious/noThenProperty: Intentional hostile thenable regression fixture.
				return Object.defineProperty({}, "then", {
					get() {
						reads++;
						return () => {};
					},
				});
			};
			h.onInstall(() => {
				throw new Error("INSTALL_THROW");
			});
			const reserve = h.ports.reserve;
			h.ports.reserve = async (...args) => ({
				...(await reserve(...args)),
				retainProtection: callback,
			});
			h.ports.pause = callback;
			const result = await h.apply();
			expect(result.status).toBe("recovery-required");
			expect(result.cleanupObservation).toEqual({
				retain: kind === "throw" ? "failed" : "unknown",
				pause: kind === "throw" ? "failed" : "unknown",
			});
			expectRestored(ordinaryDetachFixture(), h.store.read());
			expect(reads).toBe(0);
			expect(h.calls).not.toContain("release");
		});
	for (const mutation of ["owned-callback", "admission-tail"] as const)
		test(`${mutation} authority mutation never cleans up a foreign receipt`, async () => {
			const h = harness();
			let receipt: FixtureReservation | undefined;
			const reserve = h.ports.reserve;
			h.ports.reserve = async (...args) => {
				receipt = await reserve(...args);
				if (mutation === "owned-callback") {
					const owned = receipt.owned;
					receipt.owned = () => {
						Object.defineProperty(receipt, "fixtureAuthority", {
							value: { ...h.store.fixtureAuthority },
						});
						return owned();
					};
				}
				return receipt;
			};
			if (mutation === "admission-tail") {
				const admission = h.ports.withAdmission;
				h.ports.withAdmission = async (...args) => {
					const outcome = await admission(...args);
					Object.defineProperty(receipt, "fixtureAuthority", {
						value: { ...h.store.fixtureAuthority },
					});
					return outcome;
				};
			}
			const result = await h.apply();
			expect(result.status).toBe("recovery-required");
			expect(result.cleanupObservation?.retain).toBe("not-owned");
			expect(h.calls).not.toContain("retain");
			expect(h.calls).not.toContain("release");
			expect(h.calls).toContain("pause");
			expect(h.store.read().narrator.chapterId).toBe(
				mutation === "admission-tail" ? null : "fixture:chapter",
			);
		});
	for (const mutation of ["ownership", "authority"] as const)
		test(`compensated admission tail ${mutation} loss downgrades cached protection without repeating callbacks`, async () => {
			const h = harness();
			let receipt: FixtureReservation | undefined;
			const reserve = h.ports.reserve;
			h.ports.reserve = async (...args) => {
				receipt = await reserve(...args);
				return receipt;
			};
			h.onInstall(() => {
				throw new Error("INSTALL_THROW");
			});
			const admission = h.ports.withAdmission;
			h.ports.withAdmission = async (...args) => {
				const outcome = await admission(...args);
				if (mutation === "ownership") h.loseReservation();
				else
					Object.defineProperty(receipt, "fixtureAuthority", {
						value: { ...h.store.fixtureAuthority },
					});
				return outcome;
			};
			const result = await h.apply();
			expect(result.status).toBe("recovery-required");
			expect(result.reason).toBe("PROTECTION_UNCERTAIN");
			expect(result.rollbackScope).toBe("database-only");
			expect(result.cleanupObservation).toEqual({ retain: "not-owned", pause: "completed" });
			expectRestored(ordinaryDetachFixture(), h.store.read());
			expect(h.calls.filter((call) => call === "retain")).toHaveLength(1);
			expect(h.calls.filter((call) => call === "pause")).toHaveLength(1);
			expect(h.calls).not.toContain("release");
		});
	for (const mode of ["async-release", "owned-mutates"] as const)
		test(`late reservation ${mode} is bounded, observed and never starts admission`, async () => {
			const h = harness();
			let resolve!: (receipt: FixtureReservation) => void;
			const waiting = new Promise<FixtureReservation>((done) => {
				resolve = done;
			});
			const completion = deferredEffect();
			let releases = 0;
			let retains = 0;
			const ports: FixturePorts = {
				...h.ports,
				async reserve() {
					return waiting;
				},
			};
			const result = await h.apply({ ports, preparationMilliseconds: 30 });
			expect(result.status).toBe("recovery-required");
			const receipt: FixtureReservation = {
				fixtureAuthority: h.store.fixtureAuthority,
				id: "fixture:late-review",
				owned() {
					if (mode === "owned-mutates")
						Object.defineProperty(receipt, "fixtureAuthority", {
							value: { ...h.store.fixtureAuthority },
						});
					return true;
				},
				async release() {
					releases++;
					await completion.promise;
				},
				retainProtection() {
					retains++;
				},
			};
			resolve(receipt);
			await waiting;
			await Promise.resolve();
			await Promise.resolve();
			expect(releases).toBe(mode === "async-release" ? 1 : 0);
			expect(retains).toBe(mode === "async-release" ? 1 : 0);
			if (mode === "async-release") {
				completion.reject(new Error("LATE_RESERVATION_RELEASE_FAILURE"));
				await completion.promise.catch(() => {});
			}
			await Promise.resolve();
			expect(releases).toBe(mode === "async-release" ? 1 : 0);
			expect(h.calls.filter((call) => call === "pause")).toHaveLength(1);
			expect(h.calls).not.toContain("admit");
			expect(h.calls).not.toContain("publish");
			expect(h.store.read()).toEqual(ordinaryDetachFixture());
		});
});

describe("hard snapshot budgets", () => {
	test("truthy DTO strings cannot fake current authority", () => {
		const s = ordinaryDetachFixture();
		s.authority.admin = "true" as never;
		expect(planFixtureDetach(s).reasons).toEqual(["SNAPSHOT_BOOLEAN_REQUIRED"]);
	});
	test("unknown persisted permission mode cannot become ordinary silently", () => {
		const s = ordinaryDetachFixture();
		s.narrator.permissionMode = "plan";
		expect(planFixtureDetach(s).ready).toBe(false);
	});
	test("escaped output has an independent hard byte budget", () => {
		const s = ordinaryDetachFixture();
		s.narrator.escaped = "\u0000".repeat(90000);
		expect(planFixtureDetach(s).reasons).toEqual(["SNAPSHOT_OUTPUT_BUDGET"]);
	});
	test("time budget stops collection before serialization", () => {
		let calls = 0;
		const mock = spyOn(performance, "now").mockImplementation(() => ++calls * 1001);
		try {
			expect(planFixtureDetach(ordinaryDetachFixture()).reasons).toEqual(["SNAPSHOT_TIME_BUDGET"]);
		} finally {
			mock.mockRestore();
		}
	});
	test("accessors and exotic objects are never serialized", () => {
		const s = ordinaryDetachFixture();
		let reads = 0;
		Object.defineProperty(s.narrator, "accessor", {
			enumerable: true,
			get() {
				reads++;
				return "unsafe";
			},
		});
		expect(planFixtureDetach(s).reasons).toEqual(["SNAPSHOT_ACCESSOR"]);
		expect(reads).toBe(0);
	});
	test("raw blob cells require canonical exact bytes", () => {
		const s = ordinaryDetachFixture();
		s.narrator.opaqueBlob = { blobBase64: "not base64" };
		expect(planFixtureDetach(s).reasons).toEqual(["SNAPSHOT_BLOB_INVALID"]);
	});
	test("embedded production IDs in full rows are not accepted as fixture aliases", () => {
		const s = ordinaryDetachFixture();
		s.narrator.parentNarratorId = "actual-narrator-id";
		expect(planFixtureDetach(s).reasons).toEqual(["FIXTURE_ID_REQUIRED"]);
	});
	test("large input cannot claim complete readiness", () => {
		const s = ordinaryDetachFixture();
		s.narrator.large = "x".repeat(FIXTURE_DETACH_LIMITS.bytes + 1);
		expect(planFixtureDetach(s).ready).toBe(false);
		expect(() => new IsolatedFixtureDetachStore(s)).toThrow("SNAPSHOT_BYTE_BUDGET");
	});
	test("page budget", () => {
		const s = ordinaryDetachFixture();
		s.collection.pages = FIXTURE_DETACH_LIMITS.pages + 1;
		expect(planFixtureDetach(s).ready).toBe(false);
	});
	test("row budget", () => {
		const s = ordinaryDetachFixture();
		s.beforeRows = Array.from({ length: FIXTURE_DETACH_LIMITS.rows }, (_, i) => ({
			table: "fixture:rows",
			id: `fixture:${i}`,
			row: null,
		}));
		expect(planFixtureDetach(s).ready).toBe(false);
	});
	test("nodes and depth bounded before serialization", () => {
		const s = ordinaryDetachFixture();
		(s as unknown as Record<string, unknown>).nested = Array.from(
			{ length: FIXTURE_DETACH_LIMITS.nodes },
			() => null,
		);
		expect(planFixtureDetach(s).ready).toBe(false);
		delete (s as unknown as Record<string, unknown>).nested;
		let obj: Record<string, unknown> = {};
		(s as unknown as Record<string, unknown>).nested = obj;
		for (let i = 0; i < FIXTURE_DETACH_LIMITS.depth + 1; i++) {
			const next = {};
			obj.next = next;
			obj = next;
		}
		expect(planFixtureDetach(s).ready).toBe(false);
	});
	test("cancelled collection", () => {
		const controller = new AbortController();
		controller.abort();
		expect(planFixtureDetach(ordinaryDetachFixture(), controller.signal).reasons).toEqual([
			"ABORTED",
		]);
	});
	test("cyclic input rejected without stringify", () => {
		const s = ordinaryDetachFixture();
		(s as unknown as Record<string, unknown>).cycle = s;
		expect(planFixtureDetach(s).reasons).toEqual(["SNAPSHOT_CYCLE"]);
	});
});
