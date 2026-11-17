/**
 * Subagent Terminal and Browser permissions (Project Teams S2), also under bypassPermissions,
 * where nothing else would stop them:
 *
 * - a reviewer's Browser may look at web pages, never act on them or open anything but a web
 *   URL (`file:`, `data:`, `chrome:` ...): both the decision and the final start gate refuse;
 * - typing a command into a Terminal meets every fence the same command meets in Bash
 *   (protected paths, directory blacklist), at the decision and at the final start gate.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { narrators, narratorToolCalls, terminals } from "../../db/schema";
import { localBackend } from "../../lib/agent/execution/registry";
import { generateId } from "../../lib/id";
import { narraforkDir } from "../../lib/settings";
import {
	compileDelegationPolicy,
	isBrowserReadAction,
	resolveRuntimePolicy,
	withDelegationDepth,
} from "../agent-runtime/policy";

const { db, sqlite } = getTestDb();
const realDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDb, db, sqlite }));
const { handlePermission, recheckFinalToolExecutionPermission, REVIEW_BROWSER_READ_ONLY_REASON } =
	await import("../narrator-permission");
await import("../narrator-service");
const { narratorPersistence: persistence } = await import("../narrator-persistence");
const { executionPolicyEngine } = await import("../execution-policy/engine");
const { permissionRuleService } = await import("../permission-rule-service");

const reviewPolicy = resolveRuntimePolicy([
	withDelegationDepth(compileDelegationPolicy({ template: "review" }), 1),
]);
const workerPolicy = resolveRuntimePolicy([
	withDelegationDepth(compileDelegationPolicy({ template: "worker" }), 1),
]);
let cwd: string;
const signal = new AbortController().signal;
const now = () => new Date().toISOString();

beforeEach(async () => {
	cleanDb(sqlite);
	executionPolicyEngine.invalidate("n");
	cwd = await mkdtemp(join(tmpdir(), "nf-review-browser-"));
	await db.insert(narrators).values({
		id: "n",
		cwd,
		permissionMode: "bypassPermissions",
		createdAt: now(),
		updatedAt: now(),
	});
	// The terminal a Terminal write types into: its device and directory decide the target.
	await db.insert(terminals).values({
		id: "t",
		narratorId: "n",
		name: "dev",
		cwd,
		status: "running",
		createdAt: now(),
	});
});
afterEach(async () => {
	executionPolicyEngine.invalidate("n");
	cleanDb(sqlite);
	await rm(cwd, { recursive: true, force: true });
});
afterAll(() => {
	mock.module("../../db", () => realDb);
	mock.restore();
	sqlite.close();
});

async function persistedCall(
	toolUseId: string,
	input: Record<string, unknown>,
	toolName = "Browser",
) {
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

function decide(
	input: Record<string, unknown>,
	toolUseId: string,
	review: boolean,
	toolName = "Browser",
) {
	return persistedCall(toolUseId, input, toolName).then((binding) =>
		handlePermission(
			"n",
			signal,
			toolName,
			input,
			toolUseId,
			cwd,
			"en",
			undefined,
			{ toolCallBinding: binding },
			undefined,
			undefined,
			review,
		).then((result) => ({ result, binding })),
	);
}

const READS = [
	{ action: "launch", url: "https://example.invalid/" },
	{ action: "navigate", session_id: "s", url: "https://example.invalid/b" },
	{ action: "screenshot", session_id: "s" },
	{ action: "get_text", session_id: "s", selector: "main" },
	{ action: "dom", session_id: "s" },
	{ action: "scroll", session_id: "s", direction: "down" },
	{ action: "close", session_id: "s" },
	{ action: "navigate", session_id: "s", url: "about:blank" },
	{ action: "navigate", session_id: "s", direction: "back" },
	{ action: "launch", url: "http://127.0.0.1:5173/" },
];
const ACTS = [
	{ action: "click", session_id: "s", selector: "button" },
	{ action: "fill", session_id: "s", selector: "input", value: "x" },
	{ action: "type", session_id: "s", key: "Enter" },
	{ action: "select", session_id: "s", selector: "select", value: "a" },
	{ action: "evaluate", session_id: "s", value: "document.title" },
	{ action: "evaluate_capture", session_id: "s", value: "1" },
	{ action: "perf_start", session_id: "s" },
	{ action: "heap_snapshot", session_id: "s" },
	{ action: "memory_profile_start", session_id: "s" },
	{ action: "screenshot", session_id: "s", file_path: "shot.png" },
	{ action: "launch", url: "https://example.invalid/", headless: false },
	// Anything but a web page (review round 1, B1): host files, inline script, the browser.
	{ action: "navigate", session_id: "s", url: `file://${narraforkDir}/settings.json` },
	{ action: "navigate", session_id: "s", url: "chrome://version" },
	{ action: "navigate", session_id: "s", url: "view-source:https://example.invalid/" },
	{ action: "navigate", session_id: "s", url: "javascript:document.title='x'" },
	{ action: "navigate", session_id: "s", url: "devtools://devtools/bundled/inspector.html" },
	{ action: "navigate", session_id: "s", url: "about:version" },
	{ action: "launch", url: "data:text/html,<script>fetch('http://127.0.0.1:7779/')</script>" },
	{ action: "launch", url: "file:///etc/hostname" },
	{ action: "launch" },
];

test("read actions are reads; acting, scripting, profiling, file writes and headed launch are not", () => {
	for (const input of READS) expect(isBrowserReadAction(input)).toBe(true);
	for (const input of ACTS) expect(isBrowserReadAction(input)).toBe(false);
	expect(isBrowserReadAction({})).toBe(false);
});

test("a reviewer's acting Browser call is denied even under bypassPermissions", async () => {
	let index = 0;
	for (const input of ACTS) {
		const { result } = await decide(input, `act-${index++}`, true);
		expect(result.behavior).toBe("deny");
		if (result.behavior === "deny") expect(result.message).toContain("Browser may only read pages");
	}
	for (const input of READS) {
		const { result } = await decide(input, `read-${index++}`, true);
		expect(result.behavior).toBe("allow");
	}
	// The same calls from a worker follow the session's own mode, unchanged.
	const { result } = await decide(ACTS[0], "worker-click", false);
	expect(result.behavior).toBe("allow");
	expect(REVIEW_BROWSER_READ_ONLY_REASON).toContain("Review mode");
});

test("the final start gate refuses an approved acting call under a read-only ceiling", async () => {
	const check = async (toolUseId: string, input: Record<string, unknown>) => {
		const { result, binding } = await decide(input, toolUseId, false);
		expect(result.behavior).toBe("allow");
		await persistence.claimToolCallExecution("n", toolUseId, binding, Date.now());
		return { narratorId: "n", toolName: "Browser", toolUseId, binding, input, cwd, signal };
	};
	// Approved before the ceiling narrowed to review's: the click must not start.
	const click = await check("final-click", ACTS[0]);
	await expect(
		recheckFinalToolExecutionPermission({ ...click, runtimePolicy: reviewPolicy }),
	).rejects.toThrow("read-only capability ceiling");
	const read = await check("final-read", READS[3]);
	const fence = await recheckFinalToolExecutionPermission({ ...read, runtimePolicy: reviewPolicy });
	fence.assertStillCurrent();
	const work = await check("final-worker-click", ACTS[0]);
	(
		await recheckFinalToolExecutionPermission({ ...work, runtimePolicy: workerPolicy })
	).assertStillCurrent();
});

test("a reviewer cannot open host files, inline script or browser pages, at either gate", async () => {
	const PAGES = ACTS.slice(-9);
	let index = 0;
	for (const input of PAGES) {
		const { result } = await decide(input, `page-${index++}`, true);
		expect(result.behavior).toBe("deny");
	}
	// Approved for a writer, then the ceiling narrowed: the final gate refuses it too.
	const { result, binding } = await decide(PAGES[0], "final-file", false);
	expect(result.behavior).toBe("allow");
	await persistence.claimToolCallExecution("n", "final-file", binding, Date.now());
	await expect(
		recheckFinalToolExecutionPermission({
			narratorId: "n",
			toolName: "Browser",
			toolUseId: "final-file",
			binding,
			input: PAGES[0],
			cwd,
			signal,
			runtimePolicy: reviewPolicy,
		}),
	).rejects.toThrow("read-only capability ceiling");
});

describe("Terminal writes meet the Bash fences", () => {
	const settingsFile = () => `${narraforkDir}/settings.json`;
	const write = (input: string) => ({ action: "write", terminal_id: "t", input });

	test("a protected path refused to Read and Bash is refused to a Terminal write", async () => {
		const read = await decide({ file_path: settingsFile() }, "read", false, "Read");
		expect(read.result.behavior).toBe("deny");
		const bash = await decide({ command: `cat ${settingsFile()}` }, "bash", false, "Bash");
		expect(bash.result.behavior).toBe("deny");
		for (const [id, input] of [
			["typed", `cat ${settingsFile()}\n`],
			["escaped", `\x1b[200~cat ${settingsFile()}\x1b[201~\r`],
			["multi", `echo hi\ncat ${settingsFile()}\n`],
		]) {
			const { result } = await decide(write(input), id, false, "Terminal");
			expect(result.behavior).toBe("deny");
		}
	});

	test("ordinary typing keeps Terminal's own decision", async () => {
		for (const [id, input] of [
			["ls", "ls -la\n"],
			["ctrl-c", "\x03"],
			["repl", "print(open('x').read())\n"],
			["key", "q"],
		]) {
			const { result } = await decide(write(input), id, false, "Terminal");
			expect(result.behavior).toBe("allow");
		}
	});

	test("a directory blacklisted after approval stops the approved write at the final gate", async () => {
		const blocked = join(cwd, "secret");
		const input = write(`cat ${blocked}/key\n`);
		const { result, binding } = await decide(input, "final-term", false, "Terminal");
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
		// A new write to the blacklisted directory is refused at the decision too.
		const again = await decide(write(`cat ${blocked}/key\n`), "again-term", false, "Terminal");
		expect(again.result.behavior).toBe("deny");
		await expect(recheckFinalToolExecutionPermission(check)).rejects.toThrow();
	});
});
