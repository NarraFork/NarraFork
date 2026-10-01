import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { narratorToolCalls } from "../db/schema";
import type { ExecutionBackend } from "../lib/agent/execution/backend";
import type { ToolContext } from "../lib/agent/types";
import { ensureFileSnapshot } from "./file-snapshot-service";

/** Legacy evidence only: remote execution has no local tree/v2 settlement. */
export async function prepareRemoteStructSedChange(
	ctx: ToolContext,
	backend: ExecutionBackend,
	filePath: string,
	input: Record<string, unknown>,
	before: { content: string | null; encoding: string },
): Promise<void> {
	const binding = ctx.toolCallBinding;
	const target = ctx.executionTarget;
	if (
		!binding ||
		!target ||
		backend.kind === "local" ||
		target.deviceId !== backend.deviceId ||
		target.backendKind !== backend.kind ||
		target.pathFlavor !== backend.pathFlavor ||
		target.runtimeGeneration !== backend.runtimeGeneration ||
		!target.canonicalPath ||
		!target.lexicalPath ||
		!backend.paths.equals(target.canonicalPath, filePath)
	) {
		throw new Error(
			"StructSed requires a real recorded tool call and frozen remote target to write",
		);
	}
	const assertBinding = () => {
		const row = db
			.select({
				executionIdentityVersion: narratorToolCalls.executionIdentityVersion,
				executionOriginToolCallId: narratorToolCalls.executionOriginToolCallId,
				isFileHistoryCheckpoint: narratorToolCalls.isFileHistoryCheckpoint,
				executionAttempt: narratorToolCalls.executionAttempt,
				narratorId: narratorToolCalls.narratorId,
				toolUseId: narratorToolCalls.toolUseId,
				toolName: narratorToolCalls.toolName,
				status: narratorToolCalls.status,
				executionStartedAt: narratorToolCalls.executionStartedAt,
				executionDeviceId: narratorToolCalls.executionDeviceId,
				executionCwd: narratorToolCalls.executionCwd,
				executionPathFlavor: narratorToolCalls.executionPathFlavor,
				resolvedFilePath: narratorToolCalls.resolvedFilePath,
				canonicalFilePath: narratorToolCalls.canonicalFilePath,
				runtimeGeneration: narratorToolCalls.runtimeGeneration,
			})
			.from(narratorToolCalls)
			.where(eq(narratorToolCalls.id, binding.toolCallId))
			.get();
		if (
			!row ||
			row.executionIdentityVersion !== 1 ||
			row.executionOriginToolCallId !== null ||
			row.isFileHistoryCheckpoint ||
			row.executionAttempt !== binding.attempt ||
			!Number.isSafeInteger(binding.attempt) ||
			binding.attempt < 1 ||
			row.narratorId !== ctx.narratorId ||
			row.toolUseId !== ctx.currentToolUseId ||
			row.toolName !== "StructSed" ||
			row.status !== "running" ||
			row.executionStartedAt === null ||
			row.executionDeviceId !== target.deviceId ||
			row.executionCwd !== target.cwd ||
			row.executionPathFlavor !== target.pathFlavor ||
			row.resolvedFilePath !== target.lexicalPath ||
			row.canonicalFilePath !== target.canonicalPath ||
			row.runtimeGeneration !== target.runtimeGeneration
		) {
			throw new Error(
				"StructSed tool-call row/attempt does not match its authorized remote execution",
			);
		}
		ctx.signal?.throwIfAborted();
	};
	assertBinding();
	await ensureFileSnapshot(
		ctx.narratorId,
		backend.deviceId,
		filePath,
		async () => before,
		"required",
	);
	assertBinding();
	// Persist ALL resolved operations before dispatch, including the device identity.
	// The RPC may finish after a transport failure; retained input is recovery evidence,
	// not a claim that the mutation succeeded.
	await db
		.update(narratorToolCalls)
		.set({
			inputJson: {
				...input,
				device: backend.deviceId,
				file_path: filePath,
			},
		})
		.where(
			and(
				eq(narratorToolCalls.id, binding.toolCallId),
				eq(narratorToolCalls.executionAttempt, binding.attempt),
			),
		);
	assertBinding();
}
