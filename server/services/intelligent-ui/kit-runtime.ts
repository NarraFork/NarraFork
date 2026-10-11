import type { ExecutionBackend } from "@server/lib/agent/execution/backend";
import type { ToolContext, ToolResult } from "@server/lib/agent/types";
import {
	describeIntelligentUiKitCatalog,
	INTELLIGENT_UI_KIT_DIRECTORY,
	type IntelligentUiKitNotice,
	type IntelligentUiKitRequest,
	type IntelligentUiKitStatus,
} from "@shared/intelligent-ui-kit";
import { findUnknownUiTags, parseUiMarkup, UI_MARKUP_LIMITS } from "@shared/intelligent-ui-markup";
import type { WorkspaceContext } from "@shared/workspace-context";
import { builtinComponentNames } from "./compiler";
import { type AuthorizeFile, uiError, workspaceKey } from "./files";
import { buildKit, type KitSnapshot, readKit } from "./kit";
import {
	consumeKitApproval,
	getKitRequest,
	hasKitApproval,
	requestKitBuild,
	suggestKitBuild,
} from "./kit-requests";

export type KitToolInput =
	| { action: "render"; source: string; title?: string; size?: "sm" | "md" | "lg" }
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
}

export const KIT_AUTHORING_GUIDE = `To make previews use THIS project's components instead of the built-in Mantine set:
1. Write ${INTELLIGENT_UI_KIT_DIRECTORY}/kit.json:
   {"version":1,"root":".","setup":"./setup.tsx","styles":["../../../src/index.css"],"components":[{"name":"Button","from":"@/components/ui/button","export":"Button","description":"Primary action","props":"variant?: 'primary' | 'ghost'; size?: 'sm' | 'md'","example":"<Button variant=\\"primary\\">Save</Button>"}]}
   - "from" is imported from the kit directory: use the project's import alias or a relative path.
   - "export" is a named export (defaults to name), "default", or "*" for a namespace used as <Name.Part>.
   - "root" is the directory holding the project's vite.config, relative to the workspace root.
   - List small reusable widgets (buttons, cards, inputs, layout primitives), not whole pages.
2. If components need providers or global CSS, write ${INTELLIGENT_UI_KIT_DIRECTORY}/setup.tsx default-exporting a component ({ children }) that mirrors what the app's entry file wraps around the app.
3. Call IntelligentUI {action:"kit_build"}. A build needs the user's confirmation, which they give in the chat UI.`;

const BUILD_PENDING =
	"The component kit build is waiting for the user's confirmation, shown to them in the chat. Carry on with other work; you will be told when it is approved. Do not call kit_build again before then.";

function authorizer(env: KitToolEnvironment): AuthorizeFile {
	return async (path) => {
		await env.authorizeRead(path);
		return path;
	};
}

function notice(
	status: IntelligentUiKitStatus,
	request: IntelligentUiKitRequest | null,
): IntelligentUiKitNotice {
	return {
		state: status.state,
		...(request ? { request: { id: request.id, kind: request.kind, state: request.state } } : {}),
	};
}

interface KitPrompt {
	/** Goes on this result's card: a new prompt, or an approval the agent should act on. */
	shown: IntelligentUiKitRequest | null;
	/** The workspace's open request, shown or not: what the agent is told about. */
	open: IntelligentUiKitRequest | null;
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
	let created: IntelligentUiKitRequest | null = null;
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
export async function kitNoticeFor(
	env: KitToolEnvironment,
): Promise<IntelligentUiKitNotice | undefined> {
	try {
		const snapshot = await readKit(env.backend, env.workspace, authorizer(env), env.ctx.signal);
		return notice(snapshot.status, (await suggest(env, snapshot)).shown);
	} catch {
		return undefined;
	}
}

function describeRequest(request: IntelligentUiKitRequest | null): string {
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
	const unknown = findUnknownUiTags(parsed.nodes, (name) => known.has(name));
	if (unknown.length > 0) {
		return {
			isError: true,
			output: `Nothing was rendered. Unknown tags: ${unknown
				.slice(0, 20)
				.map((name) => `<${name}>`)
				.join(", ")}. The ${project ? "project" : "built-in Mantine"} kit provides: ${available
				.slice(0, 200)
				.join(
					", ",
				)}. Plain HTML tags (div, span, p, h1-h6, ul, li, table, img, a…) are also allowed. Call kit_status for props and examples.`,
		};
	}
	const prompt = await suggest(env, snapshot);
	const problems = parsed.diagnostics
		.slice(0, 8)
		.map((item) => `- ${item.message} (offset ${item.offset})`);
	return {
		output: [
			`Rendered inline with the ${project ? "project's" : "built-in Mantine"} component kit (${parsed.elements} elements).`,
			...(problems.length ? [`Parts of the markup were ignored:\n${problems.join("\n")}`] : []),
			...(snapshot.status.state === "stale"
				? ["The kit is out of date; this used the last built bundle."]
				: []),
			...(snapshot.status.state === "invalid"
				? [`kit.json is invalid (${snapshot.status.reason}); fix it before the next build.`]
				: []),
			describeRequest(prompt.open).trim(),
		]
			.filter(Boolean)
			.join("\n"),
		title: input.title,
		metadata: {
			intelligentUiInline: { version: 1, kit: project ? "project" : "builtin" },
			intelligentUiKit: notice(snapshot.status, prompt.shown),
		},
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
			"No project component kit. UI renders with the built-in Mantine components (Stack, Group, Card, Text, Title, Button, Badge, Table, Tabs, TextInput, Select, Slider, Progress, Alert…).",
			KIT_AUTHORING_GUIDE,
		);
	} else {
		lines.push(
			`Project component kit: ${state}${builtAt ? ` (built ${builtAt})` : ""}${reason ? ` — ${reason}` : ""}.`,
		);
		if (snapshot.manifest) lines.push(describeIntelligentUiKitCatalog(snapshot.manifest));
		if (state !== "ready") lines.push(KIT_AUTHORING_GUIDE);
	}
	lines.push(describeRequest(request).trim());
	return {
		output: lines.filter(Boolean).join("\n\n"),
		metadata: { intelligentUiKit: notice(snapshot.status, request) },
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
			metadata: { intelligentUiKit: notice(before.status, request) },
		};
	}
	const result = await buildKit(env.backend, env.workspace, {
		authorize: authorizer(env),
		signal: env.ctx.signal,
		skipBuild: input.skip_build === true,
		async authorizeWrite(path) {
			await env.authorizeWrite(path);
			await env.check();
		},
	});
	if (!result.ok) {
		return {
			isError: true,
			// The approval is kept: fixing a manifest and retrying is one job, not two.
			output: `Component kit build failed.\nCommand (run in the Vite root): ${result.command}\n\n${result.log.slice(-6000)}\n\nFix kit.json or setup.tsx and call kit_build again; the user's approval still stands. If this project needs a different build command, run it yourself against the generated ${INTELLIGENT_UI_KIT_DIRECTORY}/vite.kit.config.mjs (it writes ${INTELLIGENT_UI_KIT_DIRECTORY}/${result.bundle}), then call kit_build with skip_build:true. The kit that was in use before this attempt is untouched.`,
			metadata: {
				intelligentUiKit: notice(result.status, getKitRequest(env.ctx.narratorId, key)),
			},
		};
	}
	consumeKitApproval(env.ctx.narratorId, key);
	return {
		output: `Built the component kit: ${result.status.components.length} components. Inline UI and previews in this workspace now use the project's components.\n\n${describeIntelligentUiKitCatalog(result.manifest)}`,
		metadata: { intelligentUiKit: notice(result.status, null) },
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
