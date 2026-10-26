import type { ExecutionBackend } from "@server/lib/agent/execution/backend";
import type { ToolContext, ToolResult } from "@server/lib/agent/types";
import {
	assertRuntimeCanAskQuestion,
	runtimePolicyForContext,
} from "@server/services/agent-runtime/policy";
import {
	describeGenUiKitCatalog,
	GEN_UI_KIT_DIRECTORY,
	type GenUiKitNotice,
	type GenUiKitRequest,
	type GenUiKitStatus,
} from "@shared/gen-ui-kit";
import {
	collectUiState,
	findUnknownUiTags,
	isUiIntrinsicTag,
	parseUiMarkup,
	UI_MARKUP_LIMITS,
	visitElements,
} from "@shared/gen-ui-markup";
import type { WorkspaceContext } from "@shared/workspace-context";
import { builtinComponentNames } from "./compiler";
import { type AuthorizeFile, uiError, workspaceKey } from "./files";
import { describeGenUiFormOutcome, waitForGenUiForm } from "./form-wait";
import { buildKit, type KitBuildOptions, type KitSnapshot, readKit } from "./kit";
import {
	consumeKitApproval,
	getKitRequest,
	hasKitApproval,
	requestKitBuild,
	suggestKitBuild,
} from "./kit-requests";

export type KitToolInput =
	| {
			action: "render";
			source: string;
			title?: string;
			size?: "sm" | "md" | "lg";
			wait?: boolean;
	  }
	| { action: "kit_status" }
	| { action: "kit_build"; skip_build?: boolean };

export interface KitToolEnvironment {
	ctx: ToolContext;
	backend: ExecutionBackend;
	workspace: WorkspaceContext;
	/** Re-validates cancellation, workspace identity and permission after every await. */
	check(): Promise<void>;
	authorizeRead(path: string): Promise<void>;
	authorizeWrite(path: string): Promise<void>;
	/** Test seam forwarded to `buildKit`. Never set from anything the agent controls. */
	runCommand?: KitBuildOptions["runCommand"];
}

export const KIT_AUTHORING_GUIDE = `To make previews use THIS project's components instead of the built-in Mantine set:
1. Write ${GEN_UI_KIT_DIRECTORY}/kit.json:
   {"version":1,"root":".","setup":"./setup.tsx","styles":["../../../src/index.css"],"components":[{"name":"Button","from":"@/components/ui/button","export":"Button","description":"Primary action","props":"variant?: 'primary' | 'ghost'; size?: 'sm' | 'md'","example":"<Button variant=\\"primary\\">Save</Button>"}]}
   - "from" is imported from the kit directory: use the project's import alias or a relative path.
   - "export" is a named export (defaults to name), "default", or "*" for a namespace used as <Name.Part>.
   - "root" is the directory holding the project's vite.config, relative to the workspace root.
   - List small reusable widgets (buttons, cards, inputs, layout primitives), not whole pages.
2. If components need providers or global CSS, write ${GEN_UI_KIT_DIRECTORY}/setup.tsx default-exporting a component ({ children }) that mirrors what the app's entry file wraps around the app.
3. Call GenUI {action:"kit_build"}. A build needs the user's confirmation, which they give in the chat UI.`;

const BUILD_PENDING =
	"The component kit build is waiting for the user's confirmation, shown to them in the chat. Carry on with other work; you will be told when it is approved. Do not call kit_build again before then.";
const PREBUILT_REFUSED = `Nothing was built or recorded. A prebuilt bundle cannot be registered as the component kit: NarraFork runs the project's Vite build itself and signs the result. Call GenUI {action:"kit_build"} without skip_build; the user's approval still stands.`;

function authorizer(env: KitToolEnvironment): AuthorizeFile {
	return async (path) => {
		await env.authorizeRead(path);
		return path;
	};
}

function notice(status: GenUiKitStatus, request: GenUiKitRequest | null): GenUiKitNotice {
	return {
		state: status.state,
		...(request ? { request: { id: request.id, kind: request.kind, state: request.state } } : {}),
	};
}

interface KitPrompt {
	/** Goes on this result's card: a new prompt, or an approval the agent should act on. */
	shown: GenUiKitRequest | null;
	/** The workspace's open request, shown or not: what the agent is told about. */
	open: GenUiKitRequest | null;
}

/**
 * Whether to put a "build your kit?" prompt in front of the user. Passive and at most
 * once: a prompt already in the conversation is not repeated under every later result, a
 * workspace the user declined is not asked again, and one with no package.json is not a
 * frontend project worth asking about.
 */
async function suggest(env: KitToolEnvironment, snapshot: KitSnapshot): Promise<KitPrompt> {
	const key = workspaceKey(env.workspace);
	const narratorId = env.ctx.narratorId;
	const { state, reason } = snapshot.status;
	let created: GenUiKitRequest | null = null;
	if (state === "stale") {
		created = suggestKitBuild(narratorId, key, "update", reason ?? "The kit is out of date");
	} else if (state === "unbuilt") {
		created = suggestKitBuild(narratorId, key, "build", "kit.json has not been built yet");
	} else if (
		state === "builtin" &&
		(await env.backend.fileExists(
			env.backend.paths.resolve(snapshot.location.root, "package.json"),
		))
	) {
		created = suggestKitBuild(
			narratorId,
			key,
			"build",
			"This workspace has no component kit; previews use the built-in components",
		);
	}
	const open = getKitRequest(narratorId, key);
	return { shown: created ?? (open?.state === "approved" ? open : null), open };
}

/** Kit notice for a result that is not itself about the kit. Never fails its caller. */
export async function kitNoticeFor(env: KitToolEnvironment): Promise<GenUiKitNotice | undefined> {
	try {
		const snapshot = await readKit(env.backend, env.workspace, authorizer(env), env.ctx.signal);
		return notice(snapshot.status, (await suggest(env, snapshot)).shown);
	} catch {
		return undefined;
	}
}

/** Edit distance, bounded: names this far apart are not a typo of each other anyway. */
function distance(a: string, b: string, limit: number): number {
	if (Math.abs(a.length - b.length) > limit) return limit + 1;
	let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
	for (let i = 1; i <= a.length; i++) {
		const current = [i];
		for (let j = 1; j <= b.length; j++)
			current[j] = Math.min(
				(previous[j] as number) + 1,
				(current[j - 1] as number) + 1,
				(previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
			);
		previous = current;
	}
	return previous[b.length] as number;
}

/** Up to three available names the model most likely meant by `name`. */
export function closestComponentNames(name: string, available: readonly string[]): string[] {
	const wanted = (name.split(".")[0] ?? name).toLowerCase();
	const limit = Math.max(2, Math.floor(wanted.length / 3));
	return available
		.map((candidate) => {
			const lower = candidate.toLowerCase();
			const edits = distance(wanted, lower, limit);
			// A shared prefix (Text / TextInput) is a hint, never better than a near miss.
			const score =
				lower.startsWith(wanted) || wanted.startsWith(lower) ? Math.min(edits, 2) : edits;
			return { candidate, score };
		})
		.filter((entry) => entry.score <= limit)
		.sort((a, b) => a.score - b.score || a.candidate.length - b.candidate.length)
		.slice(0, 3)
		.map((entry) => entry.candidate);
}

/** One line per unknown tag, with the names the model most likely meant. */
function unknownTagLines(unknown: string[], available: readonly string[]): string {
	return unknown
		.slice(0, 12)
		.map((name) => {
			const close = closestComponentNames(name, available);
			return `- <${name}>${close.length ? `: did you mean ${close.map((item) => `<${item}>`).join(", ")}?` : /^[a-z]/.test(name) ? ": not an allowed HTML tag" : ": no similar component"}`;
		})
		.join("\n");
}

/**
 * What the agent is told about the kit prompt on a render. The user is asked once per
 * workspace, so the agent hears about it once too: repeating it under every render reads as
 * "every render bothers the user" and makes agents avoid re-rendering to fix mistakes.
 */
function describeRenderRequest(prompt: KitPrompt): string {
	if (prompt.shown?.state === "approved") return describeRequest(prompt.shown).trim();
	if (prompt.shown)
		return "The user has just been asked, once, whether to build a component kit for this workspace. Do not build until they confirm; you will be told if they do. Rendering again does not ask them again.";
	return "";
}

function describeRequest(request: GenUiKitRequest | null): string {
	if (!request) return "";
	return request.state === "approved"
		? "\nThe user has approved a kit build: call kit_build when you reach a natural stopping point."
		: "\nThe user has been asked whether to build or update the kit. Do not build until they confirm.";
}

async function render(
	input: Extract<KitToolInput, { action: "render" }>,
	env: KitToolEnvironment,
): Promise<ToolResult> {
	if (input.source.length > UI_MARKUP_LIMITS.sourceChars)
		throw uiError(`UI markup exceeds ${UI_MARKUP_LIMITS.sourceChars} characters`, 413);
	const parsed = parseUiMarkup(input.source);
	// Bare text is not UI: without a single element there is nothing a kit would draw.
	if (parsed.elements === 0) throw uiError("UI markup contains no elements to render", 422);
	const snapshot = await readKit(env.backend, env.workspace, authorizer(env), env.ctx.signal);
	await env.check();
	const project = snapshot.status.hash !== undefined;
	const available = project ? snapshot.status.components : await builtinComponentNames();
	const known = new Set(available);
	// Unknown tags are drawn as placeholders by the frame; refusing the whole UI for one
	// misspelt name cost a full round trip and taught agents to avoid components.
	const unknown = findUnknownUiTags(parsed.nodes, (name) => known.has(name));
	let drawable = 0;
	visitElements(parsed.nodes, (element) => {
		const { name } = element;
		if (isUiIntrinsicTag(name) || (/^[A-Z]/.test(name) && known.has(name.split(".")[0] as string)))
			drawable++;
	});
	// Only placeholders would appear: that is not a UI, so say plainly what exists instead.
	if (drawable === 0 && unknown.length > 0) {
		return {
			isError: true,
			output: `Nothing was rendered: none of these tags exist.\n${unknownTagLines(unknown, available)}\nThe ${project ? "project" : "built-in Mantine"} kit provides: ${available.slice(0, 200).join(", ")}. Plain HTML tags (div, span, p, h1-h6, ul, li, table, img, a…) are also allowed.`,
		};
	}
	const prompt = await suggest(env, snapshot);
	const state = collectUiState(parsed.nodes);
	const unbound = state.read.filter((name) => !state.bound.includes(name)).slice(0, 8);
	const problems = parsed.diagnostics
		.slice(0, 8)
		.map((item) => `- ${item.message} (offset ${item.offset})`);
	const metadata = {
		genUiInline: { version: 1, kit: project ? "project" : "builtin" },
		genUiInspection: { workspaceKey: workspaceKey(env.workspace) },
		genUiKit: notice(snapshot.status, prompt.shown),
	};
	const notes = [
		...(unknown.length
			? [
					`These tags do not exist and were drawn as dashed placeholders; the rest of the UI rendered. Fix them and render again:\n${unknownTagLines(unknown, available)}`,
				]
			: []),
		...(unbound.length
			? [
					`Nothing binds ${unbound.map((name) => `$${name}`).join(", ")}, so it shows nothing: add bind="${unbound[0]}" to the control that should hold it.`,
				]
			: []),
		...(problems.length ? [`Parts of the markup were ignored:\n${problems.join("\n")}`] : []),
		...(snapshot.status.state === "stale"
			? ["The kit is out of date; this used the last built bundle."]
			: []),
		...(snapshot.status.state === "invalid"
			? [`kit.json is invalid (${snapshot.status.reason}); fix it before the next build.`]
			: []),
		describeRenderRequest(prompt),
		`Inspect: ${JSON.stringify({ action: "inspect", toolUseId: env.ctx.currentToolUseId, toolCallId: env.ctx.toolCallBinding?.toolCallId })}`,
	];
	if (input.wait) return waitForForm(input, env, state.actions, notes, metadata);
	return {
		output: [
			`Rendered inline with the ${project ? "project's" : "built-in Mantine"} component kit (${parsed.elements} elements). The user sees it in the chat now. Values they type or pick stay in the card until they click a sendPrompt or submit control.`,
			...notes,
		]
			.filter(Boolean)
			.join("\n"),
		title: input.title,
		metadata,
	};
}

/**
 * A `wait: true` render: the UI is already in the chat (it streamed from the input), so
 * what is left is holding the call open until the reader answers it.
 */
async function waitForForm(
	input: Extract<KitToolInput, { action: "render" }>,
	env: KitToolEnvironment,
	actions: string[],
	notes: string[],
	metadata: ToolResult["metadata"],
): Promise<ToolResult> {
	const toolUseId = env.ctx.currentToolUseId;
	const refusal = !actions.includes("submit")
		? "Nothing was shown: wait: true needs a submit() control and this UI has none. Add a button with onClick={submit()} and render again."
		: !toolUseId
			? "This call cannot wait for a form; render it without wait."
			: (() => {
					try {
						assertRuntimeCanAskQuestion(runtimePolicyForContext(env.ctx));
						return null;
					} catch {
						return "Nothing was shown: nobody can answer a form in this session, so wait: true is unavailable. Render without wait, or carry on with sensible defaults.";
					}
				})();
	if (refusal || !toolUseId)
		return {
			output: [refusal ?? "", ...notes].filter(Boolean).join("\n"),
			isError: true,
			title: input.title,
			metadata,
		};
	const outcome = await waitForGenUiForm({
		narratorId: env.ctx.narratorId,
		toolUseId,
		signal: env.ctx.signal,
	});
	const answer = describeGenUiFormOutcome(outcome);
	return {
		output: [answer.output, ...notes].filter(Boolean).join("\n"),
		...(answer.isError ? { isError: true } : {}),
		title: input.title,
		metadata: { ...metadata, genUiForm: { version: 1, status: outcome.status } },
	};
}

async function status(env: KitToolEnvironment): Promise<ToolResult> {
	const snapshot = await readKit(env.backend, env.workspace, authorizer(env), env.ctx.signal);
	await env.check();
	const request = getKitRequest(env.ctx.narratorId, workspaceKey(env.workspace));
	const { state, reason, builtAt } = snapshot.status;
	const lines: string[] = [];
	if (state === "builtin") {
		lines.push(
			"No project component kit. UI renders with the built-in components: every export of @mantine/core (Stack, Group, Card, Text, Title, Button, Badge, Table, Tabs, Accordion, TextInput, Select, Checkbox, Slider, SegmentedControl, Progress, Alert…). You do not need a kit to render.",
			KIT_AUTHORING_GUIDE,
		);
	} else {
		lines.push(
			`Project component kit: ${state}${builtAt ? ` (built ${builtAt})` : ""}${reason ? ` — ${reason}` : ""}.`,
		);
		if (snapshot.manifest) lines.push(describeGenUiKitCatalog(snapshot.manifest));
		if (state !== "ready") lines.push(KIT_AUTHORING_GUIDE);
	}
	lines.push(describeRequest(request).trim());
	return {
		output: lines.filter(Boolean).join("\n\n"),
		metadata: { genUiKit: notice(snapshot.status, request) },
	};
}

async function build(
	input: Extract<KitToolInput, { action: "kit_build" }>,
	env: KitToolEnvironment,
): Promise<ToolResult> {
	const key = workspaceKey(env.workspace);
	const before = await readKit(env.backend, env.workspace, authorizer(env), env.ctx.signal);
	await env.check();
	if (!hasKitApproval(env.ctx.narratorId, key)) {
		// The agent asked for it explicitly, so a previously declined prompt is re-opened.
		const request = requestKitBuild(
			env.ctx.narratorId,
			key,
			before.status.hash ? "update" : "build",
			"The agent wants to build the project's component kit",
			true,
		);
		return {
			output: BUILD_PENDING,
			metadata: { genUiKit: notice(before.status, request) },
		};
	}
	// Accepted by the schema so a call in flight still parses, but a file the agent built
	// is not something the host can vouch for. The approval is left for the real build.
	if (input.skip_build === true) {
		return {
			isError: true,
			output: PREBUILT_REFUSED,
			metadata: {
				genUiKit: notice(before.status, getKitRequest(env.ctx.narratorId, key)),
			},
		};
	}
	const result = await buildKit(env.backend, env.workspace, {
		authorize: authorizer(env),
		signal: env.ctx.signal,
		...(env.runCommand ? { runCommand: env.runCommand } : {}),
		async authorizeWrite(path) {
			await env.authorizeWrite(path);
			await env.check();
		},
	});
	if (!result.ok) {
		return {
			isError: true,
			// The approval is kept: fixing a manifest and retrying is one job, not two.
			output: `Component kit build failed.\nCommand (NarraFork ran it in the Vite root): ${result.command}\n\n${result.log.slice(-6000)}\n\nFix kit.json, setup.tsx or the project's build setup and call kit_build again; the user's approval still stands. The kit that was in use before this attempt is untouched.`,
			metadata: {
				genUiKit: notice(result.status, getKitRequest(env.ctx.narratorId, key)),
			},
		};
	}
	consumeKitApproval(env.ctx.narratorId, key);
	return {
		output: `Built the component kit: ${result.status.components.length} components. Inline UI and previews in this workspace now use the project's components.\n\n${describeGenUiKitCatalog(result.manifest)}`,
		metadata: { genUiKit: notice(result.status, null) },
	};
}

export async function executeKitAction(
	input: KitToolInput,
	env: KitToolEnvironment,
): Promise<ToolResult> {
	if (input.action === "render") return render(input, env);
	if (input.action === "kit_status") return status(env);
	return build(input, env);
}
