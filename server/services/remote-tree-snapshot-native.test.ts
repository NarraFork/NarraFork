import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceContext } from "@shared/workspace-context";
import { eq } from "drizzle-orm";
import { db } from "../db";
import {
	narratorBlacklistDirs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	remoteDevices,
	remoteTreeCaptures,
	users,
} from "../db/schema";
import type { ToolExecutionLifecycleContext, ToolExecutionTarget } from "../lib/agent/types";
import { generateId } from "../lib/id";
import { startNativeRemoteExecutorFixture } from "./__tests__/native-remote-executor-fixture";
import { createDevice } from "./device-service";
import { buildTreeSnapshotExecutionHooks } from "./tree-snapshot-loop-hooks";

test("official native reverse RPC captures nonGit selected directory before/after with real source metadata and deny policy", async () => {
	const directory = mkdtempSync(join(tmpdir(), "nf-native-tree-hook-"));
	const root = join(directory, "selected");
	mkdirSync(join(root, "secret"), { recursive: true });
	writeFileSync(join(root, "file.txt"), "before-native\n");
	writeFileSync(join(root, "secret", "hidden.txt"), "must-not-capture\n");
	const userId = generateId();
	const narratorId = generateId();
	const messageId = generateId();
	const toolCallId = generateId();
	const toolUseId = generateId();
	const timestamp = new Date().toISOString();
	let deviceId: string | undefined;
	let fixture: Awaited<ReturnType<typeof startNativeRemoteExecutorFixture>> | undefined;
	try {
		await db.insert(users).values({
			id: userId,
			username: `native-tree-${userId}`,
			passwordHash: "fixture",
			role: "admin",
			createdAt: timestamp,
		});
		const created = await createDevice({
			name: `Tree native fixture ${userId}`,
			connectionMode: "reverse",
			ownerScope: "private",
			scope: "global",
			createdBy: userId,
		});
		deviceId = created.device.id;
		fixture = await startNativeRemoteExecutorFixture({
			directory,
			root: directory,
			deviceId,
			token: created.token,
		});
		const backend = fixture.backend;
		const canonical = await backend.resolvePathIdentity(root, { timeoutMs: 5_000 });
		const selected = canonical.canonicalPath;
		const workspace: WorkspaceContext = {
			deviceId,
			cwd: selected,
			pathFlavor: backend.pathFlavor === "windows" ? "windows" : "posix",
			contextKey: `selected-native-${narratorId}`,
			revision: 0,
			capabilities: { switchDirectory: true },
		};
		await db.insert(narrators).values({
			id: narratorId,
			cwd: selected,
			defaultDeviceId: deviceId,
			workspaceContext: workspace,
			workspaceRevision: 0,
			ownerUserId: userId,
			visibility: "private",
			writeAudience: "owner",
			traits: ["standalone"],
			createdAt: timestamp,
			updatedAt: timestamp,
		});
		await db.insert(narratorMessages).values({
			id: messageId,
			narratorId,
			role: "assistant",
			contentJson: [],
			createdAt: timestamp,
		});
		await db.insert(narratorToolCalls).values({
			id: toolCallId,
			narratorId,
			messageId,
			toolUseId,
			toolName: "Write",
			inputJson: { file_path: "file.txt" },
			status: "running",
			executionIdentityVersion: 1,
			executionAttempt: 1,
			executionOriginToolCallId: toolCallId,
			createdAt: timestamp,
		});
		await db.insert(narratorBlacklistDirs).values({
			id: generateId(),
			narratorId,
			path: backend.paths.resolve(selected, "secret"),
			pathFlavor: workspace.pathFlavor,
			targetKind: "device",
			targetValue: deviceId,
			denyLevel: "denyAll",
			enabled: true,
			createdAt: timestamp,
			updatedAt: timestamp,
		});
		const file = backend.paths.resolve(selected, "file.txt");
		const fileIdentity = await backend.resolvePathIdentity(file, { timeoutMs: 5_000 });
		const target: ToolExecutionTarget = {
			deviceId,
			backendKind: "remote",
			baseCwd: selected,
			cwd: selected,
			lexicalPath: file,
			canonicalPath: fileIdentity.canonicalPath,
			pathFlavor: backend.pathFlavor,
			runtimeGeneration: backend.runtimeGeneration,
			selectionSource: "session_default",
		};
		const session = {
			cwd: "/host-decoy",
			_defaultDeviceId: deviceId,
			_workspaceContext: workspace,
			_currentUserId: userId,
		};
		const hooks = buildTreeSnapshotExecutionHooks({ session, narratorId, isInGitRepo: false });
		const context: ToolExecutionLifecycleContext = {
			toolUse: { name: "Write", toolUseId, input: { file_path: "file.txt" } },
			effectiveInput: { file_path: file },
			executionTarget: target,
			binding: { toolCallId, attempt: 1 },
		};
		await hooks.onToolExecutionBefore?.(context);
		await backend.writeFileBytes(file, Buffer.from("after-native\n"), {
			expectedResolvedPath: fileIdentity.canonicalPath,
		});
		session.cwd = "/parent-later-cwd";
		session._currentUserId = "not-the-original-actor";
		await hooks.onToolExecutionAfter?.({
			...context,
			result: { output: "actual native bytes written" },
		});
		fixture.assertHealthy();
		const captures = await db
			.select()
			.from(remoteTreeCaptures)
			.where(eq(remoteTreeCaptures.toolCallId, toolCallId));
		expect(captures).toHaveLength(2);
		expect(
			captures.every(
				(capture) =>
					capture.state === "complete" &&
					capture.actorSubjectKey === `user:${userId}` &&
					capture.attempt === 1 &&
					capture.deviceId === deviceId &&
					capture.originContextVersion === 1 &&
					capture.originProjectId === null,
			),
		).toBe(true);
		const before = captures.find((capture) => capture.edge === "before");
		const after = captures.find((capture) => capture.edge === "after");
		expect(before?.descriptorJson?.digest).not.toBe(after?.descriptorJson?.digest);
		expect(
			captures.every(
				(capture) =>
					capture.receiptMetadataJson?.captureKind === "whole_directory" &&
					capture.receiptMetadataJson.temporalConsistency === "concurrent_observation" &&
					capture.receiptMetadataJson.effects.length === 0 &&
					(capture.receiptMetadataJson.excludedCount ?? 0) >= 1,
			),
		).toBe(true);
		expect(
			fixture.trace
				.filter((call) => call.method === "history.captureTree")
				.every((call) => call.root === selected),
		).toBe(true);
		expect(fixture.trace.some((call) => call.method === "history.captureTree")).toBe(true);
		const tool = await db.query.narratorToolCalls.findFirst({
			where: eq(narratorToolCalls.id, toolCallId),
		});
		expect(tool?.treeHashBefore).toBeNull();
		expect(tool?.treeHashAfter).toBeNull();
		expect(tool?.ownedPathsJson).toBeNull();
		if (!after?.descriptorJson || !after.receiptMetadataJson || !backend.remoteHistory)
			throw new Error("Native after tree descriptor missing");
		// Fixture verification only: inspect the real private tree metadata, not a raw-file
		// grant through the production root capture authority. Production uses a separate
		// source-qualified tree index provider, never generic root blob-read authority.
		const chunk = await backend.remoteHistory(
			"objectRead",
			{
				binding: after.receiptMetadataJson.binding,
				object: after.descriptorJson,
				offset: 0,
				maxBytes: 64_000,
			},
			AbortSignal.timeout(5_000),
		);
		expect(chunk.eof).toBe(true);
		const manifest = JSON.parse(Buffer.from(chunk.contentBase64, "base64").toString("utf8"));
		expect(manifest.format).toBe("whole_directory_tree_v1");
		expect(manifest.entryCount).toBe(1);
		expect(manifest.excludedCount).toBeGreaterThanOrEqual(1);
		expect(manifest.binding.sourceInstanceId).toBe(after.sourceInstanceId);
	} finally {
		await fixture?.dispose();
		await db.delete(remoteTreeCaptures).where(eq(remoteTreeCaptures.narratorId, narratorId));
		await db.delete(narratorBlacklistDirs).where(eq(narratorBlacklistDirs.narratorId, narratorId));
		await db.delete(narratorToolCalls).where(eq(narratorToolCalls.narratorId, narratorId));
		await db.delete(narratorMessages).where(eq(narratorMessages.narratorId, narratorId));
		await db.delete(narrators).where(eq(narrators.id, narratorId));
		if (deviceId) await db.delete(remoteDevices).where(eq(remoteDevices.id, deviceId));
		await db.delete(users).where(eq(users.id, userId));
		rmSync(directory, { recursive: true, force: true });
	}
}, 90_000);
