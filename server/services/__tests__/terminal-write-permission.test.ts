/**
 * Typing into a terminal (Project Teams S2, review rounds 1 and 2), against a real shell.
 *
 * Every line a Terminal write runs meets the fences the same command meets in Bash, judged on
 * the bytes the tool actually sends (literal `\n`, `\xNN` escapes) and the line as the shell
 * will run it (earlier writes, backspace, Ctrl-U/W). What cannot be judged (history and
 * completion keys, unknown directory, here-documents and interpreters reading stdin, input to
 * a running program, unparseable lines) asks a person, also under bypassPermissions. Plain safe
 * commands keep the session's normal rules.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { narrators, narratorToolCalls } from "../../db/schema";
import { localBackend } from "../../lib/agent/execution/registry";
import type { ToolExecutionTarget } from "../../lib/agent/types";
import { generateId } from "../../lib/id";
import { narraforkDir } from "../../lib/settings";
import {
	compileDelegationPolicy,
	resolveRuntimePolicy,
	withDelegationDepth,
} from "../agent-runtime/policy";

const { db, sqlite } = getTestDb();
const realDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDb, db, sqlite }));
const {
	handlePermission,
	judgeTerminalWrite,
	recheckFinalToolExecutionPermission,
	resolvePermissionDecision,
} = await import("../narrator-permission");
await import("../narrator-service");
const { narratorPersistence: persistence } = await import("../narrator-persistence");
const { executionPolicyEngine } = await import("../execution-policy/engine");
const { permissionRuleService } = await import("../permission-rule-service");
const { terminalService } = await import("../terminal-service");
const judge = await import("../terminal-input-judge");

const workerPolicy = resolveRuntimePolicy([
	withDelegationDepth(compileDelegationPolicy({ template: "worker" }), 1),
]);
const SECRET = () => `${narraforkDir}/settings.json`;
let cwd: string;
let terminalId: string;
const signal = new AbortController().signal;
const now = () => new Date().toISOString();

async function until(predicate: () => Promise<boolean>, what: string) {
	const deadline = Date.now() + 15_000;
	while (!(await predicate())) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
		await Bun.sleep(25);
	}
}

beforeEach(async () => {
	cleanDb(sqlite);
	judge.resetTerminalLineStatesForTest();
	executionPolicyEngine.invalidate("n");
	cwd = await mkdtemp(join(tmpdir(), "nf-terminal-write-"));
	await db.insert(narrators).values({
		id: "n",
		cwd,
		permissionMode: "bypassPermissions",
		createdAt: now(),
		updatedAt: now(),
	});
	terminalId = (await terminalService.create({ narratorId: "n", name: "dev" })).id;
	await until(
		async () => (await judge.probeTerminalForeground(terminalId)) === "shell",
		"the shell to take the foreground",
	);
});
afterEach(async () => {
	await terminalService.kill(terminalId).catch(() => {});
	executionPolicyEngine.invalidate("n");
	cleanDb(sqlite);
	await rm(cwd, { recursive: true, force: true });
});
afterAll(() => {
	mock.module("../../db", () => realDb);
	mock.restore();
	sqlite.close();
});

const write = (input: string) => ({ action: "write", terminal_id: "dev", input });

/** The decision for a Terminal write exactly as `handlePermission` makes it. */
async function decideTerminal(input: string, permMode = "bypassPermissions") {
	const args = write(input);
	const terminalJudgement = await judgeTerminalWrite("n", "Terminal", args, cwd, signal);
	if (!terminalJudgement) throw new Error("not a terminal write");
	const compiledPolicy = await executionPolicyEngine.compile("n", terminalJudgement.context);
	const meta: { terminalAskReason?: string; blacklistReason?: string } = {};
	const decision = resolvePermissionDecision({
		toolName: "Terminal",
		input: args,
		permMode,
		cwd,
		terminalJudgement,
		compiledPolicy,
		executionContext: terminalJudgement.context,
		meta,
	});
	return { decision, meta };
}

/** What the tool records after it really sent `data` to the shell. */
function sent(data: string) {
	judge.commitTerminalInput(terminalId, data, {
		initialCwd: cwd,
		foreground: "shell",
		home: judge.terminalHome(null),
	});
}

async function persistedCall(toolName: string, toolUseId: string, input: Record<string, unknown>) {
	const message = await persistence.persistAssistantMessage("n", {
		uuid: generateId(),
		session_id: "fixture",
		message: { content: [{ type: "tool_use", id: toolUseId, name: toolName, input }] },
	});
	const call = await db.query.narratorToolCalls.findFirst({
		where: eq(narratorToolCalls.messageId, message.id),
	});
	if (!call) throw new Error("Missing persisted tool call");
	return persistence.getToolCallBinding("n", message.id, toolUseId, call.id);
}

/** A routed call (Read, Bash) with the frozen local target the executor would give it. */
function localTarget(): ToolExecutionTarget {
	return {
		deviceId: "local",
		backendKind: "local",
		cwd,
		pathFlavor: localBackend.paths.flavor,
		runtimeGeneration: localBackend.runtimeGeneration ?? 0,
		selectionSource: "session_default",
	};
}

async function handle(toolName: string, toolUseId: string, input: Record<string, unknown>) {
	const binding = await persistedCall(toolName, toolUseId, input);
	const routed = toolName !== "Terminal";
	const result = await handlePermission(
		"n",
		signal,
		toolName,
		input,
		toolUseId,
		cwd,
		"en",
		undefined,
		{
			toolCallBinding: binding,
			...(routed ? { executionBackend: localBackend, executionTarget: localTarget() } : {}),
		},
	);
	return { result, binding };
}

describe("lines Bash would refuse are refused", () => {
	test("Bash refuses the platform secrets file for the protected-path rule itself", async () => {
		// A real frozen target, so the refusal is the secrets rule, not a routing failure.
		const { result } = await handle("Bash", "bash-secret", { command: `cat ${SECRET()}` });
		expect(result.behavior).toBe("deny");
		if (result.behavior === "deny") {
			expect(result.message).toContain("platform secrets is forbidden");
			expect(result.message).not.toContain("Routed permission");
		}
	});

	test("typed, literal-escaped, pasted and multi-line forms are all refused", async () => {
		const forms: [string, string][] = [
			["typed", `cat ${SECRET()}\n`],
			["literal enter", `cat ${SECRET()}\\n`],
			["literal carriage return", `cat ${SECRET()}\\r`],
			["literal hex", `cat ${SECRET().replace("settings", "setting\\x73")}\\n`],
			["literal backspace", `cat ${SECRET()}X\\x7f\\n`],
			["literal unicode", `cat ${SECRET().replace("settings", "setting\\u0073")}\\n`],
			["pasted", `\x1b[200~cat ${SECRET()}\x1b[201~\r`],
			["multi-line", `echo hi\ncat ${SECRET()}\n`],
			["continued", `cat \\\n${SECRET()}\n`],
		];
		let index = 0;
		for (const [label, input] of forms) {
			const { result } = await handle("Terminal", `form-${index++}`, write(input));
			expect({ label, behavior: result.behavior }).toEqual({ label, behavior: "deny" });
		}
	});

	test("a line built over several writes is judged whole", async () => {
		sent(`cat ${narraforkDir}/sett`);
		expect((await decideTerminal("ings.json\n")).decision).toBe("deny");
		judge.resetTerminalLineStatesForTest();
		sent("cat /tmp/xyz");
		sent("\x7f\x7f\x7f\x7f\x7f\x7f\x7f\x7f");
		expect((await decideTerminal(`${SECRET()}\n`)).decision).toBe("deny");
		judge.resetTerminalLineStatesForTest();
		sent("echo harmless ");
		// Ctrl-U clears the typed text; Ctrl-W deletes the last word.
		expect((await decideTerminal(`\x15cat ${SECRET()}\n`)).decision).toBe("deny");
		expect((await decideTerminal(`\x17cat ${SECRET()}\n`)).decision).toBe("deny");
	});

	test("cd moves the directory relative paths are judged from", async () => {
		expect((await decideTerminal(`cd ${narraforkDir}\ncat settings.json\n`)).decision).toBe("deny");
		sent(`cd ${narraforkDir}\n`);
		expect((await decideTerminal("cat settings.json\n")).decision).toBe("deny");
		expect((await decideTerminal("cat ./settings.json\n")).decision).toBe("deny");
	});

	test("an open quote runs nothing; the command it continues is judged whole", async () => {
		expect((await decideTerminal("echo 'a\n")).decision).toBe("allow");
		sent("echo 'a\n");
		expect((await decideTerminal(`'; cat ${SECRET()}\n`)).decision).toBe("deny");
	});

	test("[[ -d / ]] && cat <secret> is not allowed", async () => {
		const { decision } = await decideTerminal(`[[ -d / ]] && cat ${SECRET()}\n`);
		expect(["deny", "ask"]).toContain(decision);
	});
});

describe("input that cannot be judged asks a person, also under bypassPermissions", () => {
	const cases: [string, () => void, string][] = [
		["Ctrl-R history search", () => {}, "\x12settings\n"],
		["Tab completion", () => {}, `cat ${narraforkDir}/sett\tn\n`],
		["arrow key", () => {}, "\x1b[A\n"],
		["literal Tab", () => {}, "cat sett\\t\\n"],
		["Tab typed in an earlier write", () => sent("cat ~/.narr\t"), "/settings.json\n"],
		["here-document into bash", () => {}, "bash <<'EOF'\necho hi\nEOF\n"],
		["here-string", () => {}, "bash <<< 'echo hi'\n"],
		["piped into a shell", () => {}, "echo 'echo hi' | sh\n"],
		["piped into python", () => {}, "echo 'print(1)' | python3\n"],
		["interpreter from a file on stdin", () => {}, "python3 < script.py\n"],
		["bare interpreter", () => {}, "bash\n"],
		["unparseable line", () => {}, "echo hi )\n"],
		["cd to a variable", () => sent("cd $HOME_DIR\n"), "cat settings.json\n"],
		["cd in a chain", () => sent("cd /tmp && true\n"), "ls\n"],
		["cd in a subshell", () => sent("(cd /tmp)\n"), "ls\n"],
		["a person's line", () => judge.commitPersonTerminalInput(terminalId, "cd x\n"), "ls\n"],
		[
			"a person's unfinished text",
			() => judge.commitPersonTerminalInput(terminalId, "echo safe; #"),
			`cat ${SECRET()}\n`,
		],
	];
	for (const [label, before, input] of cases)
		test(label, async () => {
			before();
			const { decision, meta } = await decideTerminal(input);
			expect(["ask", "deny"]).toContain(decision);
			if (decision === "ask") expect(meta.terminalAskReason).toBeTruthy();
		});

	test("asking reaches a person: no auto-allow, the call waits for a decision", async () => {
		const controller = new AbortController();
		const binding = await persistedCall("Terminal", "ask-person", write("\x12x\n"));
		const pending = handlePermission(
			"n",
			controller.signal,
			"Terminal",
			write("\x12x\n"),
			"ask-person",
			cwd,
			"en",
			undefined,
			{ toolCallBinding: binding },
		);
		await until(async () => {
			const row = await db.query.narratorToolCalls.findFirst({
				where: eq(narratorToolCalls.id, binding.toolCallId),
			});
			return row?.status === "pending";
		}, "the permission request");
		const row = await db.query.narratorToolCalls.findFirst({
			where: eq(narratorToolCalls.id, binding.toolCallId),
		});
		expect(row?.permissionDecidedBy ?? null).toBe(null);
		controller.abort();
		expect((await pending).behavior).toBe("deny");
	});

	test("input to a running program asks unless it is plain text without Enter", async () => {
		terminalService.write(terminalId, "sleep 30\n");
		await until(
			async () => (await judge.probeTerminalForeground(terminalId)) === "program",
			"sleep to take the foreground",
		);
		expect((await decideTerminal("ls\n")).decision).toBe("ask");
		expect((await decideTerminal("\x1b[A")).decision).toBe("ask");
		expect((await decideTerminal("plain text")).decision).toBe("allow");
		expect((await decideTerminal("\x03")).decision).toBe("allow");
	});

	test("Ctrl-C and a literal cd re-anchor the line and the directory", async () => {
		judge.commitPersonTerminalInput(terminalId, "cd somewhere\n");
		expect((await decideTerminal("ls\n")).decision).toBe("ask");
		sent(`cd ${cwd}\n`);
		expect((await decideTerminal("ls\n")).decision).toBe("allow");
		judge.commitPersonTerminalInput(terminalId, "half typed");
		expect((await decideTerminal("ls\n")).decision).toBe("ask");
		expect((await decideTerminal("\x03ls\n")).decision).toBe("allow");
	});
});

describe("plain commands keep the session's normal rules", () => {
	test("bypassPermissions allows safe lines, interrupts and keys; default mode asks", async () => {
		for (const input of ["ls -la\n", "ls -la\\n", "\x03", "q", "git status\n"])
			expect((await decideTerminal(input)).decision).toBe("allow");
		expect((await decideTerminal("ls -la\n", "default")).decision).toBe("ask");
		expect((await decideTerminal("ls -la\n", "dontAsk")).decision).toBe("deny");
	});

	test("a directory blacklisted after approval stops the approved write at the final gate", async () => {
		const blocked = join(cwd, "secret");
		await mkdir(blocked);
		const input = write(`cat ${blocked}/key\n`);
		const { result, binding } = await handle("Terminal", "final-term", input);
		expect(result.behavior).toBe("allow");
		await persistence.claimToolCallExecution("n", "final-term", binding, Date.now());
		const check = {
			narratorId: "n",
			toolName: "Terminal",
			toolUseId: "final-term",
			binding,
			input,
			cwd,
			signal,
			runtimePolicy: workerPolicy,
		};
		(await recheckFinalToolExecutionPermission(check)).assertStillCurrent();
		await permissionRuleService.createNarratorRule("n", {
			ruleType: "directoryBlacklist",
			value: {
				path: blocked,
				denyLevel: "denyAll",
				targetKind: "host",
				pathFlavor: localBackend.paths.flavor === "windows" ? "windows" : "posix",
			},
		});
		executionPolicyEngine.invalidate("n");
		expect((await decideTerminal(`cat ${blocked}/key\n`)).decision).toBe("deny");
		await expect(recheckFinalToolExecutionPermission(check)).rejects.toThrow();
	});

	test("the final gate judges the same line the decision judged", async () => {
		const input = write("\x12x\n");
		const binding = await persistedCall("Terminal", "final-unknown", input);
		await db
			.update(narratorToolCalls)
			.set({ status: "running", permissionDecidedBy: "auto", permissionDecidedAt: now() })
			.where(eq(narratorToolCalls.id, binding.toolCallId));
		await persistence.claimToolCallExecution("n", "final-unknown", binding, Date.now());
		await expect(
			recheckFinalToolExecutionPermission({
				narratorId: "n",
				toolName: "Terminal",
				toolUseId: "final-unknown",
				binding,
				input,
				cwd,
				signal,
				runtimePolicy: workerPolicy,
			}),
		).rejects.toThrow();
	});
});
