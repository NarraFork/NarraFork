import { expect, test } from "bun:test";
import { localPathSemantics } from "../lib/agent/execution/path-semantics";
import {
	createLegacyWorkspaceRollbackBridge,
	type LegacyRollbackProof,
	type LegacyRollbackWorkspace,
} from "./legacy-workspace-rollback-bridge";

function fixture() {
	const cwd = process.cwd();
	const row: LegacyRollbackWorkspace = {
		id: "n",
		cwd,
		workspaceRevision: 3,
		defaultDeviceId: "local",
		chapterId: null,
		contextProjectId: null,
		workspaceContext: {
			revision: 3,
			deviceId: "local",
			cwd,
			pathFlavor: localPathSemantics.flavor === "windows" ? "windows" : "posix",
			contextKey: "context",
			git: { workspaceKey: "workspace", repositoryKey: "repo", rootPath: cwd },
			capabilities: { switchDirectory: true },
		},
	};
	const proof: LegacyRollbackProof = {
		adoptedRevision: 3,
		deviceId: "local",
		cwd,
		contextKey: "context",
		historyDigest: "a".repeat(64),
		workspaceKey: "workspace",
		repositoryKey: "repo",
		directoryDev: "1",
		directoryIno: "2",
	};
	let calls = 0;
	const bridge = createLegacyWorkspaceRollbackBridge({
		lookup: async () => proof,
		verifyDirectory: async () => {
			calls++;
			return true;
		},
	});
	return { row, proof, bridge, calls: () => calls };
}

test("identity-preserving retirement can roll back new ordinary history at its adopted epoch", async () => {
	const f = fixture();
	expect(await f.bridge(f.row)).toBe(true);
	expect(f.calls()).toBe(1);
});
test("a later directory switch cannot reuse the retirement bridge", async () => {
	const f = fixture();
	f.row.workspaceRevision++;
	if (f.row.workspaceContext) f.row.workspaceContext.revision++;
	expect(await f.bridge(f.row)).toBe(false);
	expect(f.calls()).toBe(0);
});
test("same path alone cannot authorize changed physical namespace or project binding", async () => {
	for (const change of ["context", "repo", "workspace", "device", "project", "chapter"] as const) {
		const f = fixture();
		const context = f.row.workspaceContext;
		if (!context) throw new Error("fixture");
		if (change === "context") context.contextKey = "changed";
		if (change === "repo" && context.git) context.git.repositoryKey = "changed";
		if (change === "workspace" && context.git) context.git.workspaceKey = "changed";
		if (change === "device") f.row.defaultDeviceId = "remote";
		if (change === "project") f.row.contextProjectId = "new-project";
		if (change === "chapter") f.row.chapterId = "new-chapter";
		expect(await f.bridge(f.row)).toBe(false);
		expect(f.calls()).toBe(0);
	}
});
test("retained physical lineage requires the original chapter/cwd/context epoch and never accepts a new binding", async () => {
	for (const mutation of [
		"none",
		"missing",
		"cwd",
		"epoch",
		"context",
		"digest",
		"binding",
		"scopeMetadata",
	] as const) {
		const f = fixture();
		const origin = {
			narratorId: "n",
			sourceChapterId: "old-c",
			deviceId: "local",
			workspacePath: f.row.cwd,
			workspaceRevision: 2,
			workspaceContext: JSON.stringify({
				...f.row.workspaceContext,
				revision: 2,
				contextProjectId: "old-p",
			}),
		};
		const evidence = { version: 1, manifestDigest: f.proof.historyDigest, origin };
		f.proof.proofMode = "retained";
		f.proof.originJson = evidence;
		if (mutation === "missing") f.proof.originJson = null;
		if (mutation === "cwd") origin.workspacePath = "/other/old/source";
		if (mutation === "epoch") origin.workspaceRevision = 3;
		if (mutation === "context")
			origin.workspaceContext = JSON.stringify({
				...f.row.workspaceContext,
				revision: 2,
				contextKey: "wrong-origin",
			});
		if (mutation === "digest") evidence.manifestDigest = "b".repeat(64);
		if (mutation === "binding") f.row.oauthOwnerGrantId = "new-binding";
		if (mutation === "scopeMetadata")
			origin.workspaceContext = JSON.stringify({
				...f.row.workspaceContext,
				revision: 2,
				scopeMetadata: { immutableOwner: "old-origin" },
			});
		expect(await f.bridge(f.row)).toBe(mutation === "none");
	}
});
test("linked lineage never falls through to Root0 directory verification or whole-tree without current principal", async () => {
	const f = fixture();
	f.proof.proofMode = "retained";
	f.proof.originJson = {
		version: 1,
		manifestDigest: f.proof.historyDigest,
		origin: {
			narratorId: f.row.id,
			sourceChapterId: "linked",
			deviceId: "local",
			workspacePath: f.row.cwd,
			workspaceRevision: 2,
			workspaceContext: null,
		},
		linkedWorktree: { resourceId: "resource" },
	};
	let roots = 0,
		linked = 0;
	const bridge = createLegacyWorkspaceRollbackBridge({
		lookup: async () => f.proof,
		verifyDirectory: async () => {
			roots++;
			return true;
		},
		verifyLinkedDirectory: async () => {
			linked++;
			return true;
		},
	});
	expect(await bridge(f.row)).toBe(false);
	expect(roots).toBe(0);
	expect(linked).toBe(0);
	expect(await bridge(f.row, { userId: "owner", isAdmin: false })).toBe(true);
	expect(roots).toBe(0);
	expect(linked).toBe(1);
	f.row.workspaceRevision++;
	if (f.row.workspaceContext) f.row.workspaceContext.revision++;
	expect(await bridge(f.row, { userId: "owner", isAdmin: false })).toBe(false);
	expect(linked).toBe(1);
});

test("missing, corrupt or unreadable evidence fails closed", async () => {
	const f = fixture();
	const missing = createLegacyWorkspaceRollbackBridge({
		lookup: async () => undefined,
		verifyDirectory: async () => true,
	});
	expect(await missing(f.row)).toBe(false);
	f.proof.historyDigest = "unverified";
	expect(await f.bridge(f.row)).toBe(false);
	const broken = createLegacyWorkspaceRollbackBridge({
		lookup: async () => {
			throw new Error("db unavailable");
		},
		verifyDirectory: async () => true,
	});
	expect(await broken(f.row)).toBe(false);
	const changedDirectory = createLegacyWorkspaceRollbackBridge({
		lookup: async () => ({ ...f.proof, historyDigest: "a".repeat(64) }),
		verifyDirectory: async () => false,
	});
	expect(await changedDirectory(f.row)).toBe(false);
});
