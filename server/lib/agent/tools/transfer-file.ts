import { resolve } from "node:path";
import { z } from "zod/v4";
import {
	downloadDirectory,
	downloadFile,
	statRemote,
	uploadDirectory,
	uploadFile,
} from "../../../services/device-transfer-service";
import { LOCAL_DEVICE_ID } from "../execution/backend";
import type { AgentConfig, ToolDefinition, ToolResult } from "../types";

/**
 * TransferFile — move files/directories between the NarraFork server and a
 * remote executor device with high-performance, resumable, chunked transfer.
 *
 * Only offered when the session has online remote devices (loop.ts filters it
 * out otherwise); the `device` enum reflects the currently reachable devices.
 */
export const transferFileTool: ToolDefinition = {
	name: "TransferFile",
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
	}),
	async execute(args, ctx): Promise<ToolResult> {
		const { direction, device, remotePath, localPath, recursive } = args as {
			direction: "download" | "upload";
			device: string;
			remotePath: string;
			localPath: string;
			recursive?: boolean;
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

		const localAbs = resolve(ctx.cwd, localPath);
		const started = Date.now();
		try {
			if (recursive) {
				const result =
					direction === "download"
						? await downloadDirectory({
								deviceId: known.id,
								remoteDir: remotePath,
								localDir: localAbs,
								signal: ctx.signal,
							})
						: await uploadDirectory({
								deviceId: known.id,
								localDir: localAbs,
								remoteDir: remotePath,
								signal: ctx.signal,
							});
				const secs = ((Date.now() - started) / 1000).toFixed(1);
				return {
					output:
						`${direction === "download" ? "Downloaded" : "Uploaded"} ${result.filesTransferred} files ` +
						`(${formatBytes(result.bytesTransferred)}) in ${secs}s between ${known.name} and the server.`,
					title: `${direction} ${remotePath}`,
				};
			}

			if (direction === "download") {
				const stat = await statRemote(known.id, remotePath);
				if (!stat.exists) return { output: `Remote file not found: ${remotePath}`, isError: true };
				if (stat.isDirectory) {
					return {
						output: `${remotePath} is a directory. Set recursive: true to transfer it.`,
						isError: true,
					};
				}
				const result = await downloadFile({
					deviceId: known.id,
					remotePath,
					localDest: localAbs,
					remoteSize: stat.size,
					remoteMtimeMs: stat.mtimeMs,
				});
				const secs = ((Date.now() - started) / 1000).toFixed(1);
				return {
					output: `Downloaded ${formatBytes(result.bytes)} from ${known.name}:${remotePath} to ${localAbs} in ${secs}s.`,
					title: `download ${remotePath}`,
				};
			}

			const result = await uploadFile({
				deviceId: known.id,
				localPath: localAbs,
				remoteDest: remotePath,
				signal: ctx.signal,
			});
			const secs = ((Date.now() - started) / 1000).toFixed(1);
			return {
				output: `Uploaded ${formatBytes(result.bytes)} from ${localAbs} to ${known.name}:${remotePath} in ${secs}s.`,
				title: `upload ${remotePath}`,
			};
		} catch (err) {
			return {
				output: `Transfer failed: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			};
		}
	},
};

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
