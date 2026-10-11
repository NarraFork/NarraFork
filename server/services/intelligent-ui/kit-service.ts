import type { ExecutionBackend } from "@server/lib/agent/execution/backend";
import { resolveBackend } from "@server/lib/agent/execution/registry";
import type {
	IntelligentUiKitBundle,
	IntelligentUiKitRequest,
	IntelligentUiKitStatus,
} from "@shared/intelligent-ui-kit";
import type { WorkspaceContext } from "@shared/workspace-context";
import { uiError, workspaceKey } from "./files";
import { readKit, readKitBundle } from "./kit";
import { approveKitRequest, dismissKitRequest, getKitRequest } from "./kit-requests";

/** Narrator-scoped kit operations for the HTTP surface (the chat UI, not the agent). */
export interface KitServiceDependencies {
	workspace(narratorId: string): Promise<WorkspaceContext>;
	backend(deviceId: string): ExecutionBackend;
	authorize(
		narratorId: string,
		userId: string,
		deviceId: string,
		path: string,
		signal: AbortSignal,
	): Promise<string>;
	/** Tell the agent the user approved; wakes an idle narrator, queues for a busy one. */
	notifyApproved(narratorId: string, userId: string, text: string): Promise<void>;
}

const defaults: KitServiceDependencies = {
	async workspace(narratorId) {
		const { workspaceContextService } = await import("@server/services/workspace-context-service");
		return workspaceContextService.get(narratorId);
	},
	backend(deviceId) {
		return resolveBackend({ requested: deviceId });
	},
	async authorize(narratorId, userId, deviceId, path, signal) {
		const { fileReferenceService } = await import("@server/services/file-reference-service");
		const [target] = await fileReferenceService.resolveFileReferences(
			narratorId,
			userId,
			[{ deviceId, path }],
			signal,
		);
		if (!target) throw uiError("File read authorization denied", 403);
		return target.path;
	},
	async notifyApproved(narratorId, userId, text) {
		const { deliverInjection } = await import("@server/services/narrator-injection");
		await deliverInjection(narratorId, {
			content: text,
			source: "intelligent_ui_kit",
			body: { kind: "prose", text },
			// The row is in history either way; an idle narrator is started so the
			// approval is acted on, a busy one reads it on its next pass and finishes
			// what it is doing first.
			schedule: "wakeIfIdle",
			createdBy: userId,
		});
	},
};

export interface KitOverview {
	status: IntelligentUiKitStatus;
	request: IntelligentUiKitRequest | null;
}

function bounded(signal: AbortSignal): AbortSignal {
	return AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
}

export function createKitService(overrides: Partial<KitServiceDependencies> = {}) {
	const deps = { ...defaults, ...overrides };
	const open = async (narratorId: string, userId: string) => {
		const workspace = structuredClone(await deps.workspace(narratorId));
		const backend = deps.backend(workspace.deviceId);
		const authorize = (path: string, signal: AbortSignal) =>
			deps.authorize(narratorId, userId, workspace.deviceId, path, signal);
		return { workspace, backend, authorize };
	};
	return {
		async overview(narratorId: string, userId: string, signal: AbortSignal): Promise<KitOverview> {
			const { workspace, backend, authorize } = await open(narratorId, userId);
			const { status } = await readKit(backend, workspace, authorize, bounded(signal));
			return { status, request: getKitRequest(narratorId, workspaceKey(workspace)) };
		},
		async bundle(
			narratorId: string,
			userId: string,
			signal: AbortSignal,
		): Promise<IntelligentUiKitBundle> {
			const { workspace, backend, authorize } = await open(narratorId, userId);
			return readKitBundle(backend, workspace, authorize, bounded(signal));
		},
		/** The user's confirmation: the one thing that lets `kit_build` run. */
		async approve(narratorId: string, userId: string, requestId: string): Promise<KitOverview> {
			const approved = approveKitRequest(narratorId, requestId);
			if (!approved) throw uiError("This kit request is no longer open", 404);
			// Only the transition notifies: a double click must not queue two builds.
			if (approved.newlyApproved) {
				const update = approved.request.kind === "update";
				await deps.notifyApproved(
					narratorId,
					userId,
					[
						`[Intelligent UI] The user approved ${update ? "updating" : "building"} this workspace's component kit.`,
						"Finish the step you are on, then:",
						update
							? "1. Check .narrafork/intelligent_ui/kit/kit.json (and setup.tsx) against the project's current component library and correct them."
							: '1. If .narrafork/intelligent_ui/kit/kit.json does not exist yet, inspect the project\'s component library and write it (call IntelligentUI {action:"kit_status"} for the format).',
						'2. Call IntelligentUI {action:"kit_build"}.',
						"3. If the build fails, fix the manifest or setup file and build again; this approval stays valid until a build succeeds.",
					].join("\n"),
				);
			}
			return {
				status: (await this.overview(narratorId, userId, AbortSignal.timeout(20_000))).status,
				request: approved.request,
			};
		},
		async dismiss(narratorId: string, requestId: string): Promise<{ dismissed: boolean }> {
			return { dismissed: dismissKitRequest(narratorId, requestId) };
		},
	};
}

export const kitService = createKitService();
