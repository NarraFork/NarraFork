import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceContext } from "@shared/workspace-context";
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import {
	fileChangeScopes,
	knowledgePackActivations,
	knowledgePacks,
	narrators,
	narratorWhitelistDirs,
	remoteDevices,
	users,
} from "../../db/schema";
import type { ToolContext, ToolExecutionTarget } from "../../lib/agent/types";
import { generateId } from "../../lib/id";
import { createDevice } from "../device-service";
import { packActivationService } from "../knowledge-pack-activation-service";
import { knowledgePackService } from "../knowledge-pack-service";
import { canWriteNarrator } from "../narrator-acl";
import {
	boundedFixtureCommand,
	startNativeRemoteExecutorFixture,
} from "./native-remote-executor-fixture";

/** Real Go transport, live source ACL, production artifact factory and actual DB publication. */
test("native Pack complete, original fresh-fence cleanup, modified-target retain and failed second file partial evidence", async () => {
	const directory = mkdtempSync(join(tmpdir(), "nf-pack-native-"));
	const userId = generateId();
	const narratorId = generateId();
	const packIds: string[] = [];
	let deviceId: string | undefined;
	let fixture: Awaited<ReturnType<typeof startNativeRemoteExecutorFixture>> | undefined;
	let revision = 0;
	const now = new Date().toISOString();
	try {
		await db.insert(users).values({
			id: userId,
			username: `pack-native-${userId}`,
			role: "admin",
			passwordHash: "fixture",
			createdAt: now,
		});
		const created = await createDevice({
			name: `Native pack ${userId}`,
			connectionMode: "reverse",
			scope: "global",
			ownerScope: "private",
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
		await db.insert(narrators).values({
			id: narratorId,
			ownerUserId: userId,
			visibility: "private",
			writeAudience: "owner",
			defaultDeviceId: deviceId,
			cwd: directory,
			permissionMode: "default",
			traits: ["standalone"],
			createdAt: now,
			updatedAt: now,
		});
		const makePack = async (name: string) => {
			const source = join(directory, `bundle-${name}`);
			mkdirSync(source);
			writeFileSync(join(source, "a.txt"), `a-${name}`);
			writeFileSync(join(source, "b.txt"), `b-${name}`);
			const archive = join(directory, `${name}.tar.gz`);
			await boundedFixtureCommand(["tar", "-czf", archive, "-C", source, "."]);
			const pack = await knowledgePackService.createPack({
				name: `native-${name}-${userId}`,
				ownerUserId: userId,
				archive: new File([await Bun.file(archive).arrayBuffer()], `${name}.tar.gz`, {
					type: "application/gzip",
				}),
			});
			packIds.push(pack.id);
			return pack;
		};
		const context = async (name: string, packId: string) => {
			const selected = join(directory, name);
			mkdirSync(selected);
			const canonical = await backend.resolvePathIdentity(selected, { timeoutMs: 5_000 });
			const workspace: WorkspaceContext = {
				deviceId: backend.deviceId,
				cwd: canonical.canonicalPath,
				pathFlavor: "posix",
				revision: ++revision,
				contextKey: `pack-${name}-${narratorId}`,
				capabilities: { switchDirectory: true },
			};
			await db
				.update(narrators)
				.set({
					cwd: workspace.cwd,
					workspaceRevision: workspace.revision,
					workspaceContext: workspace,
				})
				.where(eq(narrators.id, narratorId));
			const lexical = backend.paths.resolve(workspace.cwd, `.narrafork/packs/${packId}`);
			const identity = await backend.resolvePathIdentity(lexical, { timeoutMs: 5_000 });
			const target: ToolExecutionTarget = {
				deviceId: backend.deviceId,
				backendKind: "remote",
				cwd: workspace.cwd,
				baseCwd: workspace.cwd,
				lexicalPath: lexical,
				canonicalPath: identity.canonicalPath,
				pathFlavor: "posix",
				runtimeGeneration: backend.runtimeGeneration,
				selectionSource: "session_default",
			};
			const ctx = {
				narratorId,
				userId,
				cwd: workspace.cwd,
				workspaceContext: workspace,
				locale: "en",
				signal: AbortSignal.timeout(60_000),
				executionTarget: target,
				executionPlan: {
					kind: "single",
					primaryKey: "primary",
					endpoints: [{ key: "primary", operation: "write", target }],
				},
				recheckAuthorization: async () => {
					const row = await db.query.narrators.findFirst({ where: eq(narrators.id, narratorId) });
					if (!row || !(await canWriteNarrator(row, { userId, isAdmin: true })))
						throw new Error("Actual actor write authority revoked");
				},
				assertWorkspaceCurrent: () => {},
				requestPermission: async () => ({ behavior: "allow" }),
			} as ToolContext;
			return { ctx, root: identity.canonicalPath };
		};
		const principal = { userId, role: "admin" as const };
		// 1. Full native commit publishes actual creation proofs and only a device whitelist.
		const complete = await makePack("complete");
		const first = await context("selected-complete", complete.id);
		const result = await packActivationService.materialize(first.ctx, complete.id, principal);
		expect(result.files.sort()).toEqual(["a.txt", "b.txt"]);
		expect(readFileSync(join(result.extractDir, "a.txt"), "utf8")).toBe("a-complete");
		const active = await db.query.knowledgePackActivations.findFirst({
			where: and(
				eq(knowledgePackActivations.packId, complete.id),
				eq(knowledgePackActivations.status, "active"),
			),
		});
		expect(active?.targetBindingJson).toMatchObject({
			materializationState: "complete",
			actorUserId: userId,
			originalProjectId: null,
			workspace: { deviceId, cwd: first.ctx.workspaceContext?.cwd },
		});
		expect(
			active?.targetBindingJson?.files.every(
				(file) =>
					file.receipt.state === "committed" && file.receipt.binding.sourceInstanceId.length > 0,
			),
		).toBe(true);
		expect(
			await db.query.narratorWhitelistDirs.findFirst({
				where: eq(narratorWhitelistDirs.id, active?.whitelistDirId ?? "missing"),
			}),
		).toMatchObject({ targetKind: "device", targetValue: deviceId });
		// Rebinding the same device must clean A using its proofs, never B's same-named files.
		const replacement = await context("selected-replacement", complete.id);
		mkdirSync(replacement.root, { recursive: true });
		writeFileSync(join(replacement.root, "a.txt"), "replacement-a");
		writeFileSync(join(replacement.root, "b.txt"), "replacement-b");
		// Old records with unknown project provenance are retained, never inferred from B.
		if (!active?.targetBindingJson) throw new Error("Activation binding missing");
		const legacyBinding = { ...active.targetBindingJson };
		Reflect.deleteProperty(legacyBinding, "originalProjectId");
		await db
			.update(knowledgePackActivations)
			.set({ targetBindingJson: legacyBinding })
			.where(eq(knowledgePackActivations.id, active.id));
		await expect(
			packActivationService.deactivate(narratorId, complete.id, replacement.ctx),
		).rejects.toThrow("Pack cleanup proof/original creator is unavailable");
		expect(readFileSync(join(first.root, "a.txt"), "utf8")).toBe("a-complete");
		await db
			.update(knowledgePackActivations)
			.set({ targetBindingJson: active.targetBindingJson })
			.where(eq(knowledgePackActivations.id, active.id));
		// An unavailable original root must retain the activation and never fall back to B.
		const originalRoot = first.ctx.workspaceContext?.cwd as string;
		renameSync(originalRoot, `${originalRoot}-unavailable`);
		try {
			await expect(
				packActivationService.deactivate(narratorId, complete.id, replacement.ctx),
			).rejects.toThrow();
			expect(
				await db.query.knowledgePackActivations.findFirst({
					where: eq(knowledgePackActivations.id, active?.id ?? "missing"),
				}),
			).toMatchObject({ status: "active" });
			expect(readFileSync(join(replacement.root, "a.txt"), "utf8")).toBe("replacement-a");
		} finally {
			renameSync(`${originalRoot}-unavailable`, originalRoot);
		}
		// New cleanup lease has a fresh fence; immutable original creation proof remains valid.
		expect(
			await packActivationService.deactivate(narratorId, complete.id, replacement.ctx),
		).toEqual({
			released: true,
		});
		expect(await Bun.file(join(first.root, "a.txt")).exists()).toBe(false);
		expect(await Bun.file(join(first.root, "b.txt")).exists()).toBe(false);
		expect(readFileSync(join(replacement.root, "a.txt"), "utf8")).toBe("replacement-a");
		expect(readFileSync(join(replacement.root, "b.txt"), "utf8")).toBe("replacement-b");
		const originalProofs = active?.targetBindingJson?.files.map((file) => file.receipt) ?? [];
		const scope = await db.query.fileChangeScopes.findFirst({
			where: eq(fileChangeScopes.id, originalProofs[0]?.binding.scopeId ?? "missing"),
		});
		expect(scope?.fencingToken ?? 0).toBeGreaterThan(
			Math.max(...originalProofs.map((proof) => proof.binding.fence)),
		);
		const released = await db.query.knowledgePackActivations.findFirst({
			where: eq(knowledgePackActivations.id, active?.id ?? "missing"),
		});
		expect(released?.targetBindingJson?.files.map((file) => file.receipt)).toEqual(originalProofs);
		// 2. A replacement/modification is not treated as this activation's original object.
		const modified = await makePack("modified");
		const second = await context("selected-modified", modified.id);
		await packActivationService.materialize(second.ctx, modified.id, principal);
		await backend.writeFileBytes(join(second.root, "a.txt"), Buffer.from("new-owner-content"));
		await expect(
			packActivationService.deactivate(narratorId, modified.id, second.ctx),
		).rejects.toThrow();
		expect(readFileSync(join(second.root, "a.txt"), "utf8")).toBe("new-owner-content");
		expect(
			await db.query.knowledgePackActivations.findFirst({
				where: and(
					eq(knowledgePackActivations.packId, modified.id),
					eq(knowledgePackActivations.status, "active"),
				),
			}),
		).toBeDefined();
		// 3. Native no-overwrite conflict on b happens after a has its own persisted proof.
		const partial = await makePack("partial");
		const third = await context("selected-partial", partial.id);
		mkdirSync(third.root, { recursive: true });
		writeFileSync(join(third.root, "b.txt"), "preexisting-unowned");
		await expect(
			packActivationService.materialize(third.ctx, partial.id, principal),
		).rejects.toThrow();
		const rows = await db.query.knowledgePackActivations.findMany({
			where: eq(knowledgePackActivations.packId, partial.id),
			limit: 10,
		});
		expect(rows.some((row) => row.status === "active")).toBe(false);
		expect(rows.every((row) => row.status === "partial" && row.whitelistDirId === null)).toBe(true);
		expect(
			rows
				.flatMap((row) => row.targetBindingJson?.files ?? [])
				.some((file) => file.relativePath === "a.txt" && file.receipt.state === "committed"),
		).toBe(true);
		expect(readFileSync(join(third.root, "a.txt"), "utf8")).toBe("a-partial");
		expect(readFileSync(join(third.root, "b.txt"), "utf8")).toBe("preexisting-unowned");
		expect(
			await db.query.narratorWhitelistDirs.findFirst({
				where: eq(narratorWhitelistDirs.path, third.root),
			}),
		).toBeUndefined();
		fixture.assertHealthy();
		expect(fixture.trace.some((call) => call.method.startsWith("attachment."))).toBe(true);
	} finally {
		await fixture?.dispose();
		await db.delete(narratorWhitelistDirs).where(eq(narratorWhitelistDirs.narratorId, narratorId));
		await db
			.delete(knowledgePackActivations)
			.where(eq(knowledgePackActivations.narratorId, narratorId));
		for (const id of packIds) await db.delete(knowledgePacks).where(eq(knowledgePacks.id, id));
		await db.delete(narrators).where(eq(narrators.id, narratorId));
		if (deviceId) await db.delete(remoteDevices).where(eq(remoteDevices.id, deviceId));
		await db.delete(users).where(eq(users.id, userId));
		rmSync(directory, { recursive: true, force: true });
	}
}, 120_000);
