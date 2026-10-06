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
				expect(collectRevertBlockers(ids.narrator)).toEqual([
					{ kind: "narrator_busy", detail: "admission work still settling" },
				]);
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
				detail: "Another revert preview preparation is already running",
			},
		]);
	});

	test("names this narrator's running tool and a same-workspace foreign writer", () => {
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
		expect(blockers.find((item) => item.toolCallId === mine)).toMatchObject({
			kind: "running_tool",
			toolName: "Bash",
			detail: "long bash",
		});
		const foreignBlocker = blockers.find((item) => item.toolCallId === foreign);
		expect(foreignBlocker).toMatchObject({
			kind: "uncoordinated_activity",
			toolName: "Edit",
		});
		// Same-workspace concurrent writer is kept, but never via file_path text.
		expect(foreignBlocker?.detail ?? "").not.toContain("shared.ts");
		expect(JSON.stringify(blockers)).not.toContain("sleep 30");
	});

	test("names unsettled file-change operations and open write leases", () => {
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
		const blockers = collectRevertBlockers(ids.narrator);
		expect(blockers.find((item) => item.operationId === operationId)).toMatchObject({
			kind: "pending_operation",
		});
		expect(
			blockers.find((item) => item.leaseId === leaseId && item.kind === "write_lease"),
		).toBeTruthy();
		expect(
			blockers.find((item) => item.kind === "pending_mutation" && item.detail?.includes("2")),
		).toBeTruthy();
		// Scope identity is the leaseId, not the absolute workspace root.
		expect(JSON.stringify(blockers)).not.toContain("/tmp/revert-blockers-workspace");
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
		expect(descriptionBlocker?.detail?.length).toBeLessThanOrEqual(160);
		expect(descriptionBlocker?.detail?.startsWith("d")).toBe(true);
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
		expect(blockers.some((item) => item.leaseId === relatedLeaseId)).toBe(true);
		// Related scope is reported, but never through its absolute displayRoot.
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
	});
});
