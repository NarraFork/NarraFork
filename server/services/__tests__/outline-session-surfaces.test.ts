/**
 * What an outline session (task backend `outline`, outline P2 PR 3) gets besides its task
 * source: the system prompt's task section, `spec://` closed to its tools, no taskReflection,
 * Dynamic Spec writes refused from every other path (the Spec panel, `/goal`'s writer, plugins)
 * except the behavior fence, the backend each creation path gives, and no outline tools by
 * default for its subagents (R16). Spec sessions keep what they had.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`; every case makes its own sessions.
 * `outline.enabled` is set before each case (the preload restores settings after it).
 */
import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { narrators } from "../../db/schema";
import { shouldRunTaskReflection } from "../../lib/agent/loop";
import { executeTool, getOutlineSpecRejection } from "../../lib/agent/tool-executor";
import { grantBehaviorFenceEdit } from "../../lib/agent/tools/behavior-fence-grant";
import { isOutlineTool } from "../../lib/agent/tools/outline-names";
import type { AgentConfig, AgentToolUse } from "../../lib/agent/types";
import { AppError } from "../../lib/errors";
import { generateId } from "../../lib/id";
import { logger } from "../../lib/logger";
import { getDynamicSpecSystemReminder, getOutlineTaskSystemReminder } from "../../lib/prompt-i18n";
import { settings } from "../../lib/settings";
import { toolNamesSpecPath } from "../../lib/spec-uri";
import "../../lib/agent/tools";
import { compileDelegationPolicy, resolveRuntimePolicy } from "../agent-runtime/policy";
import { buildEffectiveSystemPrompt, taskSectionFor } from "../narrator-prompt";
import { narratorService } from "../narrator-service";
import {
	addSpecTaskForPlugin,
	createNarratorForPlugin,
	readSpecTasksForPlugin,
	setSpecBehaviorFenceForPlugin,
	writeSpecForPlugin,
} from "../narrator-session";
import * as accessReads from "../outline/access-reads";
import {
	appendProtectedSpecTask,
	clearSpecTasks,
	readSpecFile,
	readTasksFileForNarrator,
	resetSpecNamespace,
	writeSpecFile,
} from "../spec-vfs-service";
import { invalidateTaskBackend, resolveTaskBackend } from "../task-source";

const NOW = "2026-10-31T00:00:00.000Z";

beforeEach(() => {
	settings.outline.enabled = true;
});

async function session(backend: "spec" | "outline" = "outline"): Promise<string> {
	const id = generateId();
	await db.insert(narrators).values({
		id,
		type: "primary",
		variant: "primary",
		traits: ["standalone"],
		status: "idle",
		taskBackend: backend,
		cwd: "/tmp",
		createdAt: NOW,
		updatedAt: NOW,
	});
	return id;
}

function expectRefused(error: unknown, messageCode = "SPEC_IN_OUTLINE_SESSION") {
	expect(error).toBeInstanceOf(AppError);
	expect((error as AppError).code).toBe("SPEC_OUTLINE_SESSION");
	expect((error as AppError).statusCode).toBe(409);
	expect((error as AppError).messageCode).toBe(messageCode as never);
}

async function refusal(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("expected the write to be refused");
}

describe("system prompt: the task section", () => {
	const base = { basePrompt: "BASE", cwd: "/tmp", locale: "en" as const };

	test("spec is the default and unchanged; outline carries the three conventions instead", async () => {
		const plain = await buildEffectiveSystemPrompt(base);
		const spec = await buildEffectiveSystemPrompt({ ...base, taskSection: "spec" });
		expect(spec).toEqual(plain);
		expect(plain.contract).toContain(getDynamicSpecSystemReminder("en"));

		const outline = await buildEffectiveSystemPrompt({ ...base, taskSection: "outline" });
		expect(outline.contract).toContain(getOutlineTaskSystemReminder("en"));
		expect(outline.contract).not.toContain("Dynamic Spec");
		expect(outline.contract).not.toContain("tasks.json");
		// The one spec:// path it names is the behavior fence (until plan PR 4).
		expect(outline.contract.match(/spec:\/\/[\w./-]+/g)).toEqual(["spec://behavior_fence"]);
		// The section takes the same place: everything around it is identical.
		expect(outline.contract.replace(getOutlineTaskSystemReminder("en"), "")).toBe(
			plain.contract.replace(getDynamicSpecSystemReminder("en"), ""),
		);
		expect(outline.parts).toEqual(plain.parts);

		const none = await buildEffectiveSystemPrompt({ ...base, taskSection: "none" });
		expect(none.contract).not.toContain("Dynamic Spec");
		expect(none.contract).not.toContain("# Outline");
	});

	test("the conventions in both locales, and which narrator gets which section", async () => {
		for (const locale of ["en", "zh-CN"] as const) {
			const text = getOutlineTaskSystemReminder(locale);
			expect(text).toContain("OutlineEdit");
			expect(text).toContain("session/");
			// Where a rule the user asks to record goes, until the behavior-fence page exists.
			expect(text.match(/spec:\/\/[\w./-]+/g)).toEqual(["spec://behavior_fence"]);
			expect(text).not.toContain("tasks.json");
		}
		expect(getOutlineTaskSystemReminder("zh-CN")).toContain("三条约定");
		expect(taskSectionFor("spec", "primary")).toBe("spec");
		expect(taskSectionFor("spec", "subagent")).toBe("spec");
		expect(taskSectionFor("outline", "primary")).toBe("outline");
		expect(taskSectionFor("outline", "subagent")).toBe("none");
	});
});

describe("spec:// in an outline session", () => {
	const call = (name: string, input: Record<string, unknown>): AgentToolUse => ({
		toolUseId: generateId(),
		name,
		input,
	});
	const routes: AgentToolUse[] = [
		call("Read", { file_path: "spec://tasks.json" }),
		call("Write", { file_path: "spec://tasks.json", content: '{"tasks":[]}' }),
		call("Edit", { file_path: "spec://index.md", old_string: "a", new_string: "b" }),
		call("Grep", { pattern: "x", path: "spec://" }),
		call("ExitPlanMode", { mode: "file", file_path: "spec://plan.md" }),
		call("Glob", { pattern: "spec://*.md" }),
	];

	test("every route to spec:// answers with the outline tools; spec sessions pass", () => {
		for (const tu of routes) {
			expect(toolNamesSpecPath(tu.name, tu.input)).toBe(true);
			const refused = getOutlineSpecRejection(tu, { taskBackend: "outline", locale: "en" });
			expect(refused?.isError).toBe(true);
			expect(refused?.output).toContain("OutlineEdit");
			expect(getOutlineSpecRejection(tu, { taskBackend: "spec" })).toBeUndefined();
			expect(getOutlineSpecRejection(tu, {})).toBeUndefined();
		}
		expect(
			getOutlineSpecRejection(routes[0] as AgentToolUse, {
				taskBackend: "outline",
				locale: "zh-CN",
			})?.output,
		).toContain("大纲");
		// Text that merely mentions spec:// is no route.
		for (const tu of [
			call("Bash", { command: "cat spec://tasks.json" }),
			call("Write", { file_path: "/tmp/notes.md", content: "see spec://tasks.json" }),
			call("Grep", { pattern: "spec://", path: "/tmp" }),
		]) {
			expect(toolNamesSpecPath(tu.name, tu.input)).toBe(false);
		}
	});

	test("executeTool writes nothing to the outline session's Dynamic Spec", async () => {
		const id = await session();
		const before = await readTasksFileForNarrator(id);
		const config = {
			narratorId: id,
			taskBackend: "outline",
			locale: "en",
			cwd: "/tmp",
			model: "test",
			provider: "test",
			signal: new AbortController().signal,
			permissionHandler: async () => ({ behavior: "allow" }),
		} as unknown as AgentConfig;
		const result = await executeTool(
			call("Write", {
				file_path: "spec://tasks.json",
				content: JSON.stringify({ tasks: [{ text: "x", status: "todo" }] }),
			}),
			config,
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("spec:// is not available in this session");
		expect((await readTasksFileForNarrator(id)).content).toBe(before.content);
	});

	test("the behavior fence stays reachable; writing it still needs the user-turn grant", async () => {
		const outline = { taskBackend: "outline" as const, locale: "en" };
		for (const tu of [
			call("Read", { file_path: "spec://behavior_fence" }),
			call("Write", { file_path: "spec://behavior_fence", content: "x" }),
			call("Edit", { file_path: "spec://behavior_fence", old_string: "a", new_string: "b" }),
		]) {
			expect(getOutlineSpecRejection(tu, outline)).toBeUndefined();
		}
		expect(
			getOutlineSpecRejection(
				call("Grep", { pattern: "x", path: "spec://behavior_fence" }),
				outline,
			)?.isError,
		).toBe(true);

		const id = await session();
		const config = {
			narratorId: id,
			taskBackend: "outline",
			locale: "en",
			cwd: "/tmp",
			model: "test",
			provider: "test",
			signal: new AbortController().signal,
			permissionHandler: async () => ({ behavior: "allow" }),
		} as unknown as AgentConfig;
		const write = () =>
			executeTool(
				call("Write", { file_path: "spec://behavior_fence", content: "Never force-push main." }),
				config,
			);
		// No grant (not the first tool call of a user turn): the fence's own rule answers.
		const denied = await write();
		expect(denied.isError).toBe(true);
		expect(denied.output).not.toContain("spec:// is not available");
		expect((await readSpecFile(id, "spec://behavior_fence")).content).not.toContain("force-push");
		// A real user turn opened the grant: the rule is recorded, as in a spec session.
		grantBehaviorFenceEdit(id);
		const recorded = await write();
		expect(recorded.isError).toBeFalsy();
		expect((await readSpecFile(id, "spec://behavior_fence")).content).toContain("force-push");
	});

	test("taskReflection never runs for an outline session", () => {
		expect(shouldRunTaskReflection({})).toBe(true);
		expect(shouldRunTaskReflection({ taskBackend: "spec" })).toBe(true);
		expect(shouldRunTaskReflection({ taskBackend: "outline" })).toBe(false);
	});
});

describe("Dynamic Spec writes from other paths", () => {
	test("the Spec panel's writes, clear, reset and /goal's writer are refused; the fence is not", async () => {
		const id = await session();
		expectRefused(
			await refusal(
				writeSpecFile(id, "spec://tasks.json", '{"tasks":[]}', {
					actor: "user",
					createdBy: "user",
				}),
			),
		);
		expectRefused(
			await refusal(writeSpecFile(id, "spec://index.md", "# notes", { actor: "user" })),
		);
		expectRefused(await refusal(clearSpecTasks(id)));
		expectRefused(await refusal(resetSpecNamespace(id)));
		expectRefused(await refusal(appendProtectedSpecTask(id, "Ship it")));
		await writeSpecFile(id, "spec://behavior_fence", "Never force-push.", { actor: "user" });
		expect((await readSpecFile(id, "spec://behavior_fence")).content).toBe("Never force-push.");
	});

	test("plugin task commands are refused, its fence command works", async () => {
		const id = await session();
		expectRefused(await refusal(addSpecTaskForPlugin(id, "Report back")));
		expectRefused(await refusal(writeSpecForPlugin(id, "spec://tasks.json", '{"tasks":[]}')));
		// Reading the task list too: an empty list would read as an idle member.
		expectRefused(await refusal(readSpecTasksForPlugin(id)));
		await setSpecBehaviorFenceForPlugin(id, "Report to the lead.", "upsert");
		expect((await readSpecFile(id, "spec://behavior_fence")).content).toContain(
			"Report to the lead.",
		);
	});

	test("spec sessions write as before; an outline session reads as spec while switched off", async () => {
		const spec = await session("spec");
		expect((await appendProtectedSpecTask(spec, "Ship it")).added).toBe(true);
		const outline = await session();
		settings.outline.enabled = false;
		expect((await appendProtectedSpecTask(outline, "Ship it")).added).toBe(true);
	});
});

describe("the task backend each creation path gives", () => {
	test("a new root session is outline while switched on, spec otherwise; explicit wins", async () => {
		const on = await narratorService.create({ cwd: "/tmp" });
		expect(on.taskBackend).toBe("outline");
		const explicit = await narratorService.create({ cwd: "/tmp", taskBackend: "spec" });
		expect(explicit.taskBackend).toBe("spec");
		settings.outline.enabled = false;
		const off = await narratorService.create({ cwd: "/tmp" });
		expect(off.taskBackend).toBe("spec");
	});

	test("a session a plugin recruits stays spec, so the plugin can dispatch to it", async () => {
		const { narratorId } = await createNarratorForPlugin({ title: "member", cwd: "/tmp" });
		expect((await narratorService.getById(narratorId)).taskBackend).toBe("spec");
		expect((await addSpecTaskForPlugin(narratorId, "Review PR 12")).added).toBe(true);
		expect((await readSpecTasksForPlugin(narratorId)).compiled.tasks.map((t) => t.text)).toEqual([
			"Review PR 12",
		]);
	});

	test("a read-only fork of an outline session skips the spec carryover quietly", async () => {
		const outline = await narratorService.create({ cwd: "/tmp" });
		const warn = spyOn(logger, "warn");
		try {
			const fork = await narratorService.forkNarrator(outline.id, null, {
				inheritMode: "fresh",
				specCarryover: "clear",
			});
			expect(fork.taskBackend).toBe("outline");
			expect(warn.mock.calls.some((args) => String(args[0]).includes("spec fork carryover"))).toBe(
				false,
			);
		} finally {
			warn.mockRestore();
		}
	});

	test("a fork keeps its parent's backend", async () => {
		const outline = await narratorService.create({ cwd: "/tmp" });
		const outlineFork = await narratorService.forkNarrator(outline.id, null, {
			inheritMode: "fresh",
		});
		expect(outlineFork.taskBackend).toBe("outline");
		settings.outline.enabled = false;
		const spec = await narratorService.create({ cwd: "/tmp" });
		settings.outline.enabled = true;
		const specFork = await narratorService.forkNarrator(spec.id, null, { inheritMode: "fresh" });
		expect(specFork.taskBackend).toBe("spec");
	});

	test("a subagent copies its session's backend and gets no outline tools under the outline", async () => {
		const outline = await narratorService.create({ cwd: "/tmp" });
		const { narratorId: sub } = await createNarratorForPlugin({
			type: "subagent",
			parentNarratorId: outline.id,
			subagentType: "general",
			cwd: "/tmp",
		});
		const row = await narratorService.getById(sub);
		expect(row.taskBackend).toBe("outline");
		const policy = resolveRuntimePolicy(
			(await import("../../lib/runtime-policy-trait")).parseRuntimePolicyTraits(row.traits),
		);
		expect(policy.tools.builtin).not.toBe("all");
		expect((policy.tools.builtin as readonly string[]).some(isOutlineTool)).toBe(false);

		await db.update(narrators).set({ taskBackend: "spec" }).where(eq(narrators.id, outline.id));
		const { narratorId: specSub } = await createNarratorForPlugin({
			type: "subagent",
			parentNarratorId: outline.id,
			subagentType: "general",
			cwd: "/tmp",
		});
		expect((await narratorService.getById(specSub)).taskBackend).toBe("spec");
	});
});

describe("the task backend cache", () => {
	test("kept per narrator: a failed read keeps it, the switch applies at once, invalidation reads again", async () => {
		const id = await session();
		const sub = generateId();
		await db.insert(narrators).values({
			id: sub,
			type: "subagent",
			variant: "subagent:general",
			parentNarratorId: id,
			aclRootNarratorId: id,
			status: "idle",
			createdAt: NOW,
			updatedAt: NOW,
		});
		expect(await resolveTaskBackend(id)).toBe("outline");
		expect(await resolveTaskBackend(sub)).toBe("outline");
		const read = spyOn(accessReads, "readNarratorTaskBackend").mockRejectedValue(
			new Error("database unavailable"),
		);
		try {
			// No read, so a failing database cannot flip the session to spec for a pass.
			expect(await resolveTaskBackend(id)).toBe("outline");
			expect(await resolveTaskBackend(sub)).toBe("outline");
			expect(read).not.toHaveBeenCalled();
			settings.outline.enabled = false;
			expect(await resolveTaskBackend(id)).toBe("spec");
			settings.outline.enabled = true;
		} finally {
			read.mockRestore();
		}
		// The column changes only at import, which invalidates: the session and its subagents.
		await db.update(narrators).set({ taskBackend: "spec" }).where(eq(narrators.id, id));
		expect(await resolveTaskBackend(id)).toBe("outline");
		invalidateTaskBackend(id);
		expect(await resolveTaskBackend(id)).toBe("spec");
		expect(await resolveTaskBackend(sub)).toBe("spec");
	});
});

describe("delegation ceilings (R16)", () => {
	const outlineTools = (input: Parameters<typeof compileDelegationPolicy>[0]) =>
		(compileDelegationPolicy(input).tools ?? []).filter(isOutlineTool);

	test("an outline session's built-in templates carry no outline tools; spec sessions keep them", () => {
		for (const template of ["general", "explore", "plan", "review"]) {
			expect(outlineTools({ template, outlineSession: true })).toEqual([]);
			expect(outlineTools({ template }).length).toBeGreaterThan(0);
		}
		const general = { toolAccess: "general" as const, customTools: [] };
		expect(
			outlineTools({ template: "mine", customDefinition: general, outlineSession: true }),
		).toEqual([]);
	});

	test("a custom template that names outline tools keeps them", () => {
		const custom = { toolAccess: "custom" as const, customTools: ["Read", "OutlineEdit"] };
		expect(
			outlineTools({ template: "mine", customDefinition: custom, outlineSession: true }),
		).toEqual(["OutlineEdit"]);
	});
});
