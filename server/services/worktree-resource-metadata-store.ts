import { createHash } from "node:crypto";
import { and, eq, gt, type SQLWrapper, sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { z } from "zod";
import * as schema from "../db/schema";
import {
	type CurrentResourceAuthority,
	createWorktreeResourceAccess,
	validateResourceAuthority,
	type WorktreeResourceAccessPorts,
	type WorktreeResourceAuthorization,
	WorktreeResourceError,
	type WorktreeResourceRecord,
} from "./worktree-resource-owner";

export const RESOURCE_METADATA_REQUEST_BYTES = 16 * 1024;
export const RESOURCE_METADATA_SUMMARY_BYTES = 256 * 1024;
export const RESOURCE_METADATA_PAGE_SIZE = 128;
const MAX_RECEIPTS = 256;
// Return a sentinel rather than reading an oversized identifier into the JS heap.
const summaryIdentifier = (column: SQLWrapper) =>
	sql<
		string | null
	>`case when length(cast(${column} as blob)) <= 1024 then ${column} else null end`;
const id = z.string().min(1).max(256);
const config = z
	.object({
		composeFile: z.string().min(1).max(4096),
		projectName: z.string().min(1).max(256).optional(),
		proxyDomain: z.string().min(1).max(256).optional(),
	})
	.strict();
const actionSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("config"), config: config.nullable() }).strict(),
	z.object({ kind: z.literal("terminal"), id, name: z.string().min(1).max(256) }).strict(),
	z.object({ kind: z.literal("container"), id, serviceName: z.string().min(1).max(256) }).strict(),
	z
		.object({
			kind: z.literal("port"),
			port: z.number().int().min(1).max(65535),
			serviceName: z.string().min(1).max(256),
		})
		.strict(),
	z
		.object({
			kind: z.literal("layout"),
			id,
			layout: z.enum(["single", "split-h", "split-v", "triple", "quad"]),
		})
		.strict(),
]);
export type ResourceMetadataAction = z.infer<typeof actionSchema>;
const requestSchema = z
	.object({
		requestId: id,
		worktreeResourceId: id,
		expectedRevision: z.number().int().nonnegative(),
		actions: z.array(actionSchema).min(1).max(128),
	})
	.strict();

/** Bound traversal BEFORE stringify/hash to avoid synchronously processing a giant BLOB. */
export function boundedMetadataJson(value: unknown, maxBytes: number): string {
	let nodes = 0;
	let bytes = 0;
	const visit = (item: unknown, depth: number): void => {
		if (++nodes > 2048 || depth > 8) throw new WorktreeResourceError("RESOURCE_METADATA_TOO_LARGE");
		if (typeof item === "string") {
			if (item.length > maxBytes) throw new WorktreeResourceError("RESOURCE_METADATA_TOO_LARGE");
			bytes += Buffer.byteLength(item);
		} else if (Array.isArray(item)) {
			if (item.length > 129) throw new WorktreeResourceError("RESOURCE_METADATA_TOO_LARGE");
			for (const child of item) visit(child, depth + 1);
		} else if (item && typeof item === "object") {
			if (Object.getPrototypeOf(item) !== Object.prototype)
				throw new WorktreeResourceError("RESOURCE_METADATA_INVALID");
			const keys = Object.keys(item);
			if (keys.length > 32) throw new WorktreeResourceError("RESOURCE_METADATA_TOO_LARGE");
			for (const key of keys) {
				visit(key, depth + 1);
				visit((item as Record<string, unknown>)[key], depth + 1);
			}
		} else if (item !== null && typeof item !== "boolean" && typeof item !== "number") {
			throw new WorktreeResourceError("RESOURCE_METADATA_INVALID");
		}
		if (bytes > maxBytes) throw new WorktreeResourceError("RESOURCE_METADATA_TOO_LARGE");
	};
	visit(value, 0);
	const json = JSON.stringify(value);
	if (Buffer.byteLength(json) > maxBytes)
		throw new WorktreeResourceError("RESOURCE_METADATA_TOO_LARGE");
	return json;
}

const resourceProjection = {
	id: schema.narratorWorktreeResources.id,
	ownerNarratorId: schema.narratorWorktreeResources.ownerNarratorId,
	deviceId: schema.narratorWorktreeResources.deviceId,
	repositoryKey: schema.narratorWorktreeResources.repositoryKey,
	worktreePath: schema.narratorWorktreeResources.worktreePath,
	state: schema.narratorWorktreeResources.state,
	scopeKind: schema.narratorWorktreeResources.scopeKind,
	scopeProjectId: schema.narratorWorktreeResources.scopeProjectId,
	scopeOwnerUserId: schema.narratorWorktreeResources.scopeOwnerUserId,
	ownershipRevision: schema.narratorWorktreeResources.ownershipRevision,
	createRequestId: schema.narratorWorktreeResources.createRequestId,
	createdAt: schema.narratorWorktreeResources.createdAt,
};

function resourceIncarnationDigest(resource: WorktreeResourceRecord): string {
	if (!resource.createRequestId || !resource.createdAt)
		throw new WorktreeResourceError("RESOURCE_INCARNATION_UNVERIFIED");
	return createHash("sha256")
		.update(
			boundedMetadataJson(
				[
					resource.id,
					resource.createRequestId,
					resource.createdAt,
					resource.ownerNarratorId,
					resource.deviceId,
					resource.worktreePath,
					resource.repositoryKey,
					resource.state,
					resource.scopeKind,
					resource.scopeProjectId,
					resource.scopeOwnerUserId,
					resource.ownershipRevision,
				],
				RESOURCE_METADATA_REQUEST_BYTES,
			),
		)
		.digest("hex");
}

function authorityBindingDigest(auth: CurrentResourceAuthority): string {
	return createHash("sha256")
		.update(
			boundedMetadataJson(
				[
					auth.actorUserId,
					auth.scopeOwnerUserId,
					auth.contextProjectId,
					auth.rootNarratorId,
					auth.sessionNarratorId,
					auth.sessionType,
					auth.sessionAclRootNarratorId,
					auth.sourceNarratorId,
					auth.sourceRootNarratorId,
					auth.basis,
					auth.backend,
					auth.workspaceKind,
					auth.workspaceMode,
					auth.deviceId,
					auth.canonicalWorktreePath,
					auth.repositoryKey,
					auth.complete,
					auth.readAllowed,
					auth.writeAllowed,
					auth.projectAllowed,
					auth.deviceAllowed,
					auth.oauthAllowed,
					auth.executionAllowed,
				],
				RESOURCE_METADATA_REQUEST_BYTES,
			),
		)
		.digest("hex");
}

export interface ResourceMetadataFixturePorts {
	/** Deliberately no production adapter or default singleton. Runtime remains disabled. */
	mode: "isolatedFixture";
	database: BunSQLiteDatabase<typeof schema>;
	access: WorktreeResourceAccessPorts;
	/** Must read CURRENT verified authority synchronously within the atomic fixture commit.
	 * This is not an authorization DTO supplied by the request; stale cached grants are forbidden.
	 */
	currentAuthority(resource: WorktreeResourceRecord): CurrentResourceAuthority | null;
}

/** Metadata-only fixtures: terminals are EXITED, containers STOPPED, no compose/PTY/restore.
 * Application history is read-only; inserting appliedAt would falsely attest a volume restore.
 * Each bounded synchronous transaction rolls back only its own writes, including port conflicts.
 */
export function createWorktreeResourceMetadataStore(ports: ResourceMetadataFixturePorts) {
	const access = createWorktreeResourceAccess(ports.access);
	const receipts = new Map<
		string,
		{
			digest: string;
			resourceId: string;
			actorUserId: string;
			incarnationDigest: string;
			authorityDigest: string;
			count: number;
		}
	>();
	const database = ports.database;
	const assertFixture = () => {
		if (ports.mode !== "isolatedFixture" || ports.access.backend !== "sqlite")
			throw new WorktreeResourceError("RESOURCE_CAPABILITY_UNSUPPORTED");
	};
	const checkCurrent = (
		resourceId: string,
		revision: number,
		signal?: AbortSignal,
		need: "read" | "write" = "write",
		expected?: WorktreeResourceAuthorization,
	): WorktreeResourceAuthorization => {
		if (signal?.aborted) throw new WorktreeResourceError("RESOURCE_AUTH_CANCELLED");
		const resource = database
			.select(resourceProjection)
			.from(schema.narratorWorktreeResources)
			.where(eq(schema.narratorWorktreeResources.id, resourceId))
			.limit(1)
			.get();
		if (!resource) throw new WorktreeResourceError("RESOURCE_NOT_FOUND");
		if (resource.ownershipRevision !== revision)
			throw new WorktreeResourceError("RESOURCE_REVISION_STALE");
		const loadedAuthority = ports.currentAuthority({ ...resource });
		const authority = loadedAuthority ? { ...loadedAuthority } : null;
		validateResourceAuthority(resource, authority, need);
		if (!authority) throw new WorktreeResourceError("RESOURCE_ACCESS_DENIED");
		if (expected) {
			if (resourceIncarnationDigest(resource) !== resourceIncarnationDigest(expected.resource))
				throw new WorktreeResourceError("RESOURCE_INCARNATION_CHANGED");
			if (authority.actorUserId !== expected.authority.actorUserId)
				throw new WorktreeResourceError("RESOURCE_ACTOR_CHANGED");
			if (authorityBindingDigest(authority) !== authorityBindingDigest(expected.authority))
				throw new WorktreeResourceError("RESOURCE_AUTHORITY_CHANGED");
		}
		if (signal?.aborted) throw new WorktreeResourceError("RESOURCE_AUTH_CANCELLED");
		const afterAuthority = database
			.select(resourceProjection)
			.from(schema.narratorWorktreeResources)
			.where(eq(schema.narratorWorktreeResources.id, resourceId))
			.limit(1)
			.get();
		if (
			!afterAuthority ||
			resourceIncarnationDigest(afterAuthority) !== resourceIncarnationDigest(resource)
		)
			throw new WorktreeResourceError("RESOURCE_INCARNATION_CHANGED");
		return { resource, authority };
	};
	return {
		async write(
			input: unknown,
			signal?: AbortSignal,
		): Promise<{ count: number; replayed: boolean }> {
			assertFixture();
			const json = boundedMetadataJson(input, RESOURCE_METADATA_REQUEST_BYTES);
			const parsed = requestSchema.safeParse(input);
			if (!parsed.success) throw new WorktreeResourceError("RESOURCE_METADATA_INVALID");
			const request = parsed.data;
			const digest = createHash("sha256").update(json).digest("hex");
			const authorized = await access.authorizeSnapshot(
				{ worktreeResourceId: request.worktreeResourceId },
				request.expectedRevision,
				"write",
				signal,
			);
			const incarnationDigest = resourceIncarnationDigest(authorized.resource);
			const authorityDigest = authorityBindingDigest(authorized.authority);
			const result = database.transaction((tx) => {
				const current = checkCurrent(
					request.worktreeResourceId,
					request.expectedRevision,
					signal,
					"write",
					authorized,
				);
				const { resource, authority: auth } = current;
				const receipt = receipts.get(request.requestId);
				if (receipt) {
					if (
						receipt.digest !== digest ||
						receipt.resourceId !== resource.id ||
						receipt.actorUserId !== auth.actorUserId ||
						receipt.incarnationDigest !== incarnationDigest ||
						receipt.authorityDigest !== authorityDigest
					)
						throw new WorktreeResourceError("RESOURCE_IDEMPOTENCY_CONFLICT");
					checkCurrent(resource.id, request.expectedRevision, signal, "write", authorized);
					return { count: receipt.count, replayed: true, actorUserId: auth.actorUserId };
				}
				if (receipts.size >= MAX_RECEIPTS)
					throw new WorktreeResourceError("RESOURCE_RECEIPT_CAPACITY");
				const now = new Date().toISOString();
				for (const action of request.actions) {
					checkCurrent(resource.id, request.expectedRevision, signal, "write", authorized);
					switch (action.kind) {
						case "config": {
							const changed = tx
								.update(schema.narratorWorktreeResources)
								.set({ containerConfig: action.config, updatedAt: now })
								.where(
									and(
										eq(schema.narratorWorktreeResources.id, resource.id),
										eq(schema.narratorWorktreeResources.createRequestId, resource.createRequestId),
										eq(schema.narratorWorktreeResources.createdAt, resource.createdAt),
										eq(
											schema.narratorWorktreeResources.ownershipRevision,
											request.expectedRevision,
										),
									),
								)
								.returning({ id: schema.narratorWorktreeResources.id })
								.get();
							if (!changed) throw new WorktreeResourceError("RESOURCE_INCARNATION_CHANGED");
							break;
						}
						case "terminal":
							tx.insert(schema.terminals)
								.values({
									id: action.id,
									worktreeResourceId: resource.id,
									chapterId: null,
									narratorId: null,
									name: action.name,
									status: "exited",
									createdAt: now,
								})
								.run();
							break;
						case "container":
							tx.insert(schema.containerInstances)
								.values({
									id: action.id,
									worktreeResourceId: resource.id,
									chapterId: null,
									serviceName: action.serviceName,
									status: "stopped",
									createdAt: now,
									updatedAt: now,
								})
								.run();
							break;
						case "port":
							tx.insert(schema.portAllocations)
								.values({
									port: action.port,
									worktreeResourceId: resource.id,
									chapterId: null,
									serviceName: action.serviceName,
									allocatedAt: now,
								})
								.run();
							break;
						case "layout": {
							const existing = tx
								.select({ id: schema.terminalViewState.id })
								.from(schema.terminalViewState)
								.where(
									and(
										eq(schema.terminalViewState.worktreeResourceId, resource.id),
										eq(schema.terminalViewState.userId, auth.actorUserId),
									),
								)
								.limit(1)
								.get();
							if (existing)
								tx.update(schema.terminalViewState)
									.set({ layout: action.layout, updatedAt: now })
									.where(eq(schema.terminalViewState.id, existing.id))
									.run();
							else
								tx.insert(schema.terminalViewState)
									.values({
										id: action.id,
										userId: auth.actorUserId,
										worktreeResourceId: resource.id,
										chapterId: null,
										narratorId: null,
										layout: action.layout,
										updatedAt: now,
									})
									.run();
							break;
						}
					}
				}
				checkCurrent(resource.id, request.expectedRevision, signal, "write", authorized);
				// Receipts are installed only after a successful DB commit below.
				return { count: request.actions.length, replayed: false, actorUserId: auth.actorUserId };
			});
			if (!result.replayed)
				receipts.set(request.requestId, {
					digest,
					resourceId: request.worktreeResourceId,
					actorUserId: result.actorUserId,
					incarnationDigest,
					authorityDigest,
					count: result.count,
				});
			return { count: result.count, replayed: result.replayed };
		},
		async summary(
			resourceId: string,
			revision: number,
			kind: "config" | "terminal" | "container" | "port" | "layout" | "application",
			cursor?: string,
			signal?: AbortSignal,
		) {
			assertFixture();
			if (cursor !== undefined && (cursor.length > 256 || !cursor))
				throw new WorktreeResourceError("RESOURCE_CURSOR_INVALID");
			const authorized = await access.authorizeSnapshot(
				{ worktreeResourceId: resourceId },
				revision,
				"read",
				signal,
			);
			checkCurrent(resourceId, revision, signal, "read", authorized);
			let rows: Array<Record<string, unknown>>;
			switch (kind) {
				case "config":
					rows = database
						.select({
							id: schema.narratorWorktreeResources.id,
							hasConfig:
								sql<boolean>`${schema.narratorWorktreeResources.containerConfig} is not null`.mapWith(
									Boolean,
								),
							configBytes: sql<number>`coalesce(length(cast(${schema.narratorWorktreeResources.containerConfig} as blob)), 0)`,
						})
						.from(schema.narratorWorktreeResources)
						.where(eq(schema.narratorWorktreeResources.id, resourceId))
						.limit(1)
						.all();
					break;
				case "terminal":
					rows = database
						.select({
							id: summaryIdentifier(schema.terminals.id),
							name: sql<string>`substr(${schema.terminals.name}, 1, 256)`,
							hasNameDetails: sql<boolean>`substr(${schema.terminals.name}, 257, 1) <> ''`.mapWith(
								Boolean,
							),
							status: schema.terminals.status,
						})
						.from(schema.terminals)
						.where(
							and(
								eq(schema.terminals.worktreeResourceId, resourceId),
								cursor ? gt(schema.terminals.id, cursor) : undefined,
							),
						)
						.orderBy(schema.terminals.id)
						.limit(RESOURCE_METADATA_PAGE_SIZE + 1)
						.all();
					break;
				case "container":
					rows = database
						.select({
							id: summaryIdentifier(schema.containerInstances.id),
							serviceName: sql<string>`substr(${schema.containerInstances.serviceName}, 1, 256)`,
							status: schema.containerInstances.status,
						})
						.from(schema.containerInstances)
						.where(
							and(
								eq(schema.containerInstances.worktreeResourceId, resourceId),
								cursor ? gt(schema.containerInstances.id, cursor) : undefined,
							),
						)
						.orderBy(schema.containerInstances.id)
						.limit(RESOURCE_METADATA_PAGE_SIZE + 1)
						.all();
					break;
				case "port": {
					if (cursor && !/^\d{1,5}$/.test(cursor))
						throw new WorktreeResourceError("RESOURCE_CURSOR_INVALID");
					rows = database
						.select({
							id: schema.portAllocations.port,
							serviceName: sql<
								string | null
							>`substr(${schema.portAllocations.serviceName}, 1, 256)`,
						})
						.from(schema.portAllocations)
						.where(
							and(
								eq(schema.portAllocations.worktreeResourceId, resourceId),
								cursor ? gt(schema.portAllocations.port, Number(cursor)) : undefined,
							),
						)
						.orderBy(schema.portAllocations.port)
						.limit(RESOURCE_METADATA_PAGE_SIZE + 1)
						.all();
					break;
				}
				case "layout": {
					const { authority: auth } = checkCurrent(
						resourceId,
						revision,
						signal,
						"read",
						authorized,
					);
					rows = database
						.select({
							id: summaryIdentifier(schema.terminalViewState.id),
							layout: sql<string>`substr(${schema.terminalViewState.layout}, 1, 16)`,
						})
						.from(schema.terminalViewState)
						.where(
							and(
								eq(schema.terminalViewState.worktreeResourceId, resourceId),
								eq(schema.terminalViewState.userId, auth.actorUserId),
								cursor ? gt(schema.terminalViewState.id, cursor) : undefined,
							),
						)
						.orderBy(schema.terminalViewState.id)
						.limit(RESOURCE_METADATA_PAGE_SIZE + 1)
						.all();
					break;
				}
				case "application":
					rows = database
						.select({
							id: summaryIdentifier(schema.volumeSnapshotApplications.id),
							snapshotId: summaryIdentifier(schema.volumeSnapshotApplications.snapshotId),
							appliedAt: sql<string>`substr(${schema.volumeSnapshotApplications.appliedAt}, 1, 64)`,
						})
						.from(schema.volumeSnapshotApplications)
						.where(
							and(
								eq(schema.volumeSnapshotApplications.targetWorktreeResourceId, resourceId),
								cursor ? gt(schema.volumeSnapshotApplications.id, cursor) : undefined,
							),
						)
						.orderBy(schema.volumeSnapshotApplications.id)
						.limit(RESOURCE_METADATA_PAGE_SIZE + 1)
						.all();
					break;
				default:
					throw new WorktreeResourceError("RESOURCE_METADATA_INVALID");
			}
			checkCurrent(resourceId, revision, signal, "read", authorized);
			if (
				rows.some((row) => row.id === null || (kind === "application" && row.snapshotId === null))
			)
				throw new WorktreeResourceError("RESOURCE_METADATA_TOO_LARGE");
			const page = rows.slice(0, RESOURCE_METADATA_PAGE_SIZE);
			const result = {
				rows: page,
				hasMore: rows.length > RESOURCE_METADATA_PAGE_SIZE,
				nextCursor: rows.length > RESOURCE_METADATA_PAGE_SIZE ? String(page.at(-1)?.id) : null,
			};
			boundedMetadataJson(result, RESOURCE_METADATA_SUMMARY_BYTES);
			return result;
		},
	};
}
