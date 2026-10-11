import { INTELLIGENT_UI_DIRECTORY } from "@shared/intelligent-ui-files";
import { UI_MARKUP_LIMITS } from "@shared/intelligent-ui-markup";
import {
	INTELLIGENT_UI_ACTIONS,
	INTELLIGENT_UI_TOOL_NAME,
	isIntelligentUiReadAction,
} from "@shared/intelligent-ui-tool-policy";
import { z } from "zod/v4";
import { targetPathSemantics } from "../execution/path-semantics";
import type { ToolDefinition } from "../types";

// Field order is the order the model emits them, and `source` streams into the chat
// while it is still being written: everything that sizes or labels the card must be
// declared (and therefore arrive) before it.
export const intelligentUiParameters = z
	.object({
		action: z.enum(INTELLIGENT_UI_ACTIONS),
		prefix: z
			.string()
			.regex(/^[\p{L}\p{N}][\p{L}\p{N}_-]{0,47}$/u)
			.optional(),
		path: z.string().min(1).max(4096).optional(),
		title: z.string().min(1).max(80).optional(),
		size: z.enum(["sm", "md", "lg"]).optional(),
		skip_build: z.boolean().optional(),
		source: z.string().min(1).max(UI_MARKUP_LIMITS.sourceChars).optional(),
	})
	.strict()
	.superRefine((input, ctx) => {
		const given = (key: keyof typeof input) => input[key] !== undefined;
		const only = (...allowed: Array<keyof typeof input>) =>
			(["prefix", "path", "title", "size", "skip_build", "source"] as const).every(
				(key) => allowed.includes(key) || !given(key),
			);
		const valid =
			input.action === "create"
				? given("prefix") && only("prefix")
				: input.action === "show"
					? given("path") && only("path")
					: input.action === "render"
						? given("source") && only("source", "title", "size")
						: input.action === "kit_build"
							? only("skip_build")
							: only();
		if (!valid)
			ctx.addIssue({
				code: "custom",
				message:
					"create takes only prefix; show takes only path; render takes source (+ title, size); kit_build takes only skip_build; kit_status takes nothing",
			});
	});
export type IntelligentUiInput =
	| { action: "create"; prefix: string }
	| { action: "show"; path: string }
	| { action: "render"; source: string; title?: string; size?: "sm" | "md" | "lg" }
	| { action: "kit_status" }
	| { action: "kit_build"; skip_build?: boolean };

export const intelligentUiTool: ToolDefinition = {
	name: INTELLIGENT_UI_TOOL_NAME,
	description: `Show the user real UI in the conversation, composed from this project's own components.

render({title, size, source}) draws UI inline in the chat WHILE you write it. source is JSX-like markup, not code: tags are component names from the component kit (dotted members such as <Tabs.List> work) or plain HTML tags; attributes are string/number/boolean literals, {[…]} / {{…}} array and object literals, or JSX ({<Icon />}). No variables, expressions, map(), hooks or imports: write repeated items out. Lay out with the kit's own layout components rather than ad-hoc class names. Two handlers exist: onClick={sendPrompt("text")} sends text to the chat as the user's next message, onClick={openLink("https://…")} opens a link. Put title and size ("sm" | "md" | "lg") before source. Example: <Stack gap="sm"><Title order={4}>Plans</Title><Group><Badge color="green">Active</Badge><Button onClick={sendPrompt("Compare the plans")}>Compare</Button></Group></Stack>

kit_status() lists the kit's components with props and examples; call it before your first render in a workspace. With no project kit the built-in Mantine components are used.

kit_build({skip_build?}) builds the project's component kit from ${INTELLIGENT_UI_DIRECTORY}/kit/kit.json using the project's own Vite. It only runs after the user confirms in the chat UI; the confirmation is requested for you. Never ask for it repeatedly.

create({prefix}) / show({path}) are for a full interactive app instead of markup: create makes ${INTELLIGENT_UI_DIRECTORY}/<prefix>-<id>/App.tsx, you edit it with the normal file tools, then show the directory. App.tsx default-exports a React component; it may import relative files and, with a project kit, components from "kit" (otherwise react, @mantine/core and @mantine/hooks). No other packages, no host API.

Never put secrets in UI.`,
	parameters: intelligentUiParameters,
	executionRouting: {
		kind: "single",
		resolve(input, config) {
			const workspace = config.workspaceContext;
			const cwd = workspace?.cwd ?? config.cwd;
			const paths = targetPathSemantics(workspace?.pathFlavor ?? "posix");
			return {
				key: "primary",
				operation: isIntelligentUiReadAction(input.action) ? "read" : "write",
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
		"Use {action:'render',title,size,source}, {action:'kit_status'}, {action:'kit_build'}, {action:'create',prefix:'safe-name'} or {action:'show',path:'directory-or-App.tsx'}.",
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
