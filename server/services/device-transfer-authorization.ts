import { eq } from "drizzle-orm";
import { db } from "../db";
import { narrators } from "../db/schema";
import type { ToolContext } from "../lib/agent/types";
import { isSecretPlatformPath, isSecretUserPath } from "../lib/fs-secret-paths";
import { getHome } from "../lib/platform";
import { narraforkDir } from "../lib/settings";
import { executionPolicyEngine } from "./execution-policy/engine";
import { createExecutionTargetContext } from "./execution-policy/target-context";

/** A directory approval grants descendants only within its frozen two-endpoint scope.
 * Explicit denies and secret paths are not inherited approvals. Background tools
 * cannot retain this actor/endpoint fence across restarts and are rejected by the tool.
 */
export async function createRecursiveTransferAuthorization(
	ctx: ToolContext,
	direction: "upload" | "download",
	deviceId: string,
) {
	const plan = ctx.executionPlan ? structuredClone(ctx.executionPlan) : undefined;
	const recheck = ctx.recheckAuthorization;
	const fence = ctx.assertWorkspaceCurrent;
	const resolve = ctx.resolveBackend;
	if (!plan || !recheck || !fence || !resolve)
		throw new Error("Recursive transfer requires frozen endpoints and a live authorization fence");
	const local = plan.endpoints.find((endpoint) => endpoint.target.deviceId === "local");
	const remote = plan.endpoints.find((endpoint) => endpoint.target.deviceId === deviceId);
	if (
		!local ||
		!remote ||
		local.operation !== (direction === "upload" ? "read" : "write") ||
		remote.operation !== (direction === "upload" ? "write" : "read")
	)
		throw new Error("Recursive transfer endpoint operations do not match the approved direction");
	const sources = await Promise.all(
		[local, remote].map(async (endpoint) => {
			const backend = resolve(endpoint.target.deviceId);
			const context = await createExecutionTargetContext({
				backend,
				target: endpoint.target,
				deviceClass: backend.kind === "local" ? "host" : null,
			});
			const root = context.target.canonicalPath;
			if (!root) throw new Error("Recursive transfer needs canonical endpoint roots");
			const policy = await executionPolicyEngine.compile(ctx.narratorId, context, [], ctx.signal);
			return { endpoint, backend, context, policy, root };
		}),
	);
	const assertCurrent = () => {
		ctx.signal.throwIfAborted();
		fence();
		for (const source of sources) {
			if (
				resolve(source.backend.deviceId) !== source.backend ||
				source.backend.runtimeGeneration !== source.context.target.runtimeGeneration
			)
				throw new Error("Recursive transfer backend generation changed");
		}
	};
	return {
		assertCurrent,
		async authorizeFile(localPath: string, remotePath: string) {
			ctx.signal.throwIfAborted();
			await recheck();
			const row = await db.query.narrators.findFirst({
				where: eq(narrators.id, ctx.narratorId),
				columns: { permissionMode: true, planMode: true, relaxedPlan: true },
			});
			if (
				!row ||
				row.permissionMode === "readOnly" ||
				(row.planMode && !row.relaxedPlan) ||
				ctx.runtimePolicy?.tools.readOnly
			)
				throw new Error("Recursive transfer Write denied by live read-only/plan policy");
			for (const [index, source] of sources.entries()) {
				const path = index === 0 ? localPath : remotePath;
				const { backend, endpoint, policy, context } = source;
				await createExecutionTargetContext({
					backend,
					target: endpoint.target,
					deviceClass: context.deviceClass,
				});
				const identity = await backend.resolvePathIdentity(path, {
					baseCwd: endpoint.target.cwd,
					operation: endpoint.operation === "read" ? "existing" : "create",
					signal: ctx.signal,
				});
				const canonical = identity.canonicalPath;
				if (
					identity.runtimeGeneration !== context.target.runtimeGeneration ||
					!backend.paths.equals(path, canonical) ||
					!backend.paths.contains(source.root, canonical)
				)
					throw new Error("Recursive transfer descendant escaped or changed canonical identity");
				// Remote private stores have target-native separators; never interpret them using the host grammar.
				const segments = canonical
					.split(backend.pathFlavor === "windows" ? /[\\/]/ : /\//)
					.map((part) => (backend.pathFlavor === "windows" ? part.toLowerCase() : part));
				if (
					(backend.kind === "local" &&
						(isSecretPlatformPath(canonical, narraforkDir) ||
							isSecretUserPath(canonical, getHome()) ||
							backend.paths.contains(narraforkDir, canonical))) ||
					segments.some((part) => [".ssh", ".aws", ".gnupg", ".kube", ".narrafork"].includes(part))
				)
					throw new Error("Recursive transfer descendant is a private secret path");
				const livePolicy = await executionPolicyEngine.compile(
					ctx.narratorId,
					context,
					[],
					ctx.signal,
				);
				// Include the transfer's private sidecars: a destination approval cannot
				// silently authorize a separately denied checkpoint path.
				const paths =
					endpoint.operation === "write"
						? [canonical, `${canonical}.nfpart`, `${canonical}.nfmeta`, `${canonical}.nfmeta.tmp`]
						: [canonical];
				for (const candidate of paths) {
					if (candidate !== canonical) {
						const checkpoint = await backend.resolvePathIdentity(candidate, {
							baseCwd: endpoint.target.cwd,
							operation: "create",
							signal: ctx.signal,
						});
						if (
							checkpoint.runtimeGeneration !== context.target.runtimeGeneration ||
							!backend.paths.equals(candidate, checkpoint.canonicalPath)
						)
							throw new Error("Recursive transfer checkpoint changed canonical identity");
					}
					for (const compiled of [policy, livePolicy]) {
						const decision = compiled.evaluatePath({
							path: candidate,
							operation: endpoint.operation === "read" ? "read" : "write",
						}).decision;
						if (decision === "deny" || (row.permissionMode === "dontAsk" && decision !== "allow"))
							throw new Error(
								`Recursive transfer descendant ${endpoint.operation} denied by execution policy`,
							);
					}
				}
			}
			await recheck();
			assertCurrent();
		},
	};
}
