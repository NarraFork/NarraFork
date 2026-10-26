import type { GenUiInput } from "@server/lib/agent/tools/gen-ui";
import type { ToolResult } from "@server/lib/agent/types";
import { logger } from "@server/lib/logger";
import { parseUiMarkup } from "@shared/gen-ui-markup";
import { createPreviewShell } from "@shared/gen-ui-preview-shell";
import { captureGenUiSnapshot, createCaptureDiagnostics } from "./capture";
import { assertReferenceWorkspace, uiError, workspaceKey } from "./files";
import { readInspectionRuntime } from "./inspection-runtime";
import { type InspectionToolRecord, inspectionTarget } from "./inspection-target";
import { readKit, readKitBundle } from "./kit";
import type { KitToolEnvironment } from "./kit-runtime";
import { buildGenUiPreview } from "./preview";

export interface InspectionDependencies {
	tool(narratorId: string, toolUseId: string, toolCallId: string): Promise<InspectionToolRecord>;
	kit: typeof readKit;
	kitBundle: typeof readKitBundle;
	builtin: typeof readInspectionRuntime;
	preview: typeof buildGenUiPreview;
	capture: typeof captureGenUiSnapshot;
}
const defaults: InspectionDependencies = {
	async tool(narratorId, toolUseId, toolCallId) {
		const { narratorService } = await import("@server/services/narrator-service");
		return narratorService.getToolCallDetail(narratorId, toolUseId, { toolCallId });
	},
	kit: readKit,
	kitBundle: readKitBundle,
	builtin: readInspectionRuntime,
	preview: buildGenUiPreview,
	capture: captureGenUiSnapshot,
};

let active = 0;
export async function inspectGenUi(
	input: Extract<GenUiInput, { action: "inspect" }>,
	env: KitToolEnvironment,
	overrides: Partial<InspectionDependencies> = {},
): Promise<ToolResult> {
	if (active >= 2) return { output: "GenUI inspection is busy; retry shortly", isError: true };
	active++;
	const started = Date.now();
	const controller = new AbortController();
	const signal = AbortSignal.any([env.ctx.signal, controller.signal]);
	const timer = setTimeout(
		() => controller.abort(uiError("GenUI inspection exceeded 30 seconds", 408)),
		30_000,
	);
	const deps = { ...defaults, ...overrides };
	let stage = "authorization";
	const check = async () => {
		signal.throwIfAborted();
		await env.check();
		signal.throwIfAborted();
	};
	let abort: (() => void) | undefined;
	const cancelled = new Promise<never>((_, reject) => {
		abort = () => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
	});
	try {
		return await Promise.race([
			cancelled,
			(async (): Promise<ToolResult> => {
				await check();
				// A workspace execution grant must not authorize code on another device.
				// Until dual-target execution grants exist, remote source inspection fails closed.
				if (env.backend.deviceId !== "local" || env.workspace.deviceId !== "local")
					throw uiError(
						"GenUI inspect currently requires a server-local workspace; remote workspace approval does not authorize server-side browser execution",
						403,
					);
				const row = await deps.tool(env.ctx.narratorId, input.toolUseId, input.toolCallId);
				const target = inspectionTarget(row, input.toolUseId, input.toolCallId);
				if (target.mode === "app") {
					assertReferenceWorkspace(target.reference, env.workspace, env.backend);
				} else if (
					target.deviceId !== env.backend.deviceId ||
					!env.backend.paths.equals(target.cwd, env.workspace.cwd) ||
					(target.workspaceKey !== undefined && target.workspaceKey !== workspaceKey(env.workspace))
				)
					throw uiError("The selected UI belongs to another workspace or device", 409);
				await check();
				stage = "runtime";
				const paths = new Set<string>();
				const authorize = async (path: string) => {
					await check();
					await env.authorizeRead(path);
					paths.add(path);
					return path;
				};
				const { status } = await deps.kit(env.backend, env.workspace, authorize, signal);
				const kit = status.hash
					? await deps.kitBundle(env.backend, env.workspace, authorize, signal)
					: undefined;
				if (kit && kit.hash !== status.hash)
					throw uiError("The component kit changed while preparing inspection; retry", 409);
				const runtime = kit
					? { runtimeJs: kit.js, runtimeCss: kit.css }
					: await deps.builtin(signal);
				await check();
				stage = "compile";
				let js = "";
				let css = "";
				let sourceHash: string;
				let tree: ReturnType<typeof parseUiMarkup>["nodes"] | undefined;
				const notes: string[] = [];
				if (target.mode === "app") {
					const preview = await deps.preview(
						env.ctx.narratorId,
						env.ctx.userId ?? "",
						target.reference,
						signal,
						{
							kit: async () => (kit ? { hash: kit.hash, components: kit.components } : null),
						},
					);
					if (!preview.sourceHash) throw uiError("Inspection source snapshot has no identity", 409);
					sourceHash = preview.sourceHash;
					js = preview.js;
					css = preview.css;
					for (const file of preview.files)
						paths.add(env.backend.paths.resolve(preview.directory, file));
				} else {
					const parsed = parseUiMarkup(target.source);
					if (!parsed.elements) throw uiError("Inspection markup contains no elements", 422);
					tree = parsed.nodes;
					notes.push(...parsed.diagnostics.slice(0, 8).map((item) => item.message.slice(0, 1000)));
					sourceHash = new Bun.CryptoHasher("sha256").update(target.source).digest("hex");
				}
				await check();
				const viewport = { width: input.width ?? 960, height: input.height ?? 640 };
				const theme = input.theme ?? "dark";
				const html = createPreviewShell(
					{ ...runtime, js, css },
					{ colorScheme: theme, tokenCss: "" },
					"UI rendering failed",
					{
						mode: target.mode,
						kit: !!kit,
						inspection: true,
					},
				);
				const hasher = new Bun.CryptoHasher("sha256");
				hasher.update(JSON.stringify({ sourceHash, viewport, theme }));
				hasher.update("\0");
				hasher.update(html);
				const snapshotHash = hasher.digest("hex");
				stage = "capture";
				const result = await deps.capture({ html, tree, viewport, signal });
				const diagnostics = createCaptureDiagnostics();
				for (const note of [...notes, ...result.diagnostics]) diagnostics.add(note);
				stage = "revalidation";
				await check();
				for (const path of paths) {
					await env.authorizeRead(path);
					await check();
				}
				// Re-select AFTER asynchronous file authorization: revert/COW/delete must not
				// release an obsolete result. Then close the no-file (builtin markup) fence too.
				const current = await deps.tool(env.ctx.narratorId, input.toolUseId, input.toolCallId);
				if (
					JSON.stringify(inspectionTarget(current, input.toolUseId, input.toolCallId)) !==
					JSON.stringify(target)
				)
					throw uiError("Inspection target changed during capture", 409);
				await check();
				env.ctx.assertWorkspaceCurrent?.();
				env.ctx.assertFinalExecutionPermission?.();
				signal.throwIfAborted();
				return {
					output: [
						`${result.failed ? (result.images.length ? "Preview has runtime errors" : "Preview capture failed") : result.limited ? "Preview captured with offline resource limits" : "Preview captured"} (${viewport.width}×${viewport.height}, ${theme}, offline replay).`,
						...diagnostics.entries,
					].join("\n"),
					images: result.images,
					metadata: {
						genUiInspection: {
							version: 1,
							toolUseId: input.toolUseId,
							toolCallId: input.toolCallId,
							deviceId: env.backend.deviceId,
							workspaceKey: workspaceKey(env.workspace),
							sourceHash,
							snapshotHash,
							kitHash: kit?.hash,
							viewport,
							theme,
							capturedAt: new Date().toISOString(),
							limited: result.limited === true,
						},
					},
					...(result.failed ? { isError: true } : {}),
				};
			})(),
		]);
	} catch (error) {
		return {
			output: `GenUI inspection failed during ${stage}: ${error instanceof Error ? error.message.slice(0, 2000) : "Unknown failure"}.`,
			isError: true,
		};
	} finally {
		clearTimeout(timer);
		if (abort) signal.removeEventListener("abort", abort);
		controller.abort();
		active--;
		if (Date.now() - started >= 1000)
			logger.warn("Slow GenUI inspection", { elapsedMs: Date.now() - started, stage });
	}
}
