import { INTELLIGENT_UI_DIRECTORY } from "@shared/intelligent-ui-files";
import { INTELLIGENT_UI_TOOL_NAME } from "@shared/intelligent-ui-tool-policy";
import { z } from "zod/v4";
import { targetPathSemantics } from "../execution/path-semantics";
import type { ToolDefinition } from "../types";

export const intelligentUiParameters = z
	.object({
		action: z.enum(["create", "show"]),
		prefix: z
			.string()
			.regex(/^[\p{L}\p{N}][\p{L}\p{N}_-]{0,47}$/u)
			.optional(),
		path: z.string().min(1).max(4096).optional(),
	})
	.strict()
	.superRefine((input, ctx) => {
		if (
			input.action === "create"
				? !input.prefix || input.path !== undefined
				: !input.path || input.prefix !== undefined
		)
			ctx.addIssue({
				code: "custom",
				message: "create requires only prefix; show requires only path",
			});
	});
export type IntelligentUiInput =
	| { action: "create"; prefix: string }
	| { action: "show"; path: string };

export const intelligentUiTool: ToolDefinition = {
	name: INTELLIGENT_UI_TOOL_NAME,
	description:
		"Create or preview ordinary React files in the current workspace. create({prefix}) exclusively creates .narrafork/intelligent_ui/<prefix>-<unique-id>/App.tsx at the current worktree root (cwd without Git). Edit files with normal Read/Write/Edit tools, then show({path}) the directory or App.tsx. App.tsx must default-export a React component. Relative TSX/TS/JS/JSON/CSS and image imports are supported; only react, react/jsx-runtime, react-dom/client, @mantine/core and @mantine/hooks are built in. No package/config/install step, project scripts, host API or model callbacks. The preview cannot use authenticated NF APIs. Local interactions stay in the preview. Never include secrets.",
	parameters: intelligentUiParameters,
	executionRouting: {
		kind: "single",
		resolve(input, config) {
			const workspace = config.workspaceContext;
			const cwd = workspace?.cwd ?? config.cwd;
			const paths = targetPathSemantics(workspace?.pathFlavor ?? "posix");
			return {
				key: "primary",
				operation: input.action === "show" ? "read" : "write",
				deviceId: workspace?.deviceId ?? config.defaultDeviceId ?? "local",
				workdir: cwd,
				path:
					input.action === "show" && typeof input.path === "string"
						? input.path
						: paths.resolve(workspace?.git?.rootPath ?? cwd, INTELLIGENT_UI_DIRECTORY),
			};
		},
	},
	formatValidationError: () =>
		"Use {action:'create',prefix:'safe-name'} or {action:'show',path:'directory-or-App.tsx'}.",
	async execute(args, ctx) {
		try {
			const { executeIntelligentUiTool } = await import("@server/services/intelligent-ui/runtime");
			return await executeIntelligentUiTool(
				intelligentUiParameters.parse(args) as IntelligentUiInput,
				ctx,
			);
		} catch (error) {
			return {
				output: error instanceof Error ? error.message.slice(0, 600) : "UI request failed",
				isError: true,
			};
		}
	},
};
