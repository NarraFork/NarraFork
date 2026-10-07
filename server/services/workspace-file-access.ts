import type { WorkspaceContext } from "@shared/workspace-context";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { narrators } from "../db/schema";
import type { ExecutionBackend } from "../lib/agent/execution/backend";
import { resolveBackend } from "../lib/agent/execution/registry";
import { AppError } from "../lib/errors";
import { isSecretPlatformPath, isSecretUserPath } from "../lib/fs-secret-paths";
import { createWorkspaceFileAccess, type WorkspaceFileAccess } from "../lib/plan-file-path";
import { getHome } from "../lib/platform";
import { narraforkDir } from "../lib/settings";
import { getSessionDevices } from "./device-connection-service";
import { executionPolicyEngine } from "./execution-policy/engine";
import type { ExecutionDeviceClass } from "./execution-policy/types";
import { integrationResourceBindingService } from "./integration-resource-binding-service";
import { resolveOAuthNarratorRuntimePolicy } from "./oauth-narrator-runtime-policy";

/** Automatic project reads carry the same frozen device and live authority as tools. */
export function createNarratorWorkspaceFileAccess(
	narratorId: string,
	workspaceContext: WorkspaceContext,
	options: {
		userId?: string | null;
		signal?: AbortSignal;
		backend?: ExecutionBackend;
		authorizationGuard?: () => Promise<void>;
	} = {},
): WorkspaceFileAccess {
	const backend = options.backend ?? resolveBackend({ requested: workspaceContext.deviceId });
	if (backend.deviceId !== workspaceContext.deviceId) throw denied("Workspace backend mismatch");
	const generation = backend.runtimeGeneration;
	return createWorkspaceFileAccess({
		backend,
		workspaceContext,
		signal: options.signal,
		async authorizeRead(canonicalPath, selectedBackend, readSignal) {
			const signal = readSignal ?? options.signal;
			signal?.throwIfAborted();
			if (
				backend.kind === "local" &&
				(isSecretPlatformPath(canonicalPath, narraforkDir) ||
					isSecretUserPath(canonicalPath, getHome()) ||
					backend.paths.contains(narraforkDir, canonicalPath))
			) {
				throw denied("Automatic reads cannot access private platform files");
			}
			await options.authorizationGuard?.();
			const live = resolveBackend({ requested: workspaceContext.deviceId });
			if (
				selectedBackend !== backend ||
				live.runtimeGeneration !== generation ||
				backend.runtimeGeneration !== generation
			)
				throw denied("Workspace execution identity changed");
			const runtime = await resolveOAuthNarratorRuntimePolicy(narratorId, options.userId);
			if (
				runtime &&
				(!runtime.allowedTools.has("Read") ||
					(backend.kind === "local"
						? !runtime.allowLocalExecution
						: !runtime.deviceIds.includes(backend.deviceId)))
			) {
				throw denied("Workspace read is outside the runtime authority");
			}
			let deviceClass: ExecutionDeviceClass | null = backend.kind === "local" ? "host" : null;
			if (backend.kind === "remote") {
				const devices = await getSessionDevices(workspaceContext.contextProjectId, options.userId);
				const device = devices.find((entry) => entry.id === backend.deviceId && entry.online);
				if (!device) throw denied("Workspace device is unavailable or unauthorized");
				if (runtime) {
					const binding = await integrationResourceBindingService.get("device", backend.deviceId);
					deviceClass =
						binding?.sourceType === "oauth_client" &&
						binding.sourceId === runtime.clientId &&
						binding.authorityId === runtime.grantId
							? "selfRegistered"
							: "global";
				}
			}
			if (runtime && (!deviceClass || runtime.policy.deviceAccess[deviceClass] === "denied")) {
				throw denied("Workspace device access is denied by runtime policy");
			}
			const row = await db.query.narrators.findFirst({
				where: eq(narrators.id, narratorId),
				columns: { permissionMode: true },
			});
			if (!row) throw denied("Workspace narrator no longer exists");
			const mode = runtime?.permissionMode ?? row.permissionMode;
			const policy = await executionPolicyEngine.compile(
				narratorId,
				{
					backend,
					paths: backend.paths,
					deviceClass,
					target: {
						deviceId: backend.deviceId,
						backendKind: backend.kind,
						cwd: workspaceContext.cwd,
						lexicalPath: canonicalPath,
						canonicalPath,
						pathFlavor: backend.pathFlavor,
						runtimeGeneration: generation,
						selectionSource: "session_default",
					},
				},
				[],
				signal,
			);
			const decision = policy.evaluatePath({ path: canonicalPath, operation: "read" }).decision;
			if (
				decision === "deny" ||
				(decision !== "allow" &&
					(mode === "dontAsk" || !backend.paths.contains(workspaceContext.cwd, canonicalPath)))
			) {
				throw denied("Automatic read is outside the authorized workspace");
			}
			return true;
		},
	});
}

function denied(message: string) {
	return new AppError(message, 403, "WORKSPACE_READ_DENIED");
}
