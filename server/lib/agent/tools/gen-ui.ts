import { GEN_UI_DIRECTORY } from "@shared/gen-ui-files";
import { UI_MARKUP_LIMITS } from "@shared/gen-ui-markup";
import { GEN_UI_ACTIONS, GEN_UI_TOOL_NAME, isGenUiReadAction } from "@shared/gen-ui-tool-policy";
import { z } from "zod/v4";
import { targetPathSemantics } from "../execution/path-semantics";
import type { ToolDefinition } from "../types";

// Field order is the order the model emits them, and `source` streams into the chat
// while it is still being written: everything that sizes or labels the card must be
// declared (and therefore arrive) before it.
export const genUiParameters = z
	.object({
		action: z.enum(GEN_UI_ACTIONS),
		prefix: z
			.string()
			.regex(/^[\p{L}\p{N}][\p{L}\p{N}_-]{0,47}$/u)
			.optional(),
		path: z.string().min(1).max(4096).optional(),
		title: z.string().min(1).max(80).optional(),
		size: z.enum(["sm", "md", "lg"]).optional(),
		wait: z.boolean().optional(),
		toolUseId: z.string().min(1).max(200).optional(),
		toolCallId: z.string().min(1).max(200).optional(),
		width: z.number().int().min(240).max(1600).optional(),
		height: z.number().int().min(240).max(1200).optional(),
		theme: z.enum(["light", "dark"]).optional(),
		// Retired: still parsed so a call already in flight is answered, never honoured.
		skip_build: z.boolean().optional(),
		source: z.string().min(1).max(UI_MARKUP_LIMITS.sourceChars).optional(),
	})
	.strict()
	.superRefine((input, ctx) => {
		const given = (key: keyof typeof input) => input[key] !== undefined;
		const only = (...allowed: Array<keyof typeof input>) =>
			(
				[
					"prefix",
					"path",
					"title",
					"size",
					"wait",
					"skip_build",
					"source",
					"toolUseId",
					"toolCallId",
					"width",
					"height",
					"theme",
				] as const
			).every((key) => allowed.includes(key) || !given(key));
		const valid =
			input.action === "create"
				? given("prefix") && only("prefix")
				: input.action === "show"
					? given("path") && only("path", "size")
					: input.action === "render"
						? given("source") && only("source", "title", "size", "wait")
						: input.action === "inspect"
							? given("toolUseId") &&
								given("toolCallId") &&
								only("toolUseId", "toolCallId", "width", "height", "theme")
							: input.action === "kit_build"
								? only("skip_build")
								: only();
		if (!valid)
			ctx.addIssue({
				code: "custom",
				message:
					"create takes only prefix; show takes path (+ size); render takes source (+ title, size, wait); inspect takes toolUseId and toolCallId (+ width, height, theme); kit_build and kit_status take nothing",
			});
	});
export type GenUiInput =
	| { action: "create"; prefix: string }
	| { action: "show"; path: string; size?: "sm" | "md" | "lg" }
	| {
			action: "render";
			source: string;
			title?: string;
			size?: "sm" | "md" | "lg";
			wait?: boolean;
	  }
	| {
			action: "inspect";
			toolUseId: string;
			toolCallId: string;
			width?: number;
			height?: number;
			theme?: "light" | "dark";
	  }
	| { action: "kit_status" }
	| { action: "kit_build"; skip_build?: boolean };

export const genUiTool: ToolDefinition = {
	name: GEN_UI_TOOL_NAME,
	description: `Show the user UI in the conversation. Two ways:

render({title, size, wait, source}) — the default. Draws markup inline in the chat while you write it: no build, no click. Use it for cards, tables, comparisons, forms, tabs, accordions, and controls that drive a preview.
- Components: every export of @mantine/core (Stack, Group, Card, Text, Title, Badge, Button, Table, Tabs, Accordion, TextInput, Textarea, NumberInput, Select, Checkbox, Switch, Radio, Slider, SegmentedControl, Progress, Alert…), dotted members such as <Tabs.List>, and plain HTML (div, p, ul, li, table, img, a…). With a project component kit its components replace Mantine; kit_status lists them. A misspelt tag is drawn as a placeholder and the result names the closest real one.
- source is JSX-like DATA, not code. Attributes are string/number/boolean literals, {[…]} / {{…}} literals, JSX ({<Icon />}) or $name. No other variables, no expressions, map(), hooks, imports or onChange: write repeated items out.
- State: bind="name" on a control (TextInput, Select, Slider, Checkbox, Switch, SegmentedControl, Radio.Group, Tabs…) keeps its value under that name, starting from defaultValue / defaultChecked; give every bound control one, or it starts empty. $name reads it anywhere: an attribute (radius={$radius}), a style ({{ borderRadius: $radius }}) or a child ({$radius}px). That is how one control drives the rest of the UI. A control without bind keeps its own value, which nothing else can read; never write a literal value= or checked=, it freezes the control.
- Handlers (onClick and other gesture props only): sendPrompt("text") sends text as the user's next message, with {name} replaced by that state's value at click time; submit("message") sends the message followed by every bound value as "name: value" lines; openLink("https://…") opens a link after the user confirms. Values reach you only through a click on one of these.
- wait: true makes it a form you wait on: the call stays open until the user clicks a submit() control, and its result is the bound values as JSON instead of a chat message (or that they closed it). Use it when you need their answers before going on; it needs a submit() control.
- Put title and size before source: "sm" (240px), "md" (400px, default) or "lg" (580px).
Example: <Stack gap="sm"><Title order={4}>Card corners</Title><Slider bind="radius" defaultValue={12} min={0} max={48} /><Card withBorder radius={$radius}><Text>border-radius: {$radius}px</Text></Card><TextInput bind="note" label="Note" /><Button onClick={submit("Use these settings")}>Apply</Button></Stack>

create({prefix}) then show({path, size}) — a full React app, only when markup cannot do it (arithmetic or conditions on values, lists that grow, timers, live data). create writes ${GEN_UI_DIRECTORY}/<prefix>-<id>/App.tsx. Edit it with the normal file tools: default-export a component; import react, @mantine/core, @mantine/hooks and relative files, or "kit" when the project has a kit; no other packages. Then show the directory: the app is built and runs inside the chat (only the latest one starts by itself; older ones wait for a click). To reach you, call globalThis.genUI.sendPrompt(text), genUI.submit(values, message?) or genUI.openLink(url) from a click handler; the user confirms each before it is sent.

kit_status() — optional: the project kit's components with props and examples, or how to author one. kit_build() — builds the project kit from ${GEN_UI_DIRECTORY}/kit/kit.json with the project's own Vite once the user confirms in the chat. The confirmation is requested for you; never ask for it repeatedly. A bundle you build yourself is never used.

inspect({toolUseId, toolCallId, width?, height?, theme?}) — check a completed render/show using the IDs in its result. Returns a screenshot and diagnostics; defaults to 960×640, dark. This replays current source and kit offline, not the user's live screen or form values. External resources and UI actions are disabled; resource warnings do not mean the app is broken. Requires a server-local workspace, execution permission and sandbox-enabled Chrome. Use it to check important UI and fix runtime errors.

Never put secrets in UI.`,
	parameters: genUiParameters,
	executionRouting: {
		kind: "single",
		resolve(input, config) {
			const workspace = config.workspaceContext;
			const cwd = workspace?.cwd ?? config.cwd;
			const paths = targetPathSemantics(workspace?.pathFlavor ?? "posix");
			return {
				key: "primary",
				operation: isGenUiReadAction(input.action) ? "read" : "write",
				deviceId: workspace?.deviceId ?? config.defaultDeviceId ?? "local",
				workdir: cwd,
				path:
					input.action === "show" && typeof input.path === "string"
						? input.path
						: paths.resolve(workspace?.git?.rootPath ?? cwd, GEN_UI_DIRECTORY),
			};
		},
	},
	formatValidationError: () =>
		"Use {action:'render',title,size,wait,source}, {action:'inspect',toolUseId,toolCallId,width,height,theme}, {action:'kit_status'}, {action:'kit_build'}, {action:'create',prefix:'safe-name'} or {action:'show',path:'directory-or-App.tsx',size}.",
	async execute(args, ctx) {
		try {
			const { executeGenUiTool } = await import("@server/services/gen-ui/runtime");
			return await executeGenUiTool(genUiParameters.parse(args) as GenUiInput, ctx);
		} catch (error) {
			return {
				output: error instanceof Error ? error.message.slice(0, 600) : "UI request failed",
				isError: true,
			};
		}
	},
};
