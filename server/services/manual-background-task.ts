import type { NoProxyRule } from "@shared/proxy-settings";
import { resolveBackend } from "../lib/agent/execution/registry";
import { startManualBackgroundBash } from "../lib/agent/tools/bash";
import { AppError } from "../lib/errors";
import { getNoProxyRules, getOutboundProxy } from "../lib/net/proxy";
import { ambientNoProxy, proxyEnvForSubprocess } from "../lib/net/proxy-env";
import { withNarratorMutationAdmission } from "./narrator-session-state";
import { tryAcquireFinalUpdateExecution } from "./update-coordinator";
import { workspaceContextService } from "./workspace-context-service";

export function manualCommandProxyEnv(
	proxy: string | undefined,
	ambient: string,
	rules: readonly NoProxyRule[],
): Record<string, string> {
	// NO_PROXY syntax varies by client. Forward only host suffixes and the global wildcard;
	// do not turn a precise regex/URL/port exemption into a broader hostname exemption.
	const hosts = rules.flatMap((rule) => {
		if (rule.enabled === false || rule.match !== "wildcard") return [];
		const value = rule.pattern.trim().toLowerCase().replace(/^\./, "");
		return value === "*" || /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/.test(value) ? [value] : [];
	});
	const noProxy = [
		...new Set([
			...ambient
				.split(",")
				.map((value) => value.trim())
				.filter(Boolean),
			"localhost",
			"127.0.0.1",
			"::1",
			"0.0.0.0",
			...hosts,
		]),
	].join(",");
	return {
		HTTP_PROXY: proxy ?? "",
		http_proxy: proxy ?? "",
		HTTPS_PROXY: proxy ?? "",
		https_proxy: proxy ?? "",
		ALL_PROXY: proxy ?? "",
		all_proxy: proxy ?? "",
		NO_PROXY: noProxy,
		no_proxy: noProxy,
	};
}

function getManualCommandProxyEnv(): Record<string, string> {
	// Preserve the Bash executor's existing default: user commands inherit their shell proxy.
	// In the presence of a NarraFork proxy, use its unified proxy for compatible clients.
	const proxy = getOutboundProxy();
	const ambient = proxyEnvForSubprocess();
	const env = manualCommandProxyEnv(proxy, ambientNoProxy(), getNoProxyRules());
	if (proxy) return env;
	return {
		...env,
		HTTP_PROXY: ambient.HTTP_PROXY ?? ambient.http_proxy ?? "",
		http_proxy: ambient.http_proxy ?? ambient.HTTP_PROXY ?? "",
		HTTPS_PROXY: ambient.HTTPS_PROXY ?? ambient.https_proxy ?? "",
		https_proxy: ambient.https_proxy ?? ambient.HTTPS_PROXY ?? "",
		ALL_PROXY: ambient.ALL_PROXY ?? ambient.all_proxy ?? "",
		all_proxy: ambient.all_proxy ?? ambient.ALL_PROXY ?? "",
	};
}

export function createManualBackgroundTask(input: {
	narratorId: string;
	userId: string;
	command: string;
	kind: "task" | "service";
	title?: string;
	timeoutMs?: number;
	signal: AbortSignal;
	authorizeDispatch: () => Promise<void>;
}) {
	const { narratorId } = input;
	return withNarratorMutationAdmission(narratorId, async () => {
		const workspace = await workspaceContextService.get(narratorId);
		if (workspace.deviceId !== "local") {
			throw new AppError(
				"Manual background commands require a local workspace",
				409,
				"MANUAL_TASK_LOCAL_ONLY",
			);
		}
		const backend = resolveBackend({ requested: workspace.deviceId });
		if (!backend.paths.isAbsolute(workspace.cwd)) {
			throw new AppError(
				"Choose a narrator working directory first",
				409,
				"WORKSPACE_DIRECTORY_REQUIRED",
			);
		}
		const lease = tryAcquireFinalUpdateExecution("background_bash", narratorId);
		if (!lease)
			throw new AppError(
				"The server is preparing an update; try again later",
				503,
				"UPDATE_IN_PROGRESS",
			);
		let transferred = false;
		try {
			return await startManualBackgroundBash({
				...input,
				backend,
				target: Object.freeze({
					deviceId: backend.deviceId,
					backendKind: backend.kind,
					cwd: workspace.cwd,
					pathFlavor: backend.paths.flavor,
					runtimeGeneration: backend.runtimeGeneration,
					selectionSource: "session_default",
				}),
				proxyEnv: getManualCommandProxyEnv(),
				updateExecutionLease: {
					kind: lease.kind,
					setNarratorId: lease.setNarratorId,
					release: lease.release,
					transfer() {
						if (transferred) return false;
						transferred = true;
						return true;
					},
				},
			});
		} finally {
			if (!transferred) lease.release();
		}
	});
}
