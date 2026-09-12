import { extname } from "node:path";
import { z } from "zod/v4";
import { createPodmanDriver } from "../programmatic/podman-driver";
import { PROGRAMMATIC_LIMITS, ProgrammaticError } from "../programmatic/protocol";
import { createProgrammaticService } from "../programmatic/service";
import type { ToolContext, ToolDefinition } from "../types";

// Operator-only configuration. Neither model input nor /load can grant this capability.
export function readEvalConfiguration(env: NodeJS.ProcessEnv = process.env) {
	const imageId = env.NF_READONLY_EVAL_IMAGE?.trim();
	const narrators = new Set(
		(env.NF_READONLY_EVAL_NARRATORS ?? "")
			.split(",")
			.map((id) => id.trim())
			.filter(Boolean),
	);
	return imageId &&
		/^(?:sha256:)?[a-f0-9]{64}$/i.test(imageId) &&
		narrators.size > 0 &&
		narrators.size <= 16
		? { imageId: imageId.replace(/^sha256:/, "").toLowerCase(), narrators }
		: null;
}
const binaryExtensions = new Set([
	".pdf",
	".ipynb",
	".png",
	".jpg",
	".jpeg",
	".gif",
	".webp",
	".bmp",
	".svg",
	".avif",
	".heic",
]);
export const evalReadSchema = z
	.object({
		file_path: z.string().min(1).max(4096),
		offset: z.number().int().min(1).optional(),
		limit: z.number().int().min(1).max(200).optional(),
		device: z.string().min(1).max(128).optional(),
	})
	.strict()
	.refine(
		(input) => !binaryExtensions.has(extname(input.file_path).toLowerCase()),
		"Only bounded plain text reads are supported",
	);

let cached: { imageId: string; service: ReturnType<typeof createProgrammaticService> } | undefined;
function serviceFor(imageId: string) {
	if (cached && cached.imageId !== imageId && cached.service.activeRuns() > 0)
		throw new ProgrammaticError("CAPACITY", "Previous Eval isolation is still active");
	if (!cached || cached.imageId !== imageId)
		cached = {
			imageId,
			service: createProgrammaticService({ driver: createPodmanDriver({ imageId }) }),
		};
	return cached.service;
}
function requireAccess(ctx: ToolContext, imageId?: string) {
	const config = readEvalConfiguration();
	if (!config?.narrators.has(ctx.narratorId) || (imageId && config.imageId !== imageId))
		throw new ProgrammaticError("EVAL_DISABLED", "Read-only Eval is disabled for this narrator");
	if (!ctx.userId || !ctx.toolCallBinding || !ctx.executeRead || !ctx.recheckAuthorization)
		throw new ProgrammaticError(
			"EVAL_UNAVAILABLE",
			"Read-only Eval requires a bound authorization and audit bridge",
		);
	if (ctx.allowLocalExecution === false)
		throw new ProgrammaticError(
			"EVAL_UNAVAILABLE",
			"This narrator cannot run the local isolation driver",
		);
	if (ctx.signal.aborted) throw new ProgrammaticError("CANCELLED", "Eval was cancelled");
	return config;
}

export const evalTool: ToolDefinition = {
	name: "Eval",
	isAvailable: () => readEvalConfiguration() !== null,
	description:
		"Run bounded synchronous TypeScript with tools.Read({file_path, offset?, limit?, device?}) only. Read uses the narrator's existing permissions and audit trail. Results are {output, bounded:true}: a bounded view, never proof of the entire file. Use return for observations or deliver(value, optionalSummary) to finish this Eval. No async/await/import, filesystem/network globals, writes, Bash, agents, task mutations or recursion. Each Eval has fresh variables. Delivery ends only this tool, not the narrator turn or persistent work. Disabled unless explicitly configured by the operator for this narrator.",
	parameters: z.object({ code: z.string().min(1).max(PROGRAMMATIC_LIMITS.sourceBytes) }).strict(),
	async execute(args, ctx) {
		try {
			const config = requireAccess(ctx);
			await ctx.recheckAuthorization?.();
			requireAccess(ctx, config.imageId);
			const result = await serviceFor(config.imageId).execute({
				identity: {
					runId: crypto.randomUUID(),
					narratorId: ctx.narratorId,
					actorUserId: ctx.userId as string,
					outerToolCallId: ctx.toolCallBinding?.toolCallId as string,
					...(ctx.projectId ? { projectId: ctx.projectId } : {}),
				},
				source: args.code as string,
				signal: ctx.signal,
				receivers: [
					{
						id: "readonly-tools",
						name: "tools",
						methods: [
							{
								name: "Read",
								description:
									"Read up to 200 lines of plain text with the current narrator's permissions; returns a bounded view, not necessarily the full file.",
								effect: "read",
								validate(value) {
									if (!Array.isArray(value) || value.length !== 1)
										throw new Error("Read expects one argument object");
									return [evalReadSchema.parse(value[0])];
								},
								async invoke(value, call) {
									requireAccess(ctx, config.imageId);
									const input = evalReadSchema.parse((value as unknown[])[0]);
									const output = await ctx.executeRead?.(
										{ ...input, limit: input.limit ?? 100 },
										call.signal,
									);
									if (!output)
										throw new ProgrammaticError("EVAL_UNAVAILABLE", "Read bridge unavailable");
									if (output.isError)
										throw new ProgrammaticError(
											"READ_FAILED",
											output.output.slice(0, 1600),
											!!output.fatal,
										);
									if (output.images?.length || Buffer.byteLength(output.output) > 48 * 1024)
										throw new ProgrammaticError(
											"READ_OUTPUT_LIMIT",
											"Read result is not bounded text; narrow offset/limit",
											false,
										);
									return JSON.stringify({ output: output.output, bounded: true });
								},
							},
						],
					},
				],
				authorize: async () => {
					requireAccess(ctx, config.imageId);
					await ctx.recheckAuthorization?.();
					requireAccess(ctx, config.imageId);
					return true;
				},
				// The bridge persists each actual Read before permission/execution and stores
				// its final outcome. This pre-operation check validates the durable parent;
				// it is not a substitute log masquerading as child-call persistence.
				audit: async () => {
					requireAccess(ctx, config.imageId);
					await ctx.recheckAuthorization?.();
				},
			});
			return {
				output: JSON.stringify({
					ok: result.ok,
					...(result.ok
						? { value: result.result?.value, summary: result.result?.delivery?.summary }
						: { error: result.error }),
					logs: result.result?.logs ?? [],
					stats: result.stats,
					resourcesReleased: result.resourcesReleased,
				}),
				isError: !result.ok,
			};
		} catch (error) {
			return {
				output: error instanceof Error ? error.message : "Read-only Eval failed",
				isError: true,
			};
		}
	},
};
