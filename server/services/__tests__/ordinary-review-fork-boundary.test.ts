import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import {
	chapters,
	narratorBlacklistDirs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	projects,
	users,
} from "../../db/schema";
import { analyzeShellCommand } from "../../lib/agent/bash-analyze";
import { localBackend } from "../../lib/agent/execution/registry";
import { generateId } from "../../lib/id";
import { settings } from "../../lib/settings";
import type { ExecutionTargetContext } from "../execution-policy/types";

const { db, sqlite } = getTestDb();
const realDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDb, db, sqlite }));
const { narratorService } = await import("../narrator-service");
const { executionPolicyEngine } = await import("../execution-policy/engine");
const { resolvePermissionDecision, recheckFinalToolExecutionPermission } = await import(
	"../narrator-permission"
);
const { permissionRuleService } = await import("../permission-rule-service");
const { appendMessageRef } = await import("../narrator-persistence");
const {
	isReviewBoundaryRuleId,
	isSignedReviewBoundaryRow,
	isTrustedReviewBoundary,
	sanitizeUntrustedReviewBoundaryIds,
} = await import("../narrator-review-boundary");
const { ExecutionPolicyEngine } = await import("../execution-policy/engine");
const originalGlobalBlacklist = settings.agent.blacklistDirs;
const root = "/fixture-review/worktree";
const free = "/fixture-free";
const now = new Date().toISOString();
function target(cwd: string): ExecutionTargetContext {
	return {
		backend: localBackend,
		paths: localBackend.paths,
		deviceClass: "host",
		target: {
			deviceId: "local",
			backendKind: "local",
			cwd,
			pathFlavor: localBackend.paths.flavor,
			runtimeGeneration: 0,
			selectionSource: "session_default",
		},
	} as ExecutionTargetContext;
}
beforeEach(async () => {
	cleanDb(sqlite);
	await db.insert(users).values({
		id: "owner",
		username: "owner",
		passwordHash: "fixture",
		role: "user",
		createdAt: now,
	});
	await db.insert(projects).values({
		id: "project",
		name: "fixture",
		gitPath: "/fixture-review",
		ownerUserId: "owner",
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(chapters).values({
		id: "review",
		projectId: "project",
		title: "real review shape",
		branch: "review",
		baseBranch: "main",
		role: "review",
		worktreePath: root,
		createdAt: now,
		updatedAt: now,
	});
});
afterEach(() => {
	settings.agent.blacklistDirs = originalGlobalBlacklist;
	cleanDb(sqlite);
});
afterAll(() => {
	mock.module("../../db", () => realDb);
});
async function source() {
	// Exactly the review-service.create() narrator input shape: no readonly mode or review trait.
	const parent = await narratorService.create({
		chapterId: "review",
		type: "primary",
		cwd: root,
		systemPrompt: "review fixture",
		ownerUserId: "owner",
	});
	expect(parent.permissionMode).not.toBe("readOnly");
	expect(parent.traits).not.toContain("review");
	return parent;
}
async function decision(
	id: string,
	toolName: string,
	input: Record<string, unknown>,
	mode = "bypassPermissions",
	cwd = root,
	context = target(cwd),
) {
	executionPolicyEngine.invalidate(id);
	const policy = await executionPolicyEngine.compile(id, context);
	const analysis =
		toolName === "Bash" ? await analyzeShellCommand(String(input.command), cwd, "bash") : undefined;
	return resolvePermissionDecision({
		toolName,
		input,
		permMode: mode,
		cwd,
		compiledPolicy: policy,
		executionContext: context,
		bashAnalysis: analysis,
	});
}

async function approvedAttempt(
	narratorId: string,
	toolName: string,
	input: Record<string, unknown>,
	context = target(root),
) {
	const messageId = generateId();
	const id = generateId();
	const toolUseId = generateId();
	const filePath = typeof input.file_path === "string" ? input.file_path : undefined;
	const executionTarget = {
		...context.target,
		...(filePath
			? { lexicalPath: filePath, resolvedFilePath: filePath, canonicalPath: filePath }
			: {}),
	};
	await db.insert(narratorMessages).values({
		id: messageId,
		narratorId,
		role: "assistant",
		contentJson: [{ type: "tool_use", id: toolUseId, name: toolName, input }],
		createdAt: now,
	});
	await appendMessageRef(narratorId, messageId);
	await db.insert(narratorToolCalls).values({
		id,
		narratorId,
		messageId,
		toolUseId,
		toolName,
		inputJson: input,
		status: "running",
		executionIdentityVersion: 1,
		executionAttempt: 1,
		permissionDecidedBy: "user",
		permissionDecidedAt: now,
		executionDeviceId: context.target.deviceId,
		executionCwd: context.target.cwd,
		executionPathFlavor: executionTarget.pathFlavor,
		canonicalFilePath: filePath,
		resolvedFilePath: filePath,
		runtimeGeneration: 0,
		executionTargetsJson: [executionTarget],
		deviceSelectionSource: "session_default",
		createdAt: now,
	});
	return {
		narratorId,
		toolName,
		input,
		toolUseId,
		binding: { toolCallId: id, attempt: 1 },
		executionBackend: context.backend,
		executionTarget,
		cwd: context.target.cwd,
	};
}

describe("ordinary fork preserves effective review workspace hard boundary", () => {
	test.each([
		`mv /fixture-review /fixture-moved`,
		`mv '/fixture-review' '/fixture-moved'`,
		`mv "/fixture-review" "/fixture-moved"`,
		`mv .. /fixture-moved`,
		`mv . /fixture-moved`,
		`cp -r --parents .worktrees/review /fixture-review`,
		`PATH=/fake/bin mv /fixture-review /fixture-moved`,
		`mv ${root} /fixture-moved`,
		`mv -T /fixture-free/source /fixture-review`,
		`mv --no-target-directory /fixture-free/source /fixture-review`,
		`mv /fixture-free/worktree /fixture-review`,
		`mv -t /fixture-review /fixture-free/worktree`,
		`mv --target-directory=/fixture-review /fixture-free/worktree`,
		`cp -r /fixture-free/worktree /fixture-review`,
		`cp -r /fixture-free/unrelated/. /fixture-review`,
		`cp -r /fixture-free/unrelated/.. /fixture-review`,
		`cp -r -T /fixture-free/source /fixture-review`,
		`rm -rf /fixture-review`,
		`mv / /fixture-moved`,
		`cp -r -T /fixture-free/source /`,
		`mv "$SOURCE" /fixture-moved`,
		`mv /fixture-review/* /fixture-moved`,
	])("directory footprint is denied before bypass and after real approval: %s", async (command) => {
		const parent = await source();
		const child = await narratorService.forkStandaloneFromTool(parent.id, "fresh");
		await permissionRuleService.createNarratorRule(child.id, {
			ruleType: "commandWhitelist",
			value: { pattern: "mv *", enabled: true },
		});
		for (const id of [parent.id, child.id]) {
			expect(["deny", "fatal"]).toContain(await decision(id, "Bash", { command }));
			await expect(
				recheckFinalToolExecutionPermission(await approvedAttempt(id, "Bash", { command })),
			).rejects.toThrow();
		}
	});
	test("minimal .worktrees parent move reproduction is caught by the review layer, not structure guard", async () => {
		const protectedRoot = "/repo/.worktrees/review";
		await db.update(projects).set({ gitPath: "/repo" }).where(eq(projects.id, "project"));
		await db.update(chapters).set({ worktreePath: protectedRoot }).where(eq(chapters.id, "review"));
		const parent = await source();
		const child = await narratorService.forkStandaloneFromTool(parent.id, "fresh");
		const command = "mv /repo/.worktrees /repo/moved";
		const analysis = await analyzeShellCommand(command, protectedRoot, "bash");
		expect(analysis.filePaths).toEqual(["/repo/.worktrees", "/repo/moved"]);
		expect(analysis.dangerousPatterns).toEqual([]);
		for (const id of [parent.id, child.id]) {
			expect(await decision(id, "Bash", { command }, "bypassPermissions", protectedRoot)).toBe(
				"deny",
			);
			await expect(
				recheckFinalToolExecutionPermission(
					await approvedAttempt(id, "Bash", { command }, target(protectedRoot)),
				),
			).rejects.toThrow("review");
		}
	});
	test.each([
		["Write", { file_path: "/fixture-review/sibling.txt", content: "unrelated" }],
		["Bash", { command: "touch /fixture-review/sibling.txt" }],
		["Bash", { command: "mkdir /fixture-review/sibling" }],
		["Bash", { command: "mkdir -p /fixture-review" }],
		["Bash", { command: "rm /fixture-review/sibling.txt" }],
		["Bash", { command: "mv /fixture-review/sibling /fixture-free/moved" }],
		["Bash", { command: "cp /fixture-free/sibling.txt /fixture-review" }],
		["Bash", { command: "cp -r /fixture-free/sibling /fixture-review" }],
		["Read", { file_path: "/fixture-review" }],
		["Bash", { command: "ls /fixture-review" }],
		["Bash", { command: "stat /fixture-review" }],
	] as const)("unrelated sibling and ancestor reads retain authority: %s %j", async (tool, input) => {
		const child = await narratorService.forkStandaloneFromTool((await source()).id, "fresh");
		expect(await decision(child.id, tool, input)).toBe("allow");
		const fence = await recheckFinalToolExecutionPermission(
			await approvedAttempt(child.id, tool, input),
		);
		expect(() => fence.assertStillCurrent()).not.toThrow();
	});
	test.each([
		"",
		"-P",
		"-f",
		"-t",
	])("directory-derived copy targets follow protected file symlinks in both guards: %s", async (flags) => {
		const fixture = mkdtempSync(join(tmpdir(), "nf-review-copy-symlink-"));
		try {
			const destination = join(fixture, "fixture-review");
			const protectedRoot = join(destination, "worktree");
			const sourceDir = join(fixture, "fixture-free");
			const sourceFile = join(sourceDir, "source.ts");
			const protectedFile = join(protectedRoot, "source.ts");
			mkdirSync(protectedRoot, { recursive: true });
			mkdirSync(sourceDir);
			writeFileSync(sourceFile, "replacement");
			writeFileSync(protectedFile, "protected original");
			// GNU cp follows an existing destination-file symlink even with -P: -P
			// describes SOURCE dereferencing, not the write target derived from the directory.
			symlinkSync(join("worktree", "source.ts"), join(destination, "source.ts"));
			await db
				.update(chapters)
				.set({ worktreePath: protectedRoot })
				.where(eq(chapters.id, "review"));
			const parent = await source();
			const child = await narratorService.forkStandaloneFromTool(parent.id, "fresh");
			const command =
				flags === "-t"
					? `cp -t '${destination}' '${sourceFile}'`
					: `cp ${flags} '${sourceFile}' '${destination}'`;
			for (const id of [parent.id, child.id]) {
				expect(await decision(id, "Bash", { command })).toBe("deny");
				await expect(
					recheckFinalToolExecutionPermission(await approvedAttempt(id, "Bash", { command })),
				).rejects.toThrow("review");
			}
			expect(readFileSync(protectedFile, "utf8")).toBe("protected original");
		} finally {
			rmSync(fixture, { recursive: true, force: true });
		}
	});
	test("directory-derived copy targets and symlinks outside the protected tree remain allowed", async () => {
		const fixture = mkdtempSync(join(tmpdir(), "nf-review-copy-positive-"));
		try {
			const protectedRoot = join(fixture, "review", "worktree");
			const destination = join(fixture, "elsewhere");
			const sourceDir = join(fixture, "source");
			mkdirSync(protectedRoot, { recursive: true });
			mkdirSync(destination);
			mkdirSync(sourceDir);
			writeFileSync(join(sourceDir, "source.ts"), "replacement");
			writeFileSync(join(destination, "real.ts"), "outside original");
			symlinkSync("real.ts", join(destination, "source.ts"));
			await db
				.update(chapters)
				.set({ worktreePath: protectedRoot })
				.where(eq(chapters.id, "review"));
			const child = await narratorService.forkStandaloneFromTool((await source()).id, "fresh");
			for (const sourceName of ["source.ts", "new.ts"]) {
				writeFileSync(join(sourceDir, sourceName), "outside copy");
				for (const flag of ["", "-P"]) {
					const command = `cp ${flag} '${join(sourceDir, sourceName)}' '${destination}'`;
					expect(await decision(child.id, "Bash", { command })).toBe("allow");
					const fence = await recheckFinalToolExecutionPermission(
						await approvedAttempt(child.id, "Bash", { command }),
					);
					expect(() => fence.assertStillCurrent()).not.toThrow();
				}
			}
		} finally {
			rmSync(fixture, { recursive: true, force: true });
		}
	});
	test("host symlink aliases to parent and root are fenced in both approval phases", async () => {
		const fixture = mkdtempSync(join(tmpdir(), "nf-review-boundary-"));
		try {
			const parentPath = join(fixture, "repo", ".worktrees");
			const protectedRoot = join(parentPath, "review");
			mkdirSync(protectedRoot, { recursive: true });
			const alias = join(fixture, "alias");
			symlinkSync(parentPath, alias);
			await db
				.update(chapters)
				.set({ worktreePath: protectedRoot })
				.where(eq(chapters.id, "review"));
			const child = await narratorService.forkStandaloneFromTool((await source()).id, "fresh");
			for (const [tool, input] of [
				["Bash", { command: `mv '${alias}' '${fixture}/moved'` }],
				["Bash", { command: `mv '${alias}/review' '${fixture}/moved'` }],
				["Write", { file_path: `${alias}/review/source.ts`, content: "mutate" }],
			] as const) {
				expect(await decision(child.id, tool, input)).toBe("deny");
				await expect(
					recheckFinalToolExecutionPermission(await approvedAttempt(child.id, tool, input)),
				).rejects.toThrow("review");
			}
			// The admitted Bash identity is unchanged, but a later symlink changes its real
			// destination footprint before the final-start gate. Human approval is not an escape.
			const destination = join(fixture, "later-destination");
			const command = `cp -r -T '${fixture}/free' '${destination}'`;
			expect(await decision(child.id, "Bash", { command })).toBe("allow");
			const approved = await approvedAttempt(child.id, "Bash", { command });
			symlinkSync(parentPath, destination);
			await expect(recheckFinalToolExecutionPermission(approved)).rejects.toThrow("review");
		} finally {
			rmSync(fixture, { recursive: true, force: true });
		}
	});
	test("identical remote-device path and root are not a host review boundary", async () => {
		const child = await narratorService.forkStandaloneFromTool((await source()).id, "fresh");
		const local = target(root);
		const remote = {
			...local,
			backend: {
				...local.backend,
				kind: "remote",
				deviceId: "another-device",
				platform: { ...local.backend.platform, os: "linux", shellType: "bash" },
				resolvePathIdentity: async (path: string) => ({
					lexicalPath: path,
					canonicalPath: path,
					exists: true,
					runtimeGeneration: 0,
				}),
			},
			deviceClass: null,
			target: { ...local.target, deviceId: "another-device", backendKind: "remote" },
		} as ExecutionTargetContext;
		for (const command of [`mv ${root} /fixture-moved`, "mv /fixture-review /fixture-moved"]) {
			expect(await decision(child.id, "Bash", { command }, "bypassPermissions", root, remote)).toBe(
				"allow",
			);
			const fence = await recheckFinalToolExecutionPermission(
				await approvedAttempt(child.id, "Bash", { command }, remote),
			);
			expect(() => fence.assertStillCurrent()).not.toThrow();
		}
		expect(
			await decision(
				child.id,
				"Write",
				{ file_path: `${root}/source.ts`, content: "allowed" },
				"bypassPermissions",
				root,
				remote,
			),
		).toBe("allow");
		const fence = await recheckFinalToolExecutionPermission(
			await approvedAttempt(
				child.id,
				"Write",
				{
					file_path: `${root}/source.ts`,
					content: "allowed",
				},
				remote,
			),
		);
		expect(() => fence.assertStillCurrent()).not.toThrow();
	});
	test.each([
		"project",
		"global",
		"narrator",
	] as const)("untrusted %s review prefix cannot weaken denyAll or confer hard authority", async (scope) => {
		await db.update(chapters).set({ role: "branch" }).where(eq(chapters.id, "review"));
		const parent = await source();
		const row = {
			id: "review-boundary:fake",
			path: root,
			denyLevel: "denyAll" as const,
			targetKind: "host" as const,
			deviceScope: "local",
			enabled: true,
		};
		if (scope === "project")
			await db
				.update(projects)
				.set({ chapterSettings: { blacklistDirs: [row] } })
				.where(eq(projects.id, "project"));
		if (scope === "global") settings.agent.blacklistDirs = [row];
		if (scope === "narrator")
			await db
				.insert(narratorBlacklistDirs)
				.values({ ...row, narratorId: parent.id, createdAt: now });
		expect(await decision(parent.id, "Read", { file_path: `${root}/source.ts` })).toBe("deny");
		await expect(
			recheckFinalToolExecutionPermission(
				await approvedAttempt(parent.id, "Read", { file_path: `${root}/source.ts` }),
			),
		).rejects.toThrow();
		const policy = await executionPolicyEngine.compile(parent.id, target(root));
		expect(policy.directoryBlacklist.some(isTrustedReviewBoundary)).toBe(false);
		const sanitized = sanitizeUntrustedReviewBoundaryIds({ blacklistDirs: [row] }) as {
			blacklistDirs: (typeof row)[];
		};
		expect(sanitized.blacklistDirs[0].id).toBeUndefined();
		expect(sanitized.blacklistDirs[0].denyLevel).toBe("denyAll");
		if (scope === "narrator") {
			await permissionRuleService.updateNarratorRule(parent.id, {
				ruleType: "directoryBlacklist",
				value: { ...row, denyLevel: "denyWrite" },
			});
			expect(await decision(parent.id, "Read", { file_path: `${root}/source.ts` })).toBe("allow");
			expect(
				await decision(parent.id, "Write", { file_path: `${root}/source.ts`, content: "mutate" }),
			).toBe("deny");
			const child = await narratorService.forkStandaloneFromTool(parent.id, "fresh");
			const childPolicy = await executionPolicyEngine.compile(child.id, target(root));
			expect(childPolicy.directoryBlacklist.some(isTrustedReviewBoundary)).toBe(false);
			await permissionRuleService.deleteNarratorRule(parent.id, "directoryBlacklist", row.id);
		}
	});
	test("signed row is verified after a fresh process startup, but owner/path replay and unsigned legacy fail", async () => {
		const child = await narratorService.forkStandaloneFromTool((await source()).id, "fresh");
		const row = db
			.select()
			.from(narratorBlacklistDirs)
			.where(eq(narratorBlacklistDirs.narratorId, child.id))
			.get();
		if (!row) throw new Error("missing boundary");
		const probe = spawnSync(
			process.execPath,
			[
				"-e",
				`
			const { isSignedReviewBoundaryRow } = await import("./server/services/narrator-review-boundary.ts");
			const row = JSON.parse(process.env.NF_REVIEW_TEST_ROW);
			console.log(JSON.stringify([
				isSignedReviewBoundaryRow(row),
				isSignedReviewBoundaryRow({ ...row, narratorId: "different-owner" }),
				isSignedReviewBoundaryRow({ ...row, path: "/different-path" }),
				isSignedReviewBoundaryRow({ ...row, id: "review-boundary:legacy" }),
			]));
		`,
			],
			{
				cwd: process.cwd(),
				env: { ...process.env, NF_REVIEW_TEST_ROW: JSON.stringify(row) },
				encoding: "utf8",
				timeout: 5000,
				maxBuffer: 32 * 1024,
			},
		);
		expect(probe.error).toBeUndefined();
		expect(probe.status).toBe(0);
		expect(probe.stdout.trim()).toBe("[true,false,false,false]");
	});
	test("signed proof survives a cold engine and denyAll anomaly never gains a read exemption", async () => {
		const child = await narratorService.forkStandaloneFromTool((await source()).id, "fresh");
		const row = db
			.select()
			.from(narratorBlacklistDirs)
			.where(eq(narratorBlacklistDirs.narratorId, child.id))
			.get();
		if (!row) throw new Error("missing boundary");
		expect(isSignedReviewBoundaryRow(row)).toBe(true);
		const cold = await new ExecutionPolicyEngine().compile(child.id, target(root));
		expect(cold.directoryBlacklist.some(isTrustedReviewBoundary)).toBe(true);
		await db
			.update(narratorBlacklistDirs)
			.set({ denyLevel: "denyAll" })
			.where(eq(narratorBlacklistDirs.id, row.id));
		expect(await decision(child.id, "Read", { file_path: `${root}/source.ts` })).toBe("deny");
		await expect(
			recheckFinalToolExecutionPermission(
				await approvedAttempt(child.id, "Read", { file_path: `${root}/source.ts` }),
			),
		).rejects.toThrow();
	});
	test("final-start recheck refuses approved Write and opaque Bash in child; free path approval still works", async () => {
		const child = await narratorService.forkStandaloneFromTool((await source()).id, "fresh");
		await db
			.update(narrators)
			.set({ permissionMode: "bypassPermissions" })
			.where(eq(narrators.id, child.id));
		for (const [tool, input] of [
			["Write", { file_path: `${root}/source.ts`, content: "mutate" }],
			["Bash", { command: "python -c 'arbitrary_code()'" }],
		] as const) {
			const check = await approvedAttempt(child.id, tool, input);
			await expect(recheckFinalToolExecutionPermission(check)).rejects.toThrow("review");
		}
		const allowed = await approvedAttempt(child.id, "Write", {
			file_path: `${free}/note.txt`,
			content: "allowed",
		});
		const fence = await recheckFinalToolExecutionPermission(allowed);
		expect(() => fence.assertStillCurrent()).not.toThrow();
	});
	test("real review creation shape denies source/child writes in protected root, but not ordinary free paths", async () => {
		const parent = await source();
		const child = await narratorService.forkStandaloneFromTool(parent.id, "fresh");
		expect(child.chapterId).toBeNull();
		expect(child.permissionMode).toBe(parent.permissionMode);
		for (const id of [parent.id, child.id]) {
			expect(
				await decision(id, "Write", { file_path: `${root}/source.ts`, content: "mutate" }),
			).toBe("deny");
			expect(await decision(id, "Bash", { command: `touch ${root}/source.ts` })).toBe("deny");
			expect(await decision(id, "Bash", { command: "python -c 'arbitrary_code()'" })).toBe("deny");
			expect(await decision(id, "Read", { file_path: `${root}/source.ts` })).toBe("allow");
			expect(await decision(id, "Bash", { command: "git status --short" })).toBe("allow");
			expect(
				await decision(id, "Write", { file_path: `${free}/note.txt`, content: "allowed" }),
			).toBe("allow");
			expect(await decision(id, "Bash", { command: `touch ${free}/note.txt` })).toBe("allow");
		}
		// Review conclusions are metadata, not worktree writes.
		expect(
			await decision(parent.id, "ReviewConclusion", { verdict: "approve", summary: "fixture" }),
		).toBe("allow");
	});
	test("whitelist, plan-file exemption and bypass modes cannot erase the child hard boundary", async () => {
		const child = await narratorService.forkStandaloneFromTool((await source()).id, "fresh");
		await permissionRuleService.createNarratorRule(child.id, {
			ruleType: "directoryWhitelist",
			value: { path: root, accessLevel: "full", targetKind: "host" },
		});
		await permissionRuleService.createNarratorRule(child.id, {
			ruleType: "commandWhitelist",
			value: { pattern: "python *", enabled: true },
		});
		for (const mode of ["default", "acceptEdits", "bypassPermissions"]) {
			expect(
				await decision(
					child.id,
					"Write",
					{ file_path: `${root}/source.ts`, content: "mutate" },
					mode,
				),
			).toBe("deny");
			expect(
				await decision(child.id, "Bash", { command: "python -c 'arbitrary_code()'" }, mode),
			).toBe("deny");
		}
		const context = target(root);
		const policy = await executionPolicyEngine.compile(child.id, context);
		expect(
			resolvePermissionDecision({
				toolName: "Write",
				input: { file_path: `${root}/plan.md`, content: "mutate" },
				permMode: "bypassPermissions",
				cwd: root,
				compiledPolicy: policy,
				executionContext: context,
				planMode: true,
				planFilePath: `${root}/plan.md`,
			}),
		).toBe("deny");
	});
	test("changing source role/child cwd and removing the source cannot unfreeze descendant deny rows", async () => {
		const parent = await source();
		const child = await narratorService.forkStandaloneFromTool(parent.id, "fresh");
		await db.update(chapters).set({ role: "branch" }).where(eq(chapters.id, "review"));
		await db
			.update(narrators)
			.set({ cwd: free, traits: [], permissionMode: "bypassPermissions" })
			.where(eq(narrators.id, child.id));
		const grandchild = await narratorService.forkStandaloneFromTool(child.id, "fresh");
		// Simulate removal after the legacy parent link is cleared; the boundary must
		// survive independently of both chapter role and narrator lineage.
		await db.update(narrators).set({ parentNarratorId: null }).where(eq(narrators.id, child.id));
		await db.delete(narrators).where(eq(narrators.id, parent.id));
		for (const id of [child.id, grandchild.id]) {
			const rows = await db
				.select()
				.from(narratorBlacklistDirs)
				.where(eq(narratorBlacklistDirs.narratorId, id));
			expect(rows.some((row) => isReviewBoundaryRuleId(row.id))).toBe(true);
			expect(
				await decision(
					id,
					"Write",
					{ file_path: `${root}/source.ts`, content: "mutate" },
					"bypassPermissions",
					free,
				),
			).toBe("deny");
			expect(
				await decision(
					id,
					"Write",
					{ file_path: `${free}/note.txt`, content: "allowed" },
					"bypassPermissions",
					free,
				),
			).toBe("allow");
		}
	});
	test("a pre-existing denyAll row remains independently editable without losing inherited read/write protection", async () => {
		const parent = await source();
		await permissionRuleService.createNarratorRule(parent.id, {
			ruleType: "directoryBlacklist",
			value: { path: root, denyLevel: "denyAll", targetKind: "host" },
		});
		const child = await narratorService.forkStandaloneFromTool(parent.id, "fresh");
		const rows = await db
			.select()
			.from(narratorBlacklistDirs)
			.where(eq(narratorBlacklistDirs.narratorId, child.id));
		expect(rows).toHaveLength(2);
		const editable = rows.find((row) => !isReviewBoundaryRuleId(row.id));
		if (!editable) throw new Error("missing independent editable denyAll row");
		expect(editable.denyLevel).toBe("denyAll");
		expect(await decision(child.id, "Read", { file_path: `${root}/source.ts` })).toBe("deny");
		await permissionRuleService.deleteNarratorRule(child.id, "directoryBlacklist", editable.id);
		expect(await decision(child.id, "Read", { file_path: `${root}/source.ts` })).toBe("allow");
		expect(
			await decision(child.id, "Write", { file_path: `${root}/source.ts`, content: "mutate" }),
		).toBe("deny");
	});
	test("server-owned boundary rows cannot be edited/deleted through production permission service", async () => {
		const child = await narratorService.forkStandaloneFromTool((await source()).id, "fresh");
		const row = (
			await db
				.select()
				.from(narratorBlacklistDirs)
				.where(eq(narratorBlacklistDirs.narratorId, child.id))
		).find((row) => isReviewBoundaryRuleId(row.id));
		if (!row) throw new Error("missing real frozen review boundary");
		for (const patch of [
			{ enabled: false },
			{ path: free },
			{ denyLevel: "denyAll" as const },
			{
				targetKind: "device" as const,
				targetValue: "another-device",
				deviceScope: "another-device",
			},
		]) {
			await expect(
				permissionRuleService.updateNarratorRule(child.id, {
					ruleType: "directoryBlacklist",
					value: { ...row, ...patch },
				}),
			).rejects.toThrow("review");
		}
		// A new ordinary row cannot replace the existing canonical boundary through POST.
		await expect(
			permissionRuleService.createNarratorRule(child.id, {
				ruleType: "directoryBlacklist",
				value: { path: root, denyLevel: "denyWrite", enabled: false, targetKind: "host" },
			}),
		).rejects.toThrow();
		await expect(
			permissionRuleService.deleteNarratorRule(child.id, "directoryBlacklist", row.id),
		).rejects.toThrow("review");
		expect(
			await decision(child.id, "Write", { file_path: `${root}/source.ts`, content: "mutate" }),
		).toBe("deny");
	});
	test("non-review ordinary fork retains normal write/Bash authority", async () => {
		await db.update(chapters).set({ role: "branch" }).where(eq(chapters.id, "review"));
		const parent = await narratorService.create({
			chapterId: "review",
			type: "primary",
			cwd: root,
			ownerUserId: "owner",
		});
		const child = await narratorService.forkStandaloneFromTool(parent.id, "fresh");
		expect(
			await decision(child.id, "Write", { file_path: `${root}/source.ts`, content: "allowed" }),
		).toBe("allow");
		expect(await decision(child.id, "Bash", { command: "python -c 'arbitrary_code()'" })).toBe(
			"allow",
		);
	});
});
