import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../db";
import {
	fileChangeOperations,
	fileChangeScopes,
	narratorMessages,
	narrators,
	narratorToolCalls,
	workspaceWriteLeases,
} from "../db/schema";
import { generateId } from "../lib/id";
import { hasNarratorAdmissionWork, withNarratorWorkAdmission } from "./narrator-session-state";
import { collectRevertBlockers } from "./revert-blockers";

const now = () => new Date().toISOString();
const ids = {
	narrator: generateId(),
	other: generateId(),
	message: generateId(),
};

beforeEach(() => {
	const timestamp = now();
	db.insert(narrators)
		.values({
			id: ids.narrator,
			cwd: "/tmp/revert-blockers-workspace",
			createdAt: timestamp,
			updatedAt: timestamp,
		})
		.run();
	db.insert(narrators)
		.values({
			id: ids.other,
			cwd: "/tmp/revert-blockers-workspace",
			createdAt: timestamp,
			updatedAt: timestamp,
		})
		.run();
	db.insert(narrators)
		.values({
			id: generateId(),
			cwd: "/tmp/elsewhere",
			createdAt: timestamp,
			updatedAt: timestamp,
		})
		.run();
	db.insert(narratorMessages)
		.values({
			id: ids.message,
			narratorId: ids.narrator,
			role: "assistant",
			contentJson: [{ type: "text", text: "fixture" }],
			createdAt: timestamp,
		})
		.run();
});

afterEach(() => {
	db.delete(narratorToolCalls).run();
	db.delete(fileChangeOperations).run();
	db.delete(workspaceWriteLeases).run();
	db.delete(fileChangeScopes).run();
	db.delete(narratorMessages).run();
	db.delete(narrators).run();
});

describe("collectRevertBlockers", () => {
	test("preview does not diagnose its own admission as unfinished work", async () => {
		await withNarratorWorkAdmission(ids.narrator, async () => {
			expect(hasNarratorAdmissionWork(ids.narrator)).toBe(true);
			expect(collectRevertBlockers(ids.narrator)).toEqual([]);
		});
		expect(hasNarratorAdmissionWork(ids.narrator)).toBe(false);
	});

	test("excluding the preview claim still reports concurrent admitted work", async () => {
		let release!: () => void;
		let entered!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const other = withNarratorWorkAdmission(ids.narrator, async () => {
			entered();
			await gate;
		});
		await started;
		try {
			await withNarratorWorkAdmission(ids.narrator, async () => {
				expect(collectRevertBlockers(ids.narrator)).toEqual([{ kind: "narrator_busy" }]);
			});
		} finally {
			release();
			await other;
		}
	});

	test("planner busy short-circuits to one high-signal blocker", () => {
		const blockers = collectRevertBlockers(ids.narrator, "REVERT_PLANNER_BUSY");
		expect(blockers).toEqual([
			{
				kind: "planner_busy",
				detail: "Another preview is running",
			},
		]);
	});

	test("names this narrator's running tool without treating a foreign writer as a barrier", () => {
		const timestamp = now();
		const mine = generateId();
		const foreign = generateId();
		db.insert(narratorToolCalls)
			.values({
				id: mine,
				narratorId: ids.narrator,
				messageId: ids.message,
				toolUseId: generateId(),
				toolName: "Bash",
				inputJson: { command: "sleep 30", description: "long bash" },
				status: "running",
				createdAt: timestamp,
			})
			.run();
		db.insert(narratorToolCalls)
			.values({
				id: foreign,
				narratorId: ids.other,
				messageId: ids.message,
				toolUseId: generateId(),
				toolName: "Edit",
				inputJson: { file_path: "shared.ts" },
				status: "running",
				executionCwd: "/tmp/revert-blockers-workspace",
				createdAt: timestamp,
			})
			.run();
		const blockers = collectRevertBlockers(ids.narrator);
		expect(blockers).toEqual([
			{
				kind: "running_tool",
				toolCallId: mine,
				toolName: "Bash",
				messageId: ids.message,
			},
		]);
		expect(blockers.find((item) => item.toolCallId === foreign)).toBeUndefined();
		expect(JSON.stringify(blockers)).not.toContain("shared.ts");
		expect(JSON.stringify(blockers)).not.toContain("sleep 30");
	});

	for (const status of ["initializing", "pending", "running"] as const)
		test(`historical ${status} copies are not live tools, but an explicit new attempt is`, () => {
			const timestamp = now();
			const originId = generateId();
			const copyId = generateId();
			const toolUseId = generateId();
			db.insert(narratorToolCalls)
				.values([
					{
						id: originId,
						narratorId: ids.other,
						messageId: ids.message,
						toolUseId,
						toolName: "Edit",
						status,
						createdAt: timestamp,
					},
					{
						id: copyId,
						narratorId: ids.narrator,
						messageId: ids.message,
						toolUseId,
						toolName: "Edit",
						status,
						executionOriginToolCallId: originId,
						createdAt: timestamp,
					},
				])
				.run();
			expect(collectRevertBlockers(ids.narrator)).toEqual([]);
			expect(collectRevertBlockers(ids.other)).toEqual([
				{
					kind: "running_tool",
					toolCallId: originId,
					toolName: "Edit",
					messageId: ids.message,
				},
			]);

			const retryId = generateId();
			db.insert(narratorToolCalls)
				.values({
					id: retryId,
					narratorId: ids.narrator,
					messageId: ids.message,
					toolUseId,
					toolName: "Edit",
					status: "running",
					executionAttempt: 2,
					createdAt: timestamp,
				})
				.run();
			expect(collectRevertBlockers(ids.narrator)).toEqual([
				{
					kind: "running_tool",
					toolCallId: retryId,
					toolName: "Edit",
					messageId: ids.message,
				},
			]);
		});

	test("archived pending operations and quarantined leases never block new narrator work", async () => {
		const timestamp = now();
		const operationId = generateId();
		const leaseId = generateId();
		const scopeId = generateId();
		db.insert(fileChangeScopes)
			.values({
				id: scopeId,
				sourceInstanceId: "test-installation",
				deviceId: "local",
				workspaceInstanceId: generateId(),
				canonicalRoot: "/tmp/revert-blockers-workspace",
				displayRoot: "/tmp/revert-blockers-workspace",
				pathFlavor: "posix",
				status: "active",
				activeLeaseId: leaseId,
				activeMutationCount: 2,
				createdAt: timestamp,
				updatedAt: timestamp,
			})
			.run();
		db.insert(fileChangeOperations)
			.values({
				id: operationId,
				sourceInstanceId: "test-installation",
				sourceKind: "tool",
				sourceId: generateId(),
				attempt: 1,
				narratorId: ids.narrator,
				actorSubjectKey: `primary:${ids.narrator}`,
				actorJson: {
					kind: "primary",
					subjectKey: `primary:${ids.narrator}`,
					narratorId: ids.narrator,
					userId: null,
					label: null,
					deleted: false,
					parentSubjectKey: null,
				},
				settlement: "applying",
				executionOutcome: "running",
				startedAt: timestamp,
				updatedAt: timestamp,
			})
			.run();
		db.insert(workspaceWriteLeases)
			.values({
				leaseId,
				scopeId,
				deviceId: "local",
				ownerEpoch: "owner",
				runtimeEpoch: "epoch",
				runtimeGeneration: 1,
				fencingToken: 1,
				scopeRevision: 1,
				pathFlavor: "posix",
				status: "executing",
				rangesJson: { version: 1, ranges: [] },
				mutationManifestJson: { version: 1, mutations: [] },
				createdAt: timestamp,
				updatedAt: timestamp,
			})
			.run();
		db.update(workspaceWriteLeases)
			.set({ status: "quarantined" })
			.where(eq(workspaceWriteLeases.leaseId, leaseId))
			.run();
		db.update(fileChangeScopes)
			.set({ status: "needs_verification" })
			.where(eq(fileChangeScopes.id, scopeId))
			.run();
		const archived = JSON.stringify({
			leases: db.select().from(workspaceWriteLeases).all(),
			scopes: db.select().from(fileChangeScopes).all(),
			operations: db.select().from(fileChangeOperations).all(),
		});
		expect(collectRevertBlockers(ids.narrator)).toEqual([]);
		let continued = false;
		await withNarratorWorkAdmission(ids.narrator, async () => {
			continued = true;
			expect(collectRevertBlockers(ids.narrator)).toEqual([]);
		});
		expect(continued).toBe(true);
		expect(
			JSON.stringify({
				leases: db.select().from(workspaceWriteLeases).all(),
				scopes: db.select().from(fileChangeScopes).all(),
				operations: db.select().from(fileChangeOperations).all(),
			}),
		).toBe(archived);
	});

	test("settled history is not reported as a blocker", () => {
		const timestamp = now();
		db.insert(narratorToolCalls)
			.values({
				id: generateId(),
				narratorId: ids.narrator,
				messageId: ids.message,
				toolUseId: generateId(),
				toolName: "Read",
				status: "success",
				createdAt: timestamp,
			})
			.run();
		const scopeId = generateId();
		db.insert(fileChangeScopes)
			.values({
				id: scopeId,
				sourceInstanceId: "test-installation",
				deviceId: "local",
				workspaceInstanceId: generateId(),
				canonicalRoot: "/tmp/revert-blockers-workspace",
				displayRoot: "/tmp/revert-blockers-workspace",
				pathFlavor: "posix",
				status: "active",
				activeMutationCount: 0,
				createdAt: timestamp,
				updatedAt: timestamp,
			})
			.run();
		db.insert(workspaceWriteLeases)
			.values({
				leaseId: generateId(),
				scopeId,
				deviceId: "local",
				ownerEpoch: "owner",
				runtimeEpoch: "epoch",
				runtimeGeneration: 1,
				fencingToken: 1,
				scopeRevision: 1,
				pathFlavor: "posix",
				status: "settled",
				rangesJson: { version: 1, ranges: [] },
				mutationManifestJson: { version: 1, mutations: [] },
				executionEndedAt: timestamp,
				createdAt: timestamp,
				updatedAt: timestamp,
			})
			.run();
		expect(collectRevertBlockers(ids.narrator)).toEqual([]);
	});

	test("tool detail never leaks command, file_path, or huge input bodies", () => {
		const timestamp = now();
		const pathOnly = generateId();
		const commandOnly = generateId();
		const longDescription = generateId();
		db.insert(narratorToolCalls)
			.values({
				id: pathOnly,
				narratorId: ids.narrator,
				messageId: ids.message,
				toolUseId: generateId(),
				toolName: "Write",
				inputJson: {
					file_path: "/secret/elsewhere/x.ts",
					content: "y".repeat(10_000),
				},
				status: "running",
				createdAt: timestamp,
			})
			.run();
		db.insert(narratorToolCalls)
			.values({
				id: commandOnly,
				narratorId: ids.narrator,
				messageId: ids.message,
				toolUseId: generateId(),
				toolName: "Bash",
				inputJson: { command: "export TOKEN=abc123 && curl -H auth" },
				status: "running",
				createdAt: timestamp,
			})
			.run();
		db.insert(narratorToolCalls)
			.values({
				id: longDescription,
				narratorId: ids.narrator,
				messageId: ids.message,
				toolUseId: generateId(),
				toolName: "Grep",
				inputJson: { pattern: "TODO", description: "d".repeat(10_000) },
				status: "running",
				createdAt: timestamp,
			})
			.run();
		const blockers = collectRevertBlockers(ids.narrator);
		const pathBlocker = blockers.find((item) => item.toolCallId === pathOnly);
		const commandBlocker = blockers.find((item) => item.toolCallId === commandOnly);
		const descriptionBlocker = blockers.find((item) => item.toolCallId === longDescription);
		expect(pathBlocker?.detail).toBeUndefined();
		expect(commandBlocker?.detail).toBeUndefined();
		expect(descriptionBlocker).toMatchObject({ kind: "running_tool", toolName: "Grep" });
		expect(descriptionBlocker?.detail).toBeUndefined();
		const wire = JSON.stringify(blockers);
		expect(wire).not.toContain("/secret/elsewhere");
		expect(wire).not.toContain("TOKEN=abc123");
		expect(wire).not.toContain("y".repeat(50));
	});

	test("unrelated workspace lease and scope never appear in blockers", () => {
		const timestamp = now();
		const foreignRoot = "/tmp/other-workspace-secret";
		const foreignScopeId = generateId();
		const foreignLeaseId = generateId();
		db.insert(fileChangeScopes)
			.values({
				id: foreignScopeId,
				sourceInstanceId: "test-installation",
				deviceId: "local",
				workspaceInstanceId: generateId(),
				canonicalRoot: foreignRoot,
				displayRoot: foreignRoot,
				pathFlavor: "posix",
				status: "active",
				activeLeaseId: foreignLeaseId,
				activeMutationCount: 3,
				createdAt: timestamp,
				updatedAt: timestamp,
			})
			.run();
		db.insert(workspaceWriteLeases)
			.values({
				leaseId: foreignLeaseId,
				scopeId: foreignScopeId,
				deviceId: "local",
				ownerEpoch: "owner",
				runtimeEpoch: "epoch",
				runtimeGeneration: 1,
				fencingToken: 1,
				scopeRevision: 1,
				pathFlavor: "posix",
				status: "executing",
				rangesJson: { version: 1, ranges: [] },
				mutationManifestJson: { version: 1, mutations: [] },
				createdAt: timestamp,
				updatedAt: timestamp,
			})
			.run();
		const relatedScopeId = generateId();
		const relatedLeaseId = generateId();
		db.insert(fileChangeScopes)
			.values({
				id: relatedScopeId,
				sourceInstanceId: "test-installation",
				deviceId: "local",
				workspaceInstanceId: generateId(),
				canonicalRoot: "/tmp/revert-blockers-workspace",
				displayRoot: "/tmp/revert-blockers-workspace",
				pathFlavor: "posix",
				status: "active",
				activeLeaseId: relatedLeaseId,
				activeMutationCount: 1,
				createdAt: timestamp,
				updatedAt: timestamp,
			})
			.run();
		db.insert(workspaceWriteLeases)
			.values({
				leaseId: relatedLeaseId,
				scopeId: relatedScopeId,
				deviceId: "local",
				ownerEpoch: "owner",
				runtimeEpoch: "epoch",
				runtimeGeneration: 1,
				fencingToken: 1,
				scopeRevision: 1,
				pathFlavor: "posix",
				status: "executing",
				rangesJson: { version: 1, ranges: [] },
				mutationManifestJson: { version: 1, mutations: [] },
				createdAt: timestamp,
				updatedAt: timestamp,
			})
			.run();
		const blockers = collectRevertBlockers(ids.narrator);
		const wire = JSON.stringify(blockers);
		expect(wire).not.toContain("other-workspace-secret");
		expect(wire).not.toContain(foreignLeaseId);
		expect(wire).not.toContain(foreignScopeId);
		expect(blockers).toEqual([]);
		expect(wire).not.toContain(relatedLeaseId);
		// Archived scope metadata is never exposed as a live-work diagnostic.
		expect(wire).not.toContain("/tmp/revert-blockers-workspace");
	});

	test("scope rows can be inspected after insert", () => {
		const timestamp = now();
		const id = generateId();
		db.insert(fileChangeScopes)
			.values({
				id,
				sourceInstanceId: "test-installation",
				deviceId: "local",
				workspaceInstanceId: generateId(),
				canonicalRoot: "/tmp/revert-blockers-workspace",
				displayRoot: "/tmp/revert-blockers-workspace",
				pathFlavor: "posix",
				status: "needs_verification",
				createdAt: timestamp,
				updatedAt: timestamp,
			})
			.run();
		const row = db.select().from(fileChangeScopes).where(eq(fileChangeScopes.id, id)).get();
		expect(row?.status).toBe("needs_verification");
		expect(collectRevertBlockers(ids.narrator)).toEqual([]);
	});
});
