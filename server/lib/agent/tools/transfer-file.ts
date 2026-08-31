import { basename } from "node:path";
import { z } from "zod/v4";
import {
	downloadDirectory,
	downloadFile,
	statRemote,
	uploadDirectory,
	uploadFile,
	validateLocalAbsolutePath,
	validateRemoteAbsolutePath,
} from "../../../services/device-transfer-service";
import { LOCAL_DEVICE_ID } from "../execution/backend";
import type { AgentConfig, ToolContext, ToolDefinition, ToolResult } from "../types";
import {
	buildTransferProgressPayload,
	formatTransferBytes,
	formatTransferProgress,
	formatTransferSummary,
} from "./transfer-progress";

/**
 * TransferFile — move files/directories between the NarraFork server and a
 * remote executor device with high-performance, resumable, chunked transfer.
 *
 * Only offered when the session has online remote devices (loop.ts filters it
 * out otherwise); the `device` enum reflects the currently reachable devices.
 */
/**
 * Shared schema for the background flag (the static and config-derived schemas
 * must describe it identically — a provider sees one or the other).
 */
const BACKGROUND_PARAM_SCHEMA = {
	type: "boolean",
	description:
		"Run the transfer in the background and return immediately with a task handle. " +
		"A background transfer survives a NarraFork restart, can be paused and resumed, " +
		"and resumes from where it stopped rather than restarting. Use Await with " +
		'`type: "transfer"` to wait for it. Recommended for large files and directories.',
} as const;

export const transferFileTool: ToolDefinition = {
	name: "TransferFile",
	executionRouting: {
		kind: "multi",
		resolve(input) {
			const direction = input.direction;
			const deviceId = typeof input.device === "string" ? input.device : undefined;
			const remotePath = typeof input.remotePath === "string" ? input.remotePath : undefined;
			const localPath = typeof input.localPath === "string" ? input.localPath : undefined;
			if ((direction !== "download" && direction !== "upload") || !deviceId) return null;
			return {
				primaryKey: "remote",
				endpoints: [
					{
						key: "local",
						operation: direction === "upload" ? "read" : "write",
						hostOnly: true,
						...(localPath ? { path: localPath } : {}),
					},
					{
						key: "remote",
						operation: direction === "upload" ? "write" : "read",
						deviceId,
						...(remotePath ? { path: remotePath } : {}),
					},
				],
			};
		},
	},
	description:
		"Transfer files or directories between the NarraFork server (local) and a remote executor " +
		'device. High-performance chunked transfer with resume. Use `direction: "download"` to copy ' +
		'from the remote device to the server, or `"upload"` to copy from the server to the device. ' +
		"Set `recursive: true` to transfer a whole directory. Paths on the device are constrained to its " +
		"allowed roots.",
	rawJsonSchema: {
		type: "object",
		properties: {
			direction: {
				type: "string",
				enum: ["download", "upload"],
				description: '"download" = device → server; "upload" = server → device.',
			},
			device: { type: "string", description: "The remote device id to transfer with." },
			remotePath: { type: "string", description: "Absolute path on the remote device." },
			localPath: { type: "string", description: "Absolute path on the NarraFork server." },
			recursive: {
				type: "boolean",
				description: "Transfer a directory recursively. Default false (single file).",
			},
			run_in_background: BACKGROUND_PARAM_SCHEMA,
		},
		required: ["direction", "device", "remotePath", "localPath"],
		additionalProperties: false,
	},
	getRawJsonSchema(config: AgentConfig) {
		const devices = (config.availableDevices ?? []).filter((d) => d.online);
		const deviceEnum = devices.map((d) => d.id);
		const lines = devices.map((d) => {
			const platform = d.platform ? ` [${d.platform.os}/${d.platform.arch}]` : "";
			return `  • "${d.id}" (${d.name})${platform}`;
		});
		return {
			type: "object",
			properties: {
				direction: {
					type: "string",
					enum: ["download", "upload"],
					description: '"download" = device → server; "upload" = server → device.',
				},
				device: {
					type: "string",
					enum: deviceEnum,
					description: `The remote device to transfer with. Available:\n${lines.join("\n")}`,
				},
				remotePath: { type: "string", description: "Absolute path on the remote device." },
				localPath: { type: "string", description: "Absolute path on the NarraFork server." },
				recursive: {
					type: "boolean",
					description: "Transfer a directory recursively. Default false (single file).",
				},
				run_in_background: BACKGROUND_PARAM_SCHEMA,
			},
			required: ["direction", "device", "remotePath", "localPath"],
			additionalProperties: false,
		};
	},
	parameters: z.object({
		direction: z.enum(["download", "upload"]),
		device: z.string(),
		remotePath: z.string(),
		localPath: z.string(),
		recursive: z.boolean().optional(),
		run_in_background: z.boolean().optional(),
	}),
	async execute(args, ctx): Promise<ToolResult> {
		const {
			direction,
			device,
			remotePath,
			localPath,
			recursive,
			run_in_background: runInBackground,
		} = args as {
			direction: "download" | "upload";
			device: string;
			remotePath: string;
			localPath: string;
			recursive?: boolean;
			run_in_background?: boolean;
		};

		if (device === LOCAL_DEVICE_ID) {
			return {
				output: "TransferFile targets a remote device; use Read/Write for local files.",
				isError: true,
			};
		}
		const known = (ctx.availableDevices ?? []).find((d) => d.id === device || d.slug === device);
		if (!known) {
			return { output: `Unknown device "${device}".`, isError: true };
		}
		if (!known.online) {
			return { output: `Device "${known.name}" is offline.`, isError: true };
		}

		const platformOs = known.platform?.os;
		if (!platformOs) {
			return {
				output: `Cannot validate remote path for device "${known.name}": target platform is unavailable.`,
				isError: true,
			};
		}
		let localAbs: string;
		try {
			localAbs = validateLocalAbsolutePath(localPath);
			validateRemoteAbsolutePath(remotePath, platformOs);
		} catch (err) {
			return {
				output: `Invalid transfer path: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			};
		}

		// Background hand-off happens AFTER the checks above, never instead of them: a
		// tool that returns immediately would otherwise report success for a transfer
		// doomed by a bad path or an offline device, and the real error would surface
		// minutes later in a drawer card the model is not looking at.
		if (runInBackground) {
			return startBackgroundTransfer({
				ctx,
				deviceId: known.id,
				deviceName: known.name,
				direction,
				remotePath,
				localPath: localAbs,
				recursive: recursive === true,
			});
		}

		const started = Date.now();
		const reporter = createProgressReporter({
			ctx,
			direction,
			deviceName: known.name,
			remotePath,
			localPath: localAbs,
			startedAt: started,
		});
		try {
			if (recursive) {
				const result =
					direction === "download"
						? await downloadDirectory({
								deviceId: known.id,
								remoteDir: remotePath,
								localDir: localAbs,
								remotePlatformOs: platformOs,
								signal: ctx.signal,
								onProgress: reporter.report,
							})
						: await uploadDirectory({
								deviceId: known.id,
								localDir: localAbs,
								remoteDir: remotePath,
								remotePlatformOs: platformOs,
								signal: ctx.signal,
								onProgress: reporter.report,
							});
				return transferResult({
					direction,
					deviceName: known.name,
					bytesTransferred: result.bytesTransferred,
					filesTransferred: result.filesTransferred,
					elapsedMs: Date.now() - started,
					remotePath,
					localPath: localAbs,
					recursive: true,
				});
			}

			if (direction === "download") {
				const stat = await statRemote(known.id, remotePath, { remotePlatformOs: platformOs });
				if (!stat.exists) return { output: `Remote file not found: ${remotePath}`, isError: true };
				if (stat.isDirectory) {
					return {
						output: `${remotePath} is a directory. Set recursive: true to transfer it.`,
						isError: true,
					};
				}
				// Paint 0% immediately. Without it the card shows nothing until the first
				// chunk lands, which for a large file on a slow link is the exact stretch
				// the user most wants confirmation that something started.
				reporter.report({
					bytesTransferred: 0,
					totalBytes: stat.size,
					filesDone: 0,
					totalFiles: 1,
				});
				const result = await downloadFile({
					deviceId: known.id,
					remotePath,
					localDest: localAbs,
					remoteSize: stat.size,
					remoteMtimeMs: stat.mtimeMs,
					remotePlatformOs: platformOs,
					signal: ctx.signal,
					progress: {
						direction: "download",
						filesDone: 0,
						totalFiles: 1,
						totalBytes: stat.size,
						onProgress: reporter.report,
					},
				});
				return transferResult({
					direction,
					deviceName: known.name,
					bytesTransferred: result.bytes,
					filesTransferred: 1,
					elapsedMs: Date.now() - started,
					remotePath,
					localPath: localAbs,
					recursive: false,
				});
			}

			const result = await uploadFile({
				deviceId: known.id,
				localPath: localAbs,
				remoteDest: remotePath,
				remotePlatformOs: platformOs,
				signal: ctx.signal,
				progress: {
					direction: "upload",
					filesDone: 0,
					totalFiles: 1,
					onProgress: reporter.report,
				},
			});
			return transferResult({
				direction,
				deviceName: known.name,
				bytesTransferred: result.bytes,
				filesTransferred: 1,
				elapsedMs: Date.now() - started,
				remotePath,
				localPath: localAbs,
				recursive: false,
			});
		} catch (err) {
			return {
				output: `Transfer failed: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			};
		} finally {
			reporter.dispose();
		}
	},
};

/**
 * Hand a validated transfer to the persistent task runner and return at once.
 *
 * Unlike a background Bash command, this needs no fire-and-forget block here: the
 * transfer runner already owns the work durably (its own DB row, resume
 * checkpoint and restart recovery). Duplicating that with an in-process promise
 * would create a second, weaker owner that dies with the turn.
 */
async function startBackgroundTransfer(input: {
	ctx: ToolContext;
	deviceId: string;
	deviceName: string;
	direction: "download" | "upload";
	remotePath: string;
	localPath: string;
	recursive: boolean;
}): Promise<ToolResult> {
	const { ctx } = input;
	const [{ startDeviceTransferTask }, { registerTaskAlias, unregisterTaskAlias }] =
		await Promise.all([
			import("@server/services/device-transfer-service"),
			import("@server/services/subagent-alias"),
		]);

	const name = basename(input.direction === "upload" ? input.localPath : input.remotePath);
	const title = `${input.direction} ${input.direction === "upload" ? "→" : "←"} ${
		name || input.remotePath
	}`;
	let alias = "";
	let registeredTaskId = "";

	let task: Awaited<ReturnType<typeof startDeviceTransferTask>>;
	try {
		task = await startDeviceTransferTask({
			deviceId: input.deviceId,
			direction: input.direction,
			remotePath: input.remotePath,
			localPath: input.localPath,
			recursive: input.recursive,
			parentNarratorId: ctx.narratorId,
			...(ctx.currentToolUseId ? { toolUseId: ctx.currentToolUseId } : {}),
			// The runner reads this back when it creates the projection, so the handle the
			// model was given below survives a restart. Registering the alias needs the
			// row's id, so it happens after this call and is written by `registerAlias`.
			registerAlias: (transferTaskId) => {
				registeredTaskId = transferTaskId;
				alias = registerTaskAlias(ctx.narratorId, transferTaskId, title).alias;
				return alias;
			},
		});
	} catch (err) {
		// The alias was minted during argument evaluation, so a failure of the INSERT
		// itself leaves it pointing at a row that will never exist. Drop it: a later
		// retry registering for the same id would get the stale alias back.
		if (registeredTaskId) unregisterTaskAlias(ctx.narratorId, registeredTaskId);
		// The device transfer-slot limit lands here. Reported as a tool error rather
		// than a queued task, because nothing was queued.
		return {
			output: `Could not start background transfer: ${
				err instanceof Error ? err.message : String(err)
			}`,
			isError: true,
		};
	}

	// The update execution lease is deliberately NOT transferred here.
	//
	// `transfer()` only stops the executor's `finally` from releasing — it hands the
	// release duty to a named owner (see bash.ts, which releases in its own
	// fire-and-forget `finally`, and task.ts, which passes the lease into `runSubagent`).
	// A background transfer has no such owner: the runner in `device-transfer-service`
	// knows nothing about leases, so transferring here leaked the lease permanently.
	// Because `classifyToolUpdateExecution` sees no matching shape for TransferFile, the
	// leaked entry counted as "ordinary" forever, and `waitForOrdinaryToolDrain()` — which
	// every scheduled update awaits — could never resolve again.
	//
	// Releasing with this turn is also the semantically right answer, not just the simple
	// one: the durable owner of the work is the committed task row, and the transfer is
	// built to survive a restart (`recoverStaleTasksAfterRestart` resumes it from its
	// `.nfpart` offset). Holding an update back for it would block the update window for
	// as long as the transfer runs — hours, for a large directory — to protect work that
	// explicitly does not need protecting.
	const route =
		input.direction === "upload"
			? `${input.localPath} → ${input.deviceName}:${input.remotePath}`
			: `${input.deviceName}:${input.remotePath} → ${input.localPath}`;
	return {
		output:
			`Started background ${input.direction}: ${route}\n` +
			`Task: ${alias}\n\n` +
			`It continues across restarts and can be paused/resumed. ` +
			`Use Await({ type: "transfer", id: "${alias}" }) to wait for it, or check the ` +
			`background task list for live progress.`,
		title,
		metadata: {
			transferDirection: input.direction,
			deviceName: input.deviceName,
			remotePath: input.remotePath,
			localPath: input.localPath,
			recursive: input.recursive,
			background: true,
			transferTaskId: task.id,
			taskAlias: alias,
		},
	};
}

/**
 * Minimum gap between two live progress repaints.
 *
 * The transport reports once per chunk (1 MiB by default), so a fast local link
 * produces hundreds of callbacks per second. `emitOutput` throttles the WS
 * broadcast already, but the *string building* happens here — and the progress
 * body is rebuilt from scratch each time. Coalescing at the source keeps a
 * fast transfer from burning main-thread time formatting frames nobody sees.
 *
 * 250ms rather than something smoother: the bar advances in 1/24 steps, so a
 * faster repaint cannot show a finer change.
 */
const PROGRESS_REPAINT_MS = 250;

interface ProgressReporterArgs {
	ctx: ToolContext;
	direction: "download" | "upload";
	deviceName: string;
	remotePath: string;
	localPath: string;
	startedAt: number;
}

/**
 * A throttled bridge from the transfer service's `onProgress` callback to the
 * tool's live output channel.
 *
 * Always keeps the LATEST update and flushes it on a trailing timer, so the
 * final pre-completion frame is never dropped by the throttle — a bar frozen at
 * 87% while the tool reports success reads as a bug in the transfer, not in the
 * repaint policy.
 */
function createProgressReporter(args: ProgressReporterArgs): {
	report: (progress: {
		bytesTransferred: number;
		totalBytes: number;
		filesDone: number;
		totalFiles: number;
		currentFile?: string;
	}) => void;
	dispose: () => void;
} {
	const emit = args.ctx.emitOutput;
	const emitStructured = args.ctx.emitStructuredProgress;
	// Neither channel wired (a bare/legacy caller) → nothing to report to.
	if (!emit && !emitStructured) return { report: () => {}, dispose: () => {} };

	let latest: Parameters<ReturnType<typeof createProgressReporter>["report"]>[0] | null = null;
	let lastEmitAt = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const flush = () => {
		timer = undefined;
		if (!latest) return;
		lastEmitAt = Date.now();
		const view = {
			direction: args.direction,
			deviceName: args.deviceName,
			bytesTransferred: latest.bytesTransferred,
			totalBytes: latest.totalBytes,
			filesDone: latest.filesDone,
			totalFiles: latest.totalFiles,
			...(latest.currentFile ? { currentFile: latest.currentFile } : {}),
			elapsedMs: Date.now() - args.startedAt,
			remotePath: args.remotePath,
			localPath: args.localPath,
		};
		// Both channels from ONE view object, so the bar and the text can never
		// disagree about the same instant.
		emitStructured?.(buildTransferProgressPayload(view));
		emit?.(formatTransferProgress(view));
	};

	return {
		report(progress) {
			latest = progress;
			const since = Date.now() - lastEmitAt;
			if (since >= PROGRESS_REPAINT_MS) {
				if (timer) clearTimeout(timer);
				flush();
			} else if (!timer) {
				timer = setTimeout(flush, PROGRESS_REPAINT_MS - since);
			}
		},
		dispose() {
			if (timer) clearTimeout(timer);
			timer = undefined;
			latest = null;
		},
	};
}

interface TransferResultArgs {
	direction: "download" | "upload";
	deviceName: string;
	bytesTransferred: number;
	filesTransferred: number;
	elapsedMs: number;
	remotePath: string;
	localPath: string;
	recursive: boolean;
}

/**
 * The completed tool result: a readable summary line for the model plus the
 * structured `metadata` the detail card renders as a finished transfer row.
 *
 * The metadata is additive — the `output` string alone still describes the whole
 * transfer, so a surface that does not read metadata (a copied card, an older
 * client, the model itself) loses formatting but no information.
 */
function transferResult(args: TransferResultArgs): ToolResult {
	const seconds = args.elapsedMs / 1000;
	const rate = seconds > 0 ? args.bytesTransferred / seconds : 0;
	return {
		output: formatTransferSummary(args),
		title: `${args.direction} ${args.remotePath}`,
		metadata: {
			transferDirection: args.direction,
			deviceName: args.deviceName,
			remotePath: args.remotePath,
			localPath: args.localPath,
			bytesTransferred: args.bytesTransferred,
			bytesFormatted: formatTransferBytes(args.bytesTransferred),
			filesTransferred: args.filesTransferred,
			durationMs: args.elapsedMs,
			rateFormatted: rate > 0 ? `${formatTransferBytes(rate)}/s` : undefined,
			recursive: args.recursive,
		},
	};
}
