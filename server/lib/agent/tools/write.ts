import { z } from "zod/v4";
import { executeLocalFileChange } from "../../../services/file-change-runtime";
import { ensureFileSnapshot } from "../../../services/file-snapshot-service";
import { broadcastSpecChanged } from "../../../services/spec-broadcast";
import { specVfsService } from "../../../services/spec-vfs-service";
import { toolSpecPathError } from "../../spec-uri";
import { readCompleteFileBytes } from "../execution/backend";
import { withDeviceParam } from "../execution/device-schema";
import { backendDirname, resolveBackendPath, toolBaseCwd } from "../execution/path-resolve";
import { getToolBackend } from "../execution/tool-backend";
import type { ToolDefinition, ToolResult } from "../types";
import { consumeBehaviorFenceEditGrant, isBehaviorFencePath } from "./behavior-fence-grant";
import {
	applyLineEnding,
	decodeFileBytes,
	detectLineEnding,
	encodeFileBytes,
	looksBinary,
	normalizeLineEndings,
} from "./encoding";
import { lineStatsMetadata, wholeFileLineStats } from "./file-diff-stats";
import { consumeTaskReflectionGrant } from "./task-reflection";
import { trackFileChange } from "./track-file-change";
import { withWorkspaceWriteLock } from "./write-serialization";

/**
 * A spec file's current content, or null when it does not exist yet.
 *
 * Best-effort by design: `readSpecFile` throws for a path with no revision and no
 * builtin default, and that is the ordinary "creating it now" case rather than an
 * error. Any other failure also resolves to null — a missing line count costs the
 * header one figure, whereas letting this throw would fail a write that would
 * otherwise have succeeded.
 */
async function readSpecContentForStats(narratorId: string, uri: string): Promise<string | null> {
	try {
		const current = await specVfsService.readSpecFile(narratorId, uri);
		return current.content;
	} catch {
		return null;
	}
}

export const writeTool: ToolDefinition = {
	name: "Write",
	executionRouting: {
		kind: "single",
		resolve(input) {
			const path = typeof input.file_path === "string" ? input.file_path : undefined;
			return {
				key: "primary",
				operation: "write",
				...(typeof input.device === "string" ? { deviceId: input.device } : {}),
				...(path ? { path } : {}),
				...(path?.startsWith("spec://") ? { hostOnly: true, pathFlavor: "spec" as const } : {}),
			};
		},
	},
	description:
		"Writes a file to the local filesystem or the narrator's Dynamic Spec virtual files.\n\n" +
		"Usage:\n" +
		"- This tool will overwrite the existing file if there is one at the provided path.\n" +
		"- If this is an existing file, you MUST use the Read tool first to read the file's contents. This tool will fail if you did not read the file first.\n" +
		"- Prefer the Edit tool for modifying existing files — it only sends the diff. Only use this tool to create new files or for complete rewrites.\n" +
		"- Dynamic Spec support: file_path may be a spec:// URI such as spec://tasks.json or spec://index.md. Keep spec://tasks.json to only tasks[].text/status/protected; do not add IDs, timestamps, summaries, evidence, or runtime metadata. Every open task must be finite and executable.\n" +
		"- Set protected:true only when the user explicitly demanded that a task's completion be guaranteed. Otherwise leave it off: requirements change, and a task you protected yourself becomes a commitment you cannot retract.\n" +
		"- spec://behavior_fence is normally read-only for the assistant; durable behavior constraints belong there, but only write it when the user explicitly asks you to record a behavior, and only as the first tool call of that user turn.\n" +
		"- NEVER create documentation files (*.md) or README files unless explicitly requested by the User.\n" +
		"- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.",
	rawJsonSchema: {
		type: "object",
		properties: {
			file_path: {
				description:
					"The absolute local path or spec:// Dynamic Spec URI to write (local paths must be absolute, not relative)",
				type: "string",
			},
			content: {
				description: "The content to write to the file",
				type: "string",
			},
		},
		required: ["file_path", "content"],
		additionalProperties: false,
	},
	getRawJsonSchema(config) {
		return withDeviceParam(writeTool.rawJsonSchema as Record<string, unknown>, config);
	},
	parameters: z.object({
		file_path: z
			.string()
			.describe(
				"The absolute local path or spec:// Dynamic Spec URI to write (local paths must be absolute, not relative)",
			),
		content: z.string().describe("The content to write to the file"),
	}),
	async execute(args, ctx): Promise<ToolResult> {
		const specError = toolSpecPathError("Write", args);
		if (specError) return { output: specError, isError: true };
		const { file_path, content } = args as { file_path: string; content: string };
		if (specVfsService.isSpecUri(file_path)) {
			try {
				const taskReflectionGranted = consumeTaskReflectionGrant(
					ctx.narratorId,
					ctx.currentToolUseId,
				);
				const allowFenceMutation = isBehaviorFencePath(file_path)
					? consumeBehaviorFenceEditGrant(ctx.narratorId)
					: false;
				// Baseline for the `+N -N` figure, read BEFORE the write replaces it. A
				// spec file that does not exist yet reads as null (every line is then an
				// addition); the read is best-effort because failing to produce a line
				// count must never fail the write itself.
				const previousContent = await readSpecContentForStats(ctx.narratorId, file_path);
				const file = await specVfsService.writeSpecFile(ctx.narratorId, file_path, content, {
					sourceToolUseId: ctx.currentToolUseId ?? null,
					allowProtectedTaskMutation: taskReflectionGranted,
					allowFenceMutation,
				});
				broadcastSpecChanged(ctx.narratorId, file, "tool");
				const diffStats = wholeFileLineStats(previousContent, content);
				let tasks: unknown;
				if (file_path === "spec://tasks.json") {
					try {
						const parsed = JSON.parse(content);
						if (parsed && Array.isArray(parsed.tasks)) {
							tasks = parsed.tasks;
						}
					} catch {
						// ignore parse error — the card falls back to the file content view
					}
				}
				const specMetadata = {
					...(tasks !== undefined && { tasks }),
					...lineStatsMetadata(diffStats),
				};
				return {
					output: `Wrote ${content.length} bytes to ${file.uri}`,
					title: file.uri,
					...(Object.keys(specMetadata).length > 0 && { metadata: specMetadata }),
				};
			} catch (err) {
				return {
					output: `Error writing ${file_path}: ${err instanceof Error ? err.message : String(err)}`,
					isError: true,
				};
			}
		}
		const backend = getToolBackend(ctx, (args as { device?: string }).device);
		const baseCwd = toolBaseCwd(backend, ctx.cwd);
		const resolvedPath =
			ctx.executionTarget?.lexicalPath ?? resolveBackendPath(backend, baseCwd, file_path);
		const canonicalPath = ctx.executionTarget?.canonicalPath;
		const ioPath = canonicalPath ?? resolvedPath;
		try {
			const recorded = await executeLocalFileChange({
				ctx,
				backend,
				toolName: "Write",
				filePath: file_path,
				input: { content },
				construct(before) {
					const decoded =
						before.bytes === null ? { text: "", encoding: "utf-8" } : decodeFileBytes(before.bytes);
					const normalized = normalizeLineEndings(content);
					const ending = detectLineEnding(before.bytes === null ? content : decoded.text);
					const diffStats =
						before.bytes !== null && looksBinary(before.bytes)
							? null
							: wholeFileLineStats(
									before.bytes === null ? null : normalizeLineEndings(decoded.text),
									normalized,
								);
					return {
						nextBytes: encodeFileBytes(applyLineEnding(normalized, ending), decoded.encoding),
						lineStats: diffStats,
						result: {
							output: `Wrote ${content.length} bytes to ${file_path}`,
							title: file_path,
							...(diffStats ? { metadata: lineStatsMetadata(diffStats) } : {}),
						},
					};
				},
			});
			if (recorded) {
				await trackFileChange(ctx, ioPath, "write", backend, null, { evidenceRecorded: true });
				return recorded;
			}
			// Legacy/remote compatibility only: no v2 evidence or exact remote capability.
			// The whole read-modify-write window runs under the workspace write lock, so
			// a concurrent narrator sharing this worktree cannot interleave between the
			// baseline read and the write. It is milliseconds long, so holding it is free.
			return await withWorkspaceWriteLock(backend, baseCwd, async () => {
				// Read an existing file exactly once. The same complete content drives both
				// the required snapshot and encoding preservation, avoiding TOCTOU drift.
				const stat = await backend.statFile(ioPath);
				if (stat && !stat.isFile)
					throw new Error(`Write target is not a regular file: ${resolvedPath}`);
				let existingContent: string | null = null;
				let existingEncoding = "utf-8";
				let existingIsBinary = false;
				if (stat) {
					const { bytes } = await readCompleteFileBytes(backend, ioPath, {
						expectedResolvedPath: canonicalPath,
					});
					const decoded = decodeFileBytes(bytes);
					existingContent = decoded.text;
					existingEncoding = decoded.encoding;
					existingIsBinary = looksBinary(bytes);
				}
				await ensureFileSnapshot(
					ctx.narratorId,
					backend.deviceId,
					ioPath,
					async () => ({
						content: existingContent,
						encoding: existingEncoding,
						isBinary: existingIsBinary,
					}),
					"required",
				);

				await backend.mkdirp(backendDirname(backend, ioPath));
				// A rewrite keeps the file's own line endings, the same way it keeps its
				// encoding: a model writes LF, so overwriting a CRLF file with the raw
				// string converted the whole file and made `git diff` show every line as
				// changed. A file that did not exist keeps whatever the model wrote.
				const lineEnding = detectLineEnding(existingContent ?? content);
				const normalizedContent = normalizeLineEndings(content);
				await backend.writeFileBytes(
					resolvedPath,
					encodeFileBytes(applyLineEnding(normalizedContent, lineEnding), existingEncoding),
					{ expectedResolvedPath: canonicalPath },
				);
				// `existingContent` is null exactly when the file did not exist, which is
				// the distinction the client cannot make: a Write's input carries only the
				// NEW content, so nothing downstream can tell a fresh file from a rewrite.
				// A binary baseline is skipped — a line count over binary bytes is noise.
				//
				// Computed BEFORE the attribution call so ONE value feeds both the result
				// metadata (the card header) and the persisted attribution row (the
				// parent-facing aggregate). Two separate computations could disagree, and a
				// header contradicting the summary is unresolvable for the reader.
				// Both sides normalized, or a CRLF baseline against LF input reported every
				// line as replaced — a one-line rewrite would have claimed the whole file.
				const diffStats = existingIsBinary
					? null
					: wholeFileLineStats(
							existingContent === null ? null : normalizeLineEndings(existingContent),
							normalizedContent,
						);
				await trackFileChange(ctx, ioPath, "write", backend, diffStats);
				return {
					output: `Wrote ${content.length} bytes to ${file_path}`,
					title: file_path,
					metadata: {
						...lineStatsMetadata(diffStats),
						fileChangeEvidence: { version: 1, grade: "legacy_unverified" },
					},
				};
			});
		} catch (err) {
			return {
				output: `Error writing ${file_path}: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			};
		}
	},
};
