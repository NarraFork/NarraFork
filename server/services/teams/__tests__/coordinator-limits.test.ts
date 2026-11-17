/**
 * A team coordinator's soft limits (docs/PROJECT_TEAMS-PLAN.md §二.2, T4; P2): every call runs
 * exactly as it would anyway, a call over a suggested value gets one deterministic reminder per
 * kind, a large output is saved whole and shown as head + tail + path, and each overrun is
 * recorded as a `team_work_events` row off the tool path.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod/v4";

const previousHome = process.env.NARRAFORK_HOME;
const testHome = mkdtempSync(join(tmpdir(), "narrafork-coordinator-limits-"));
process.env.NARRAFORK_HOME = testHome;
process.env.NARRAFORK_ALLOW_MULTIPLE = "1";

const { db } = await import("../../../db");
const { and, eq, like } = await import("drizzle-orm");
const { projects, teamWorkEvents, users } = await import("../../../db/schema");
const { generateId } = await import("../../../lib/id");
const { executeTool } = await import("../../../lib/agent/tool-executor");
const { toolRegistry } = await import("../../../lib/agent/tool-registry");
const { OUTPUT_DIR } = await import("../../../lib/agent/truncate");
const { coordinatorOutputsDir } = await import("../../../lib/coordinator-outputs-path");
const { resolvePermissionDecision } = await import("../../narrator-permission");
await import("../../../lib/agent/tools/index");
const { narratorService } = await import("../../narrator-service");
const { createTeam, updateTeam } = await import("../team-service");
const limitsModule = await import("../coordinator-limits");
const {
	beginCoordinatorRun,
	coordinatorToolAnnotatorFor,
	countOutputLines,
	createCoordinatorToolAnnotator,
	headAndTail,
	setCoordinatorOverrunRecorder,
} = limitsModule;
const { DEFAULT_COORDINATOR_LIMITS } = await import("@shared/project-teams");

type AgentConfig = import("../../../lib/agent/types").AgentConfig;
type AgentToolUse = import("../../../lib/agent/types").AgentToolUse;
type ToolCallBinding = import("../../../lib/agent/types").ToolCallBinding;
type ToolResult = import("../../../lib/agent/types").ToolResult;

const OWNER = "limits-owner";
const repo = join(testHome, "repo");
let teamId: string;
let plainId: string;
const REMINDER = "[Coordinator limit]";

/** Saved outputs this file produced, removed at the end. */
const savedPaths = new Set<string>();
const savedPathOf = (output: string) => {
	const path = /saved at (\S+);/.exec(output)?.[1];
	if (path) savedPaths.add(path);
	return path;
};

afterAll(() => {
	for (const path of savedPaths) rmSync(path, { force: true });
	if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = previousHome;
	rmSync(testHome, { recursive: true, force: true });
});

beforeAll(async () => {
	mkdirSync(repo, { recursive: true });
	const now = new Date().toISOString();
	await db.insert(users).values({
		id: OWNER,
		username: `${OWNER}-${Date.now()}`,
		passwordHash: "x",
		role: "user",
		createdAt: now,
	});
	const projectId = generateId();
	await db.insert(projects).values({
		id: projectId,
		name: "limits project",
		gitPath: repo,
		defaultBranch: "main",
		ownerUserId: OWNER,
		visibility: "private",
		createdAt: now,
		updatedAt: now,
	});
	const team = await createTeam({ projectId, name: "Limits" }, { userId: OWNER, isAdmin: false });
	teamId = team.id;
	const plain = await narratorService.create({ title: "Plain session", cwd: repo });
	plainId = plain.id;
});

const recorded: Array<{ teamId: string; kind: string; size: number; limit: number; tool: string }> =
	[];
let previousRecorder: ReturnType<typeof setCoordinatorOverrunRecorder> = null;

function captureEvents() {
	recorded.length = 0;
	previousRecorder = setCoordinatorOverrunRecorder((id, tool, overrun) => {
		recorded.push({ teamId: id, ...overrun, tool });
	});
}

afterEach(() => {
	setCoordinatorOverrunRecorder(previousRecorder);
	previousRecorder = null;
});

/** Let the deferred event writes run. */
const flushEvents = () => new Promise((resolve) => setTimeout(resolve, 5));

function makeConfig(extra: Partial<AgentConfig> = {}): AgentConfig {
	return {
		narratorId: teamId,
		conversationId: "conversation-limits",
		model: "test",
		provider: "test",
		cwd: repo,
		signal: new AbortController().signal,
		permissionHandler: async () => ({ behavior: "allow" }),
		requireToolCallBinding: true,
		toolExecutionBindings: new (class extends WeakMap<AgentToolUse, ToolCallBinding> {
			override get(tool: AgentToolUse): ToolCallBinding {
				const binding = super.get(tool) ?? { toolCallId: `row-${tool.toolUseId}`, attempt: 1 };
				super.set(tool, binding);
				return binding;
			}
		})(),
		onToolExecutionStarting: async (_toolUseId, binding) => binding,
		onToolExecutionFinalAuthorization: async () => ({ assertStillCurrent() {} }),
		recordToolNoDispatch: async () => {},
		...extra,
	};
}

/**
 * Run a stand-in for a real tool through `executeTool`: it records every invocation and returns
 * the given result, so the test sees exactly what the tool did and what came back.
 */
async function runFake(
	name: string,
	input: Record<string, unknown>,
	result: ToolResult,
	config: AgentConfig,
): Promise<{ output: string; calls: Array<Record<string, unknown>> }> {
	const calls: Array<Record<string, unknown>> = [];
	const previous = toolRegistry.get(name);
	toolRegistry.register({
		name,
		description: `stand-in for ${name}`,
		parameters: z.record(z.string(), z.unknown()),
		execute: async (args: unknown) => {
			calls.push(structuredClone(args as Record<string, unknown>));
			return { ...result };
		},
	});
	try {
		const out = await executeTool({ toolUseId: `tu-${generateId()}`, name, input }, config);
		savedPathOf(out.output);
		return { output: out.output, calls };
	} finally {
		if (previous) toolRegistry.register(previous);
		else toolRegistry.unregister(name);
	}
}

const lines = (count: number, prefix = "line") =>
	Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`).join("\n");
const reminders = (text: string) => text.split(REMINDER).length - 1;

function coordinatorConfig(locale: "en" | "zh-CN" = "en") {
	const annotate = coordinatorToolAnnotatorFor(teamId, locale);
	if (!annotate) throw new Error("expected an annotator for the coordinator");
	return makeConfig({ annotateToolResult: annotate, locale });
}

describe("each overrun kind: one reminder, the call unchanged", () => {
	test("Edit over the edit limit", async () => {
		captureEvents();
		beginCoordinatorRun(teamId);
		const input = { file_path: "src/a.ts", old_string: lines(10), new_string: lines(84) };
		const { output, calls } = await runFake(
			"Edit",
			input,
			{ output: "Edited src/a.ts", metadata: { linesAdded: 74, linesRemoved: 0 } },
			coordinatorConfig(),
		);
		expect(calls).toEqual([input]);
		expect(output.startsWith("Edited src/a.ts\n\n")).toBe(true);
		expect(reminders(output)).toBe(1);
		expect(output).toContain("This Edit changed 84 lines");
		expect(output).toContain("is 30 lines per edit");
		expect(output).toContain("hand work like this to a subagent");
		await flushEvents();
		expect(recorded).toEqual([{ teamId, kind: "editLines", size: 84, limit: 30, tool: "Edit" }]);
	});

	test("Write of a new file over the new-file limit; an existing file counts as an edit", async () => {
		captureEvents();
		beginCoordinatorRun(teamId);
		const content = `${lines(61)}\n`;
		const created = await runFake(
			"Write",
			{ file_path: "src/new.ts", content },
			{ output: "Wrote", metadata: { linesAdded: 61, linesRemoved: 0 } },
			coordinatorConfig(),
		);
		expect(created.calls).toHaveLength(1);
		expect(reminders(created.output)).toBe(1);
		expect(created.output).toContain("wrote a new file of 61 lines");
		const rewritten = await runFake(
			"Write",
			{ file_path: "src/old.ts", content },
			{ output: "Wrote", metadata: { linesAdded: 3, linesRemoved: 2 } },
			coordinatorConfig(),
		);
		expect(reminders(rewritten.output)).toBe(1);
		expect(rewritten.output).toContain("This Write changed 61 lines");
		await flushEvents();
		expect(recorded.map((event) => event.kind)).toEqual(["newFileLines", "editLines"]);
	});

	test("the fourth file of a turn; the same file again and a new run do not count", async () => {
		captureEvents();
		beginCoordinatorRun(teamId);
		const config = coordinatorConfig();
		const edit = (file: string) =>
			runFake(
				"Edit",
				{ file_path: file, old_string: "a", new_string: "b" },
				{ output: `Edited ${file}`, metadata: { linesAdded: 1, linesRemoved: 1 } },
				config,
			);
		for (const file of ["one.ts", "two.ts", "three.ts", "one.ts"])
			expect(reminders((await edit(file)).output)).toBe(0);
		const fourth = await edit("four.ts");
		expect(fourth.calls).toHaveLength(1);
		expect(reminders(fourth.output)).toBe(1);
		expect(fourth.output).toContain("This turn has now changed 4 files");
		// The same file again in this turn adds nothing.
		expect(reminders((await edit("four.ts")).output)).toBe(0);
		// A failed edit changes no file.
		const failed = await runFake(
			"Edit",
			{ file_path: "five.ts", old_string: "a", new_string: "b" },
			{ output: "old_string not found", isError: true },
			config,
		);
		expect(reminders(failed.output)).toBe(0);
		beginCoordinatorRun(teamId);
		expect(reminders((await edit("five.ts")).output)).toBe(0);
		await flushEvents();
		expect(recorded).toEqual([{ teamId, kind: "filesPerTurn", size: 4, limit: 3, tool: "Edit" }]);
	});

	for (const [tool, kind, limit] of [
		["Read", "readLines", 300],
		["Grep", "searchLines", 100],
		["Glob", "searchLines", 100],
	] as const) {
		test(`${tool} over its line limit: head + tail + the saved full result`, async () => {
			captureEvents();
			const full = lines(limit + 200);
			const { output, calls } = await runFake(
				tool,
				{ file_path: "big.txt", pattern: "x" },
				{ output: full },
				coordinatorConfig(),
			);
			expect(calls).toHaveLength(1);
			expect(reminders(output)).toBe(1);
			expect(output.startsWith("line 1\nline 2\n")).toBe(true);
			expect(output).toContain(`line ${limit + 200}\n\n${REMINDER}`);
			expect(output).toContain(`returned ${limit + 200} lines`);
			const path = savedPathOf(output);
			expect(path?.startsWith(`${coordinatorOutputsDir(teamId)}/`)).toBe(true);
			expect(readFileSync(path as string, "utf8")).toBe(full);
			expect(output).toContain("not shown here");
			expect(countOutputLines(output)).toBeLessThan(countOutputLines(full));
			await flushEvents();
			expect(recorded).toEqual([{ teamId, kind, size: limit + 200, limit, tool }]);
		});
	}

	test("Bash output over its byte limit: head + tail + the saved full result", async () => {
		captureEvents();
		const full = `${"a".repeat(6000)}\n${"m".repeat(6000)}\n${"z".repeat(6000)}`;
		const { output, calls } = await runFake(
			"Bash",
			{ command: "make" },
			{ output: full, isError: true },
			coordinatorConfig(),
		);
		expect(calls).toEqual([{ command: "make" }]);
		expect(reminders(output)).toBe(1);
		expect(output.startsWith("aaaa")).toBe(true);
		expect(output).toContain(`zzzz\n\n${REMINDER}`);
		expect(output).not.toContain("mmmm");
		expect(output).toContain("output is 18002 bytes");
		const path = savedPathOf(output) as string;
		expect(readFileSync(path, "utf8")).toBe(full);
		await flushEvents();
		expect(recorded).toEqual([
			{ teamId, kind: "bashOutputBytes", size: 18002, limit: 8192, tool: "Bash" },
		]);
	});

	test("one Read of the saved file returns it whole, with no reminder", async () => {
		captureEvents();
		const full = lines(1000);
		const first = await runFake(
			"Read",
			{ file_path: "big.txt" },
			{ output: full },
			coordinatorConfig(),
		);
		const path = savedPathOf(first.output) as string;
		const again = await runFake(
			"Read",
			{ file_path: path },
			{ output: readFileSync(path, "utf8") },
			coordinatorConfig(),
		);
		expect(again.output).toBe(full);
		await flushEvents();
		expect(recorded).toHaveLength(1);
	});

	test("within every limit: the output is untouched and nothing is recorded", async () => {
		captureEvents();
		beginCoordinatorRun(teamId);
		const config = coordinatorConfig();
		const small = [
			runFake("Read", { file_path: "a" }, { output: lines(300) }, config),
			runFake("Grep", { pattern: "a" }, { output: lines(100) }, config),
			runFake("Bash", { command: "ls" }, { output: "x".repeat(8192) }, config),
			runFake(
				"Edit",
				{ file_path: "a.ts", old_string: lines(30), new_string: lines(30) },
				{ output: "Edited a.ts" },
				config,
			),
		];
		const outputs = (await Promise.all(small)).map((result) => result.output);
		expect(outputs).toEqual([lines(300), lines(100), "x".repeat(8192), "Edited a.ts"]);
		await flushEvents();
		expect(recorded).toEqual([]);
	});

	test("two kinds over in one call: two reminders", async () => {
		captureEvents();
		beginCoordinatorRun(teamId);
		const config = coordinatorConfig();
		for (const file of ["p.ts", "q.ts", "r.ts"])
			await runFake(
				"Edit",
				{ file_path: file, old_string: "a", new_string: "b" },
				{ output: "ok" },
				config,
			);
		const both = await runFake(
			"Edit",
			{ file_path: "s.ts", old_string: "a", new_string: lines(40) },
			{ output: "ok" },
			config,
		);
		expect(reminders(both.output)).toBe(2);
		await flushEvents();
		expect(recorded.map((event) => event.kind)).toEqual(["editLines", "filesPerTurn"]);
	});
});

describe("who gets reminders, in which words", () => {
	test("a session without the team trait gets no annotator and unchanged results", async () => {
		expect(coordinatorToolAnnotatorFor(plainId, "en")).toBeUndefined();
		const { output } = await runFake(
			"Bash",
			{ command: "cat big" },
			{ output: "x".repeat(50_000) },
			makeConfig({ narratorId: plainId }),
		);
		// Only the executor's own long-standing truncation applies; no coordinator reminder.
		expect(reminders(output)).toBe(0);
	});

	test("the orchestrator builds the annotator for a primary team coordinator only", () => {
		const source = readFileSync(
			join(import.meta.dir, "../../agent-runtime/orchestrator.ts"),
			"utf8",
		);
		expect(source).toContain(
			'!placement && freshNarrator.type === "primary" && isTeamNarrator(freshNarrator.traits)',
		);
		expect(source).toContain(
			"annotateToolResult: teamCoordinator\n\t\t\t\t\t? coordinatorToolAnnotatorFor(narratorId, locale)\n\t\t\t\t\t: undefined,",
		);
	});

	test("an Eval script's internal reads get the file itself, never a reminder", () => {
		const source = readFileSync(
			join(import.meta.dir, "../../../lib/agent/tool-executor.ts"),
			"utf8",
		);
		const internal = source.slice(source.indexOf("ctx.executeRead = async"));
		const childCall = internal.slice(0, internal.indexOf("childTu,\n") + 400);
		expect(childCall).toContain("annotateToolResult: undefined,");
	});

	test("the session's prompt language: zh-CN", async () => {
		const { output } = await runFake(
			"Edit",
			{ file_path: "x.ts", old_string: "a", new_string: lines(31) },
			{ output: "Edited x.ts" },
			coordinatorConfig("zh-CN"),
		);
		expect(output).toContain("[协调者建议上限] 这次 Edit 改了 31 行");
		expect(output).toContain("每次改动不超过 30 行");
		expect(reminders(output)).toBe(0);
	});

	test("the team's own settings decide the numbers", async () => {
		captureEvents();
		await updateTeam(
			teamId,
			{ userId: OWNER, isAdmin: false },
			{ settings: { coordinatorLimits: { editLines: 5 } } },
		);
		try {
			const { output } = await runFake(
				"Edit",
				{ file_path: "y.ts", old_string: "a", new_string: lines(6) },
				{ output: "Edited y.ts" },
				coordinatorConfig(),
			);
			expect(output).toContain("is 5 lines per edit");
		} finally {
			await updateTeam(teamId, { userId: OWNER, isAdmin: false }, { settings: {} });
		}
	});

	test("the same overrun gives the same reminder bytes", async () => {
		const annotate = createCoordinatorToolAnnotator({
			narratorId: teamId,
			locale: "en",
			limits: { ...DEFAULT_COORDINATOR_LIMITS },
		});
		setCoordinatorOverrunRecorder(() => {});
		beginCoordinatorRun(teamId);
		const call = {
			toolName: "Edit",
			toolUseId: "same",
			input: { file_path: "z.ts", old_string: "a", new_string: lines(50) },
			output: "Edited z.ts",
			isError: false,
			cwd: repo,
			local: true,
		};
		const first = await annotate(call);
		// A new run, so the files-per-turn count starts over as it did for the first call.
		beginCoordinatorRun(teamId);
		expect(await annotate(call)).toBe(first);
		// A saved output is named by its call: a retried call gets the same text.
		const readCall = {
			...call,
			toolName: "Read",
			input: { file_path: "r.txt" },
			output: lines(400),
		};
		const saved = await annotate(readCall);
		savedPathOf(saved ?? "");
		expect(saved).toContain("saved at ");
		expect(await annotate(readCall)).toBe(saved);
	});

	test("a failing annotator keeps the tool's own result", async () => {
		const { output, calls } = await runFake(
			"Bash",
			{ command: "echo hi" },
			{ output: "hi" },
			makeConfig({
				annotateToolResult: async () => {
					throw new Error("boom");
				},
			}),
		);
		expect(calls).toHaveLength(1);
		expect(output).toBe("hi");
	});
});

describe("recording", () => {
	test("each overrun is a team_work_events row written after the call returns", async () => {
		const config = coordinatorConfig();
		beginCoordinatorRun(teamId);
		const before = db
			.select({ id: teamWorkEvents.id })
			.from(teamWorkEvents)
			.where(
				and(eq(teamWorkEvents.teamId, teamId), like(teamWorkEvents.kind, "coordinator.overrun.%")),
			)
			.all().length;
		await runFake("Grep", { pattern: "x" }, { output: lines(150) }, config);
		await flushEvents();
		const rows = db
			.select()
			.from(teamWorkEvents)
			.where(
				and(eq(teamWorkEvents.teamId, teamId), like(teamWorkEvents.kind, "coordinator.overrun.%")),
			)
			.all();
		expect(rows.length).toBe(before + 1);
		const row = rows.find((r) => r.kind === "coordinator.overrun.searchLines");
		expect(row).toMatchObject({
			actorKind: "agent",
			actorId: teamId,
			workItemId: null,
			detailJson: { tool: "Grep", size: 150, limit: 100 },
		});
	});

	test("rows per run are capped; reminders go on", async () => {
		captureEvents();
		beginCoordinatorRun(teamId);
		const config = coordinatorConfig();
		const cap = limitsModule.COORDINATOR_LIMIT_BOUNDS.eventsPerRun;
		let reminded = 0;
		for (let i = 0; i < cap + 3; i++) {
			const { output } = await runFake(
				"Edit",
				{ file_path: "same.ts", old_string: "a", new_string: lines(31) },
				{ output: "ok" },
				config,
			);
			reminded += reminders(output);
		}
		await flushEvents();
		expect(reminded).toBe(cap + 3);
		expect(recorded).toHaveLength(cap);
	});
});

describe("headAndTail", () => {
	test("whole lines from both ends, never overlapping", () => {
		const text = lines(20);
		expect(headAndTail(text, 3, 10_000)).toEqual({
			head: "line 1\nline 2\nline 3",
			tail: "line 18\nline 19\nline 20",
		});
		expect(headAndTail("a\nb\nc\n", 5, 10_000)).toEqual({ head: "a\nb\nc", tail: "" });
	});

	test("bytes bound both sides; one long line is cut at both ends", () => {
		const { head, tail } = headAndTail(`${"a".repeat(100)}${"z".repeat(100)}`, 5, 40);
		expect(head).toBe("a".repeat(40));
		expect(tail).toBe("z".repeat(40));
		const cjk = headAndTail("汉".repeat(100), 5, 10);
		expect(Buffer.byteLength(cjk.head)).toBeLessThanOrEqual(10);
		expect(cjk.head).toMatch(/^汉+$/);
		expect(cjk.tail).toMatch(/^汉+$/);
	});
});

describe("saved outputs: one directory per coordinator, named by content (review B1)", () => {
	const otherTeam = { id: "" };
	beforeAll(async () => {
		const project = await db.query.projects.findFirst();
		const team = await createTeam(
			{ projectId: project?.id as string, name: "Other team" },
			{ userId: OWNER, isAdmin: false },
		);
		otherTeam.id = team.id;
	});

	const annotatorOf = (narratorId: string) => {
		setCoordinatorOverrunRecorder(() => {});
		return createCoordinatorToolAnnotator({
			narratorId,
			locale: "en",
			limits: { ...DEFAULT_COORDINATOR_LIMITS },
		});
	};
	const bash = (toolUseId: string, output: string) => ({
		toolName: "Bash",
		toolUseId,
		input: { command: "x" },
		output,
		isError: false,
		cwd: repo,
		local: true,
	});
	const pathOf = (text: string | null) => /saved at (\S+);/.exec(text ?? "")?.[1] as string;

	test("two coordinators with the same upstream tool_use id never share a file", async () => {
		const secretA = "A-private ".repeat(1500);
		const outB = "B-output ".repeat(1500);
		const pathA = pathOf(await annotatorOf(teamId)(bash("call_go_0", secretA)));
		const pathB = pathOf(await annotatorOf(otherTeam.id)(bash("call_go_0", outB)));
		expect(pathA).not.toBe(pathB);
		expect(readFileSync(pathA, "utf8")).toBe(secretA);
		expect(readFileSync(pathB, "utf8")).toBe(outB);
		expect(pathA.startsWith(`${coordinatorOutputsDir(teamId)}/`)).toBe(true);
		expect(pathB.startsWith(`${coordinatorOutputsDir(otherTeam.id)}/`)).toBe(true);
		// Ids that sanitize alike ("Bash:0" / "Bash0") do not matter either: names are content.
		const c = pathOf(await annotatorOf(teamId)(bash("Bash:0", secretA)));
		const d = pathOf(await annotatorOf(otherTeam.id)(bash("Bash0", outB)));
		expect(c).not.toBe(d);
		expect(readFileSync(c, "utf8")).toBe(secretA);
	});

	test("the same coordinator: same text → same file, different text → different file", async () => {
		const annotate = annotatorOf(teamId);
		const first = pathOf(await annotate(bash("call_go_0", "one ".repeat(3000))));
		expect(pathOf(await annotate(bash("call_go_0", "one ".repeat(3000))))).toBe(first);
		const other = pathOf(await annotate(bash("call_go_0", "two ".repeat(3000))));
		expect(other).not.toBe(first);
		expect(readFileSync(first, "utf8")).toBe("one ".repeat(3000));
	});

	test("only the narrator itself reads its saved outputs without approval", async () => {
		const path = pathOf(await annotatorOf(teamId)(bash("perm", "p ".repeat(6000))));
		const decide = (narratorId: string, permMode: string) =>
			resolvePermissionDecision({
				toolName: "Read",
				narratorId,
				input: { file_path: path },
				permMode,
				cwd: repo,
			});
		expect(decide(teamId, "default")).toBe("allow");
		expect(decide(teamId, "readOnly")).toBe("allow");
		expect(decide(otherTeam.id, "default")).toBe("ask");
		expect(decide(otherTeam.id, "readOnly")).toBe("deny");
		expect(decide(plainId, "default")).toBe("ask");
	});
});

describe("only real files of the own directory are exempt (review round 2)", () => {
	test("a symlink inside the own directory: approval needed, and Read cuts its lines as usual", async () => {
		const dir = coordinatorOutputsDir(teamId) as string;
		mkdirSync(dir, { recursive: true });
		const outside = join(testHome, "outside-secret.txt");
		writeFileSync(outside, `${"s".repeat(5000)}\n`);
		const link = join(dir, "link.txt");
		rmSync(link, { force: true });
		symlinkSync(outside, link);
		const linkedDir = join(dir, "sub");
		rmSync(linkedDir, { recursive: true, force: true });
		symlinkSync(testHome, linkedDir);
		for (const path of [link, join(linkedDir, "outside-secret.txt")]) {
			expect(
				resolvePermissionDecision({
					toolName: "Read",
					narratorId: teamId,
					input: { file_path: path },
					permMode: "default",
					cwd: repo,
				}),
			).toBe("ask");
		}
		const read = await executeTool(
			{ toolUseId: `read-${generateId()}`, name: "Read", input: { file_path: link, limit: -1 } },
			coordinatorConfig(),
		);
		expect(read.output).toContain("[line truncated, 5000 chars total]");
		rmSync(link, { force: true });
		rmSync(linkedDir, { force: true });
	});

	test("an oversized line in the own directory is cut at the whole-file cap", async () => {
		const dir = coordinatorOutputsDir(teamId) as string;
		mkdirSync(dir, { recursive: true });
		const path = join(dir, "oversized.txt");
		writeFileSync(path, `${"o".repeat(300_000)}\nafter\n`);
		try {
			expect(
				resolvePermissionDecision({
					toolName: "Read",
					narratorId: teamId,
					input: { file_path: path },
					permMode: "default",
					cwd: repo,
				}),
			).toBe("allow");
			for (const input of [
				{ file_path: path, limit: -1 },
				{ file_path: path, limit: 5 },
			]) {
				const read = await executeTool(
					{ toolUseId: `read-${generateId()}`, name: "Read", input },
					coordinatorConfig(),
				);
				expect(read.isError).not.toBe(true);
				expect(read.output.length).toBeLessThan(110_000);
				expect(read.output).not.toContain("o".repeat(100_001));
			}
		} finally {
			rmSync(path, { force: true });
		}
	});
});

describe("where the call ran (review S2)", () => {
	test("a call on a remote device: full text and the reminder, nothing saved", async () => {
		captureEvents();
		const full = "r".repeat(20_000);
		const config = coordinatorConfig();
		const { output } = await runFake(
			"Bash",
			{ command: "cat big" },
			{ output: full },
			{ ...config, defaultDeviceId: "device-remote" },
		);
		expect(output.startsWith(`${full}\n\n${REMINDER}`)).toBe(true);
		expect(output).not.toContain("saved at");
		expect(reminders(output)).toBe(1);
	});
});

describe("reading a saved output back with the real Read (review S3)", () => {
	/** Strip Read's line numbers: `     1│text`. */
	const readText = (output: string) =>
		output
			.split("\n")
			.map((line) => line.slice(line.indexOf("│") + 1))
			.join("\n");

	for (const [label, full] of [
		[
			"about 45 KB",
			Array.from(
				{ length: 1000 },
				(_, i) => `${String(i).padStart(5, "0")} ${"x".repeat(40)}`,
			).join("\n"),
		],
		[
			"about 150 KB, with lines longer than Read's 2,000 characters",
			[
				...Array.from(
					{ length: 2000 },
					(_, i) => `${String(i).padStart(5, "0")} ${"y".repeat(40)}`,
				),
				"L".repeat(6000),
				"M".repeat(120_000),
				"tail line",
			].join("\n"),
		],
	] as const) {
		test(`${label}: the reminder's way returns every byte`, async () => {
			setCoordinatorOverrunRecorder(() => {});
			const config = coordinatorConfig();
			// The generic 50 KB truncation would apply to a Bash result; a Grep result shows
			// the same thing without it (the stand-in reports it as already truncated).
			const { output } = await runFake(
				"Grep",
				{ pattern: "x" },
				{ output: full, truncated: true },
				config,
			);
			expect(reminders(output)).toBe(1);
			expect(output).toContain("with limit: -1");
			const paths = [
				...(output.match(/saved at (\S+);/)?.slice(1, 2) ?? []),
				...(/consecutive parts \(joined without separators\): (.+?); Read each/
					.exec(output)?.[1]
					?.split(", ") ?? []),
			];
			expect(paths.length).toBeGreaterThan(0);
			expect(paths.map((path) => readFileSync(path, "utf8")).join("")).toBe(full);
			for (const path of paths) {
				const read = await executeTool(
					{
						toolUseId: `read-${generateId()}`,
						name: "Read",
						input: { file_path: path, limit: -1 },
					},
					config,
				);
				expect(read.isError).not.toBe(true);
				expect(read.output).not.toContain(REMINDER);
				expect(read.output).not.toContain("truncated");
				expect(readText(read.output)).toBe(readFileSync(path, "utf8").replace(/\n$/, ""));
			}
			if (full.length > 100_000) expect(paths.length).toBeGreaterThan(1);
		});
	}
});

describe("the general truncation's file and other nits", () => {
	test("Bash over 50 KB: points at the file the executor already saved, saves nothing again", async () => {
		setCoordinatorOverrunRecorder(() => {});
		const before = await listOwn(teamId);
		const full = Array.from({ length: 3000 }, (_, i) => `row ${i} ${"z".repeat(30)}`).join("\n");
		const { output } = await runFake(
			"Bash",
			{ command: "big" },
			{ output: full },
			coordinatorConfig(),
		);
		const path = /complete output was saved at (\S+);/.exec(output)?.[1] as string;
		expect(path.startsWith(OUTPUT_DIR)).toBe(true);
		expect(readFileSync(path, "utf8")).toBe(full);
		rmSync(path, { force: true });
		expect(await listOwn(teamId)).toEqual(before);
	});

	test("Edit with replace_all counts every occurrence", async () => {
		captureEvents();
		beginCoordinatorRun(teamId);
		const { output } = await runFake(
			"Edit",
			{ file_path: "r.ts", old_string: "a", new_string: "b", replace_all: true },
			{ output: "Edited r.ts", metadata: { linesAdded: 45, linesRemoved: 45 } },
			coordinatorConfig(),
		);
		expect(output).toContain("This Edit changed 45 lines");
	});

	test("applied StructSed counts for files per turn; a dry run does not", async () => {
		captureEvents();
		beginCoordinatorRun(teamId);
		const config = coordinatorConfig();
		for (const file of ["s1.ts", "s2.ts", "s3.ts"])
			await runFake(
				"Edit",
				{ file_path: file, old_string: "a", new_string: "b" },
				{ output: "ok" },
				config,
			);
		const dry = await runFake(
			"StructSed",
			{ file_path: "s4.ts", command: "replace" },
			{ output: "DRY RUN" },
			config,
		);
		expect(reminders(dry.output)).toBe(0);
		const applied = await runFake(
			"StructSed",
			{ file_path: "s4.ts", command: "replace", dry_run: false },
			{ output: "applied" },
			config,
		);
		expect(applied.output).toContain("This turn has now changed 4 files");
	});

	test("the run's bookkeeping is dropped when the run ends", () => {
		const source = readFileSync(
			join(import.meta.dir, "../../agent-runtime/orchestrator.ts"),
			"utf8",
		);
		const end = source.indexOf("// The run ended: the session's claims go on the idle lease");
		expect(source.slice(end - 200, end)).toContain("forgetCoordinatorRun(narratorId);");
	});
});

async function listOwn(narratorId: string): Promise<string[]> {
	const { readdir } = await import("node:fs/promises");
	return (await readdir(coordinatorOutputsDir(narratorId) as string).catch(() => [])).sort();
}
