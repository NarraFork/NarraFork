import { createHash } from "node:crypto";
import type {
	NarratorDeviceWorkspaceBinding,
	WorkspaceBindingReference,
	WorkspaceContext,
} from "@shared/workspace-context";
import { and, eq } from "drizzle-orm";
import type { db } from "../db";
import { narratorDeviceWorkspaces } from "../db/schema";
import { generateId } from "../lib/id";
import { workspaceConflict } from "./workspace-context-transition";

export type DeviceWorkspaceTransaction = Pick<typeof db, "insert" | "select" | "update">;

export function deviceWorkspaceBindingContext(
	narratorId: string,
	id: string,
	bindingRevision: number,
	context: WorkspaceContext,
): WorkspaceContext & { binding: WorkspaceBindingReference } {
	const { binding: _foreignBinding, ...endpoint } = context;
	return {
		...endpoint,
		binding: {
			version: 1,
			bindingId: id,
			narratorId,
			deviceId: context.deviceId,
			bindingRevision,
			bindingKey: createHash("sha256")
				.update(
					JSON.stringify([
						"narrator-device-workspace/v1",
						narratorId,
						id,
						context.deviceId,
						bindingRevision,
						context.contextKey,
						context.cwd,
						context.pathFlavor,
						context.nativeRootDescriptor ?? null,
					]),
				)
				.digest("hex"),
		},
	};
}

export function readDeviceWorkspaceBinding(
	tx: Pick<typeof db, "select">,
	narratorId: string,
	deviceId: string,
): NarratorDeviceWorkspaceBinding | null {
	const row = tx
		.select()
		.from(narratorDeviceWorkspaces)
		.where(
			and(
				eq(narratorDeviceWorkspaces.narratorId, narratorId),
				eq(narratorDeviceWorkspaces.deviceId, deviceId),
			),
		)
		.get();
	return row
		? {
				id: row.id,
				narratorId: row.narratorId,
				deviceId: row.deviceId,
				bindingRevision: row.bindingRevision,
				context: row.workspaceContext,
				createdAt: row.createdAt,
				updatedAt: row.updatedAt,
			}
		: null;
}

/** Only an explicit, trusted endpoint may seed a binding; no device defaults are consulted. */
export function insertInitialDeviceWorkspaceBinding(
	tx: DeviceWorkspaceTransaction,
	input: { narratorId: string; context: WorkspaceContext; createdAt: string },
): WorkspaceContext {
	const context = deviceWorkspaceBindingContext(input.narratorId, generateId(), 1, input.context);
	tx.insert(narratorDeviceWorkspaces)
		.values({
			id: context.binding.bindingId,
			narratorId: input.narratorId,
			deviceId: context.deviceId,
			bindingRevision: 1,
			cwd: context.cwd,
			pathFlavor: context.pathFlavor,
			workspaceContext: context,
			createdAt: input.createdAt,
			updatedAt: input.createdAt,
		})
		.run();
	return context;
}

/** Used by the legacy switch, within its existing projection/receipt transaction. */
export function saveLegacyDeviceWorkspaceBinding(
	tx: DeviceWorkspaceTransaction,
	narratorId: string,
	context: WorkspaceContext,
): WorkspaceContext {
	const prior = readDeviceWorkspaceBinding(tx, narratorId, context.deviceId);
	if (!prior)
		return insertInitialDeviceWorkspaceBinding(tx, {
			narratorId,
			context,
			createdAt: new Date().toISOString(),
		});
	if (
		prior.context.contextKey === context.contextKey &&
		JSON.stringify(prior.context.nativeRootDescriptor) ===
			JSON.stringify(context.nativeRootDescriptor)
	)
		return { ...context, binding: prior.context.binding };
	const next = deviceWorkspaceBindingContext(
		narratorId,
		prior.id,
		prior.bindingRevision + 1,
		context,
	);
	const rows = tx
		.update(narratorDeviceWorkspaces)
		.set({
			bindingRevision: prior.bindingRevision + 1,
			cwd: next.cwd,
			pathFlavor: next.pathFlavor,
			workspaceContext: next,
			updatedAt: new Date().toISOString(),
		})
		.where(
			and(
				eq(narratorDeviceWorkspaces.id, prior.id),
				eq(narratorDeviceWorkspaces.bindingRevision, prior.bindingRevision),
			),
		)
		.returning({ id: narratorDeviceWorkspaces.id })
		.all();
	if (rows.length !== 1) throw workspaceConflict("Device workspace binding changed");
	return next;
}
