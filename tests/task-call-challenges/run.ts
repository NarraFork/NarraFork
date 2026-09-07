import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod/v4";
import type { AgentToolUse, ProviderAdapter } from "../../server/lib/agent/provider";
import type { ResolvedToolDefinition } from "../../server/lib/agent/types";
import { artifactReference } from "./artifacts";
import {
	CODE_DESCRIPTION,
	CONTRACT_VERSION,
	EVAL_DESCRIPTION,
	METHODS,
	RUNTIME_CONTRACT,
	renderApiGuide,
} from "./contract";
import { redactExperimentError } from "./error-redaction";
import { challenges, type EvalOutcome, GRADER_VERSION, type MockState } from "./fixtures";
import { assertPodmanReady, executeEval, IMAGE, type SandboxOutcome } from "./isolate";
import { type BenchProfile, defaultProfile } from "./profiles";

const root = fileURLToPath(new URL("../../", import.meta.url));
const docs = `${root}docs/task-call-challenges`;
export const LIMITS = { responses: 5, evals: 6, requestMs: 120_000, responseChars: 64_000 };
export const MODELS = ["nugjp:codex:gpt-5.6-luna", "nug2:antigravity:gemini-3.7-flash"];
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const secrets = new Set<string>();
export function safeError(error: unknown): string {
	return redactExperimentError(error, secrets);
}

async function checkedApiGuide() {
	const api = await Bun.file(`${docs}/API.md`).text();
	assert.equal(api, renderApiGuide(), "API.md drifted; run run.ts --write-api before testing");
	return api;
}

async function contractChecks() {
	const challenge = challenges.find((c) => c.id === "6");
	assert(challenge);
	const initial = challenge.makeState();
	const target = initial.tasks.find((task) => task.status === "submitted");
	assert(target);
	const get = `tasks.get(${JSON.stringify(target.key)})`;
	const coverage = await executeEval(
		initial,
		`
		const objects = {task, tasks, "task.children": task.children, page: tasks.list(), tools};
		const names = Object.entries(objects).flatMap(([prefix, object]) =>
			Object.keys(object).filter(key => typeof object[key] === "function").map(key => prefix + "." + key));
		return {names, texts: names.map(name => help(name)),
			directories: Object.keys(objects).map(name => help(name))};
	`,
	);
	assert(coverage.ok, coverage.error?.message);
	const help = coverage.value as { names: string[]; texts: string[]; directories: string[] };
	assert.deepEqual(help.names.sort(), Object.keys(METHODS).sort());
	assert(help.texts.every((text) => typeof text === "string" && text.length > 10));
	assert(help.directories.every((text) => text.includes("方法目录")));
	assert.deepEqual(coverage.state.tasks, initial.tasks, "help/list mutated tasks");

	type ReadValue = {
		key: string;
		status: string;
		workflow: { kind: string; actions: string[]; note: string };
	};
	const reviewed = await executeEval(initial, `return ${get}.read();`);
	assert(reviewed.ok);
	const info = reviewed.value as ReadValue;
	assert.equal(info.key, target.key);
	assert.equal(info.status, "submitted");
	assert.equal(info.workflow.kind, "review");
	assert.deepEqual(info.workflow.actions, ["task.accept"]);
	assert(info.workflow.note.includes("同一次 Eval"));
	assert.deepEqual(reviewed.state.tasks, initial.tasks, "read/hints mutated tasks");

	const failureCases = [
		{
			state: initial,
			code: `return ${get}.finish("wrong role");`,
			error: "FORBIDDEN",
			hint: "t.accept()",
		},
		{ state: initial, code: `return ${get}.accept();`, error: "READ_REQUIRED", hint: "本次未验收" },
		{
			state: reviewed.state,
			code: `return ${get}.accept();`,
			error: "READ_REQUIRED",
			hint: "上一 Eval",
		},
		{
			state: initial,
			code: `${get}.read(); return ${get}.accept();`,
			error: "READ_REQUIRED",
			hint: "另一对象",
		},
	];
	for (const test of failureCases) {
		const result = await executeEval(test.state, test.code);
		assert.equal(result.error?.code, test.error);
		assert(result.error?.message.includes(test.hint), result.error?.message);
		assert.deepEqual(result.state.tasks, initial.tasks, "rejected action mutated tasks");
	}

	const worker = structuredClone(initial);
	worker.actor = { id: target.assignee, role: "subagent" };
	const waiting = await executeEval(worker, `return ${get}.read();`);
	assert(waiting.ok);
	assert.equal((waiting.value as ReadValue).workflow.kind, "waiting");
	assert.deepEqual((waiting.value as ReadValue).workflow.actions, []);
	const denied = await executeEval(worker, `const t = ${get}; t.read(); return t.accept();`);
	assert.equal(denied.error?.code, "FORBIDDEN");
	assert.deepEqual(denied.state.tasks, worker.tasks);

	for (const shape of ["paused", "archived", "blocked"] as const) {
		const state = challenge.makeState();
		const current = state.tasks.find((task) => task.key === state.currentKey);
		assert(current);
		if (shape === "blocked") current.status = "blocked";
		else current[shape] = true;
		// The default binding must remain visible even when reading a historical target.
		const historical = state.tasks.find((task) => task.key === target.key);
		assert(historical);
		if (shape === "archived") {
			current.archived = false;
			historical.archived = true;
			historical.status = "done";
		}
		const code =
			shape === "archived"
				? `return tasks.get(${JSON.stringify(target.key)}, {archived:"include"}).read();`
				: "return task.read();";
		const result = await executeEval(state, code);
		assert(result.ok, result.error?.message);
		assert.deepEqual(
			(result.value as ReadValue).workflow.actions,
			shape === "archived" ? ["task.restore"] : [],
		);
		assert.deepEqual(result.state.tasks, state.tasks);
	}

	// A hint is returned data, not a grant or a mutable alias into host state.
	const forged = await executeEval(
		worker,
		`const t = ${get}; const d = t.read();
		d.workflow.actions.push("task.accept"); d.status = "done"; return t.accept();`,
	);
	assert.equal(forged.error?.code, "FORBIDDEN");
	assert.deepEqual(forged.state.tasks, worker.tasks);
	return { publicMethods: help.names.length, contractScenarios: 12, hintsReadOnly: true };
}

async function selfTest() {
	await checkedApiGuide();
	const contract = await contractChecks();
	let passed = 0;
	for (const challenge of challenges) {
		let state = challenge.makeState();
		let value: unknown;
		for (const code of challenge.reference) {
			const result = await executeEval(state, code);
			if (!result.ok) throw new Error(`reference ${challenge.id}: ${JSON.stringify(result.error)}`);
			state = result.state;
			value = result.value;
		}
		const grade = challenge.grade(state, value);
		if (!grade.pass) throw new Error(`reference ${challenge.id}: ${grade.reasons.join("; ")}`);
		if (["1", "4", "6"].includes(challenge.id) && !challenge.grade(state, { status: value }).pass)
			throw new Error(`status envelope rejected for ${challenge.id}`);
		const bad = await executeEval(challenge.makeState(), challenge.negative);
		if (challenge.grade(bad.state, bad.value).pass)
			throw new Error(`negative ${challenge.id} was falsely accepted`);
		passed += 2;
		console.log(`self-test ${challenge.id}: reference PASS, negative rejected`);
	}
	let failureRoutingChecks = 0;
	for (const id of ["4", "5"]) {
		const challenge = challenges.find((c) => c.id === id);
		assert(challenge);
		const state = challenge.makeState();
		const command = JSON.stringify(state.testCommand);
		const result = await executeEval(
			state,
			`task.read();
			try { const r = tools.Bash({command:${command}}); task.finish(r.output); return task.status; }
			catch(e) {
				if(e.code === "TEST_FAILURE") { task.block(e.message); return task.status; }
				if(e.code === "CONTRACT_CHANGED") return task.read().acceptance;
				throw e;
			}`,
		);
		assert(result.ok);
		assert(challenge.grade(result.state, result.value).pass, `Failure routing ${id}`);
		failureRoutingChecks++;
		if (id === "5") {
			const broadCatch = await executeEval(
				state,
				`task.read();
				try { const r = tools.Bash({command:${command}}); task.finish(r.output); }
				catch(e) { task.block(e.message); return task.read().acceptance; }`,
			);
			assert(
				!challenge.grade(broadCatch.state, broadCatch.value).pass,
				"Broad catch unexpectedly passed",
			);
			failureRoutingChecks++;
		}
	}
	const disallowed = await executeEval(challenges[0].makeState(), "await task.start();");
	if (!disallowed.interfaceViolation) throw new Error("await was not rejected");
	const help = await executeEval(challenges[3].makeState(), 'return help("task.block");');
	if (!help.ok || typeof help.value !== "string" || !help.value.includes("task.block(reason)"))
		throw new Error("published method help missing");
	console.log(
		JSON.stringify({
			selfTest: "PASS",
			fixtureChecks: passed,
			statusEnvelopeChecks: 3,
			publishedMethodHelp: true,
			contract,
			failureRoutingChecks,
			asyncRejection: true,
			image: IMAGE,
		}),
	);
}

const evalTool = {
	name: "Eval",
	description: EVAL_DESCRIPTION,
	parameters: z.object({ code: z.string() }),
	rawJsonSchema: {
		type: "object",
		properties: {
			code: { type: "string", description: CODE_DESCRIPTION },
		},
		required: ["code"],
		additionalProperties: false,
	},
	execute: async () => ({
		output: "Only the challenge harness may execute this tool.",
		isError: true,
	}),
} as ResolvedToolDefinition;

async function makeAdapter(fullModel: string) {
	const { getNugProviderConfig } = await import("../../server/lib/settings");
	const { loadAllCachedNugModels, resolveNugModelMeta, getNugCachedModelHash } = await import(
		"../../server/lib/nug-model-cache"
	);
	loadAllCachedNugModels();
	const prefix = fullModel.split(":")[0];
	const config = getNugProviderConfig(prefix);
	if (!config) throw new Error(`Configured model route unavailable: ${prefix}`);
	secrets.add(config.apiKey);
	const meta = resolveNugModelMeta(config.id, prefix, fullModel);
	const routed = fullModel.slice(prefix.length + 1);
	if (meta.routedModel !== routed)
		throw new Error(`Refusing model substitution: ${fullModel} -> ${meta.routedModel}`);
	const url = config.baseUrl
		.trim()
		.replace(/\/+$/, "")
		.replace(/\/(?:api\/v1|api|v1)$/i, "");
	if (meta.channelType !== "codex" && meta.channelType !== "anthropic")
		throw new Error(`Unsupported test route: ${meta.channelType}`);
	const { BenchProvider } = await import("./client");
	const adapter = new BenchProvider({
		baseUrl: url,
		apiKey: config.apiKey,
		model: meta.routedModel,
		protocol: meta.channelType,
		proxy: config.proxy,
		modelHash: getNugCachedModelHash(config.id) ?? "none",
	}) as unknown as ProviderAdapter;
	return { adapter, channelType: meta.channelType, model: fullModel };
}

async function makeCapture(profile: BenchProfile) {
	const { ApiRequestDumpCollector } = await import("../../server/lib/agent/request-dump");
	return new (class extends ApiRequestDumpCollector {
		requests: Array<Record<string, unknown>> = [];
		override setRequest(request: any) {
			const body = request.body ?? {};
			const effort = body.reasoning?.effort ?? body.output_config?.effort ?? body.reasoning_effort;
			const names = (body.tools ?? []).map((t: any) => t.name ?? t.function?.name ?? t.type);
			const actualTool = body.tools?.[0];
			const actualGuide = body.system ?? body.instructions;
			assert.equal(actualTool?.description, profile.description, "Native description drift");
			assert.equal(
				(actualTool.input_schema ?? actualTool.parameters)?.properties?.code?.description,
				profile.codeDescription,
				"Native code description drift",
			);
			assert.deepEqual(
				actualTool.input_schema ?? actualTool.parameters,
				profile.parameters,
				"Native schema drift",
			);
			assert.equal(actualGuide, profile.api, "Native API guide drift");
			this.requests.push({
				model: body.model,
				effort,
				tools: names,
				thinkingType: body.thinking?.type,
				descriptionHash: hash(actualTool.description),
				apiHash: hash(actualGuide),
			});
			if (effort !== "low") throw new Error(`LOW_EFFORT_NOT_SENT: ${String(effort)}`);
			if (names.length !== 1 || names[0] !== "Eval") throw new Error("UNEXPECTED_TOOL_EXPOSURE");
		}
		override setResponseMeta(_response: any) {
			/* Deliberately do not retain headers, bodies, or thinking. */
		}
	})();
}

async function oneResponse(adapter: ProviderAdapter, params: any, profile: BenchProfile) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error("request deadline")), LIMITS.requestMs);
	const capture = await makeCapture(profile);
	let text = "";
	let reasoningChars = 0;
	let accumulatedChars = 0;
	let messageId: string | undefined;
	let textOutputIndex: number | undefined;
	let stopReason: string | undefined;
	let upstreamStopReason: string | undefined;
	let usage: unknown;
	const completed = new Map<string, AgentToolUse>();
	const chunks = new Map<
		string,
		{
			name: string;
			input: string;
			outputIndex?: number;
			thoughtSignature?: string;
			thoughtSignatureSource?: string;
		}
	>();
	const reasoning = new Map<string, any>();
	const redacted: any[] = [];
	try {
		for await (const event of adapter.chat({
			...params,
			signal: controller.signal,
			requestDump: capture,
			reasoningEffort: "low",
		})) {
			if (event.text) {
				text += event.text;
				accumulatedChars += event.text.length;
			}
			if (event.textOutputIndex !== undefined) textOutputIndex = event.textOutputIndex;
			if (event.messageId) messageId = event.messageId;
			if (event.stopReason) stopReason = event.stopReason;
			const upstreamReason = (event as { upstreamStopReason?: string }).upstreamStopReason;
			if (upstreamReason) upstreamStopReason = upstreamReason;
			if (event.usage) usage = event.usage;
			if (event.invalidState)
				throw new Error(`UPSTREAM_INVALID_STATE: ${event.invalidState.message}`);
			if (event.reasoning || event.reasoningMetadata) {
				const key = String(event.reasoningOutputIndex ?? 0);
				const part = reasoning.get(key) ?? { text: "", outputIndex: event.reasoningOutputIndex };
				part.text += event.reasoning ?? "";
				if (event.reasoningMetadata)
					part.providerMetadata = { ...(part.providerMetadata ?? {}), ...event.reasoningMetadata };
				reasoningChars += event.reasoning?.length ?? 0;
				accumulatedChars += event.reasoning?.length ?? 0;
				reasoning.set(key, part);
			}
			if (event.redactedThinking) redacted.push(event.redactedThinking);
			for (const call of event.toolUses ?? []) completed.set(call.toolUseId, call);
			if (event.toolUseChunk) {
				const update = event.toolUseChunk;
				const part = chunks.get(update.toolUseId) ?? { name: "", input: "" };
				if (update.name) part.name = update.name;
				if (update.input) {
					part.input += update.input;
					accumulatedChars += update.input.length;
				}
				if (update.outputIndex !== undefined) part.outputIndex = update.outputIndex;
				if (update.thoughtSignature) part.thoughtSignature = update.thoughtSignature;
				if (update.thoughtSignatureSource)
					part.thoughtSignatureSource = update.thoughtSignatureSource;
				chunks.set(update.toolUseId, part);
			}
			if (accumulatedChars > LIMITS.responseChars) {
				controller.abort();
				throw new Error("MODEL_RESPONSE_LIMIT");
			}
		}
		for (const [id, chunk] of chunks) {
			if (completed.has(id)) continue;
			let input: Record<string, unknown>;
			try {
				input = JSON.parse(chunk.input);
			} catch {
				input = { malformedInput: chunk.input };
			}
			completed.set(id, {
				toolUseId: id,
				name: chunk.name,
				input,
				outputIndex: chunk.outputIndex,
				thoughtSignature: chunk.thoughtSignature,
				thoughtSignatureSource: chunk.thoughtSignatureSource,
			});
		}
		return {
			text,
			calls: [...completed.values()],
			reasoning: [...reasoning.values()],
			redacted,
			messageId,
			textOutputIndex,
			usage,
			stopReason,
			upstreamStopReason,
			reasoningChars,
			wire: capture.requests,
		};
	} finally {
		clearTimeout(timer);
	}
}

export async function runEpisode(
	model: string,
	challengeId: string,
	profile: BenchProfile = defaultProfile(evalTool.rawJsonSchema ?? {}),
	adapterOverride?: {
		adapter: ProviderAdapter;
		channelType: string;
		/** Offline tests provide a fixed-code evaluator; real model runs always use Podman. */
		evaluate?: typeof executeEval;
	},
) {
	const challenge = challenges.find((c) => c.id === challengeId);
	assert(challenge, "Unknown challenge");
	const { adapter, channelType } = adapterOverride ?? (await makeAdapter(model));
	const evaluate = adapterOverride?.evaluate ?? executeEval;
	const prompt = await Bun.file(`${docs}/${challenge.file}`).text();
	const conversationId = `task-challenge-${crypto.randomUUID()}`;
	const history: unknown[] = [];
	const api = profile.api;
	adapter.injectSystemPrompt(history, api, model, "zh-CN");
	const tools = adapter.formatTools([
		{ ...evalTool, description: profile.description, rawJsonSchema: profile.parameters },
	]);
	let state = challenge.makeState();
	let pending: unknown[] = [];
	let lastValue: unknown;
	let evalCount = 0;
	let firstEvalPass = false;
	let finalText = "";
	let infrastructureError: string | undefined;
	let naturalStop = false;
	let deliveryAccepted = false;
	let deliveryProtocolErrors = 0;
	const turns: any[] = [];
	const started = Date.now();
	for (let turn = 0; turn < LIMITS.responses; turn++) {
		let response: Awaited<ReturnType<typeof oneResponse>>;
		try {
			response = await oneResponse(
				adapter,
				{
					conversationId,
					stickySessionKey: conversationId,
					content: turn === 0 ? prompt : "",
					model,
					cwd: "/work",
					history,
					tools,
					toolResults: pending,
				},
				profile,
			);
		} catch (error) {
			infrastructureError = safeError(error);
			break;
		}
		const record: any = {
			turn: turn + 1,
			text: response.text,
			calls: response.calls.map((c) => ({ toolUseId: c.toolUseId, name: c.name, input: c.input })),
			usage: response.usage,
			stopReason: response.stopReason,
			upstreamStopReason: response.upstreamStopReason,
			reasoningChars: response.reasoningChars,
			wire: response.wire,
			evals: [],
		};
		turns.push(record);
		if (turn === 0) adapter.pushUserTurn(history, prompt, model, []);
		else if (pending.length) adapter.pushUserTurn(history, "", model, pending);
		adapter.pushAssistantTurn(
			history,
			response.text,
			response.calls,
			response.reasoning,
			undefined,
			response.messageId,
			undefined,
			response.textOutputIndex,
			response.redacted,
		);
		pending = [];
		finalText = response.text;
		if (!response.calls.length) {
			naturalStop = true;
			break;
		}
		for (const call of response.calls) {
			if (evalCount >= LIMITS.evals) break;
			evalCount++;
			let outcome: SandboxOutcome;
			if (call.name !== "Eval" || typeof call.input.code !== "string") {
				outcome = {
					ok: false,
					state,
					logs: [],
					error: { code: "INVALID_EVAL_CALL", message: "只有 Eval 工具，输入必须为 code 字符串" },
					interfaceViolation: "invalid native tool call",
				};
			} else {
				try {
					outcome = await evaluate(state, call.input.code, profile.contract);
				} catch (error) {
					infrastructureError = `SANDBOX: ${String(error).slice(0, 1500)}`;
					break;
				}
			}
			const previous = state.trace.length;
			state = outcome.state;
			if (
				!outcome.ok &&
				(outcome.error?.code.startsWith("DELIVERY") ||
					state.trace.slice(previous).some((entry) => entry.op === "deliver" && !entry.ok))
			)
				deliveryProtocolErrors++;
			if (outcome.ok) lastValue = outcome.value;
			const grade = challenge.grade(state, lastValue);
			if (evalCount === 1) firstEvalPass = grade.pass;
			const feedback = {
				ok: outcome.ok,
				value: outcome.value,
				error: outcome.error,
				logs: outcome.logs,
			};
			record.evals.push({
				number: evalCount,
				toolUseId: call.toolUseId,
				delivery: outcome.delivery,
				feedback,
				trace: state.trace.slice(previous),
				interfaceViolation: outcome.interfaceViolation,
				gradeAfterEval: grade,
			});
			pending.push(
				adapter.formatToolResult(
					call.toolUseId,
					JSON.stringify(feedback),
					!outcome.ok,
					undefined,
					call.name,
				),
			);
			if (outcome.ok && outcome.delivery) {
				// The stop decision depends only on the trusted delivery envelope, never grade.
				deliveryAccepted = true;
				finalText = outcome.delivery.summary ?? response.text;
				const remaining = response.calls.slice(response.calls.indexOf(call) + 1);
				deliveryProtocolErrors += remaining.length;
				record.notExecutedAfterDelivery = remaining.map((later) => ({
					toolUseId: later.toolUseId,
					name: later.name,
					input: later.input,
					code: "DELIVERY_CLOSED",
					executed: false,
				}));
				break;
			}
		}
		if (deliveryAccepted || infrastructureError || evalCount >= LIMITS.evals) break;
	}
	const grade = challenge.grade(state, lastValue);
	return {
		model,
		requestedEffort: "low",
		channelType,
		challenge: challenge.file,
		challengeId,
		interfaceVersion: profile.id,
		graderVersion: GRADER_VERSION,
		apiHash: hash(api),
		descriptionHash: hash(profile.description),
		contractHash: hash(JSON.stringify(profile.contract)),
		challengeHash: hash(prompt),
		fixtureHash: hash(JSON.stringify(challenge.makeState())),
		firstEvalPass,
		finalPass: !infrastructureError && grade.pass,
		reasons: grade.reasons,
		infrastructureError,
		naturalStop,
		deliveryEnabled: !!profile.contract.delivery,
		deliveryAccepted,
		deliveryProtocolErrors,
		correctDelivery:
			deliveryAccepted && deliveryProtocolErrors === 0 && !infrastructureError && grade.pass,
		evalCount,
		durationMs: Date.now() - started,
		helps: state.trace.filter((t) => t.op === "help").length,
		uncaughtScriptErrors: turns.flatMap((t) => t.evals).filter((e) => !e.feedback.ok).length,
		interfaceViolations: turns.flatMap((t) => t.evals).filter((e) => e.interfaceViolation).length,
		finalText,
		lastValue,
		finalState: state,
		turns,
	};
}

async function runModels() {
	const api = await checkedApiGuide();
	await assertPodmanReady();
	const runId = new Date().toISOString().replace(/[:.]/g, "-");
	const files: string[] = [];
	const selectedCase = process.argv.find((a) => a.startsWith("--case="))?.slice(7);
	const selectedModel = process.argv.find((a) => a.startsWith("--model="))?.slice(8);
	const targetCases = selectedCase ? challenges.filter((c) => c.id === selectedCase) : challenges;
	const targets = selectedModel ? MODELS.filter((m) => m === selectedModel) : MODELS;
	if (!targets.length || !targetCases.length) throw new Error("Unknown model/case selection");
	const sourceNames = [
		"runner.ts",
		"fixtures.ts",
		"contract.ts",
		"profiles.ts",
		"run.ts",
		"client.ts",
		"error-redaction.ts",
		"artifacts.ts",
		"isolate.ts",
		"analyze.ts",
	];
	const sources = Object.fromEntries(
		await Promise.all(
			sourceNames.map(
				async (name) =>
					[name, await Bun.file(`${root}tests/task-call-challenges/${name}`).text()] as const,
			),
		),
	);
	const sourceHashes = Object.fromEntries(
		Object.entries(sources).map(([name, text]) => [name, hash(text)]),
	);
	const sourceSnapshot = `${docs}/results/${runId}-sources.json`;
	const inputSnapshot = `${docs}/results/${runId}-inputs.json`;
	await Bun.write(
		sourceSnapshot,
		`${JSON.stringify({ sources, hashes: sourceHashes }, null, 2)}\n`,
	);
	await Bun.write(
		inputSnapshot,
		`${JSON.stringify(
			{
				interfaceVersion: CONTRACT_VERSION,
				api,
				evalTool: {
					name: evalTool.name,
					description: EVAL_DESCRIPTION,
					parameters: evalTool.rawJsonSchema,
				},
				contract: RUNTIME_CONTRACT,
				challenges: Object.fromEntries(
					await Promise.all(
						targetCases.map(
							async (c) => [c.file, await Bun.file(`${docs}/${c.file}`).text()] as const,
						),
					),
				),
			},
			null,
			2,
		)}\n`,
	);
	const manifestPath = `${docs}/results/${runId}-manifest.json`;
	const manifest = {
		runId,
		limits: LIMITS,
		models: targets,
		effort: "low",
		image: IMAGE,
		files,
		interfaceVersion: CONTRACT_VERSION,
		apiHash: hash(api),
		descriptionHash: hash(EVAL_DESCRIPTION),
		contractHash: hash(JSON.stringify(RUNTIME_CONTRACT)),
		simulatorHash: sourceHashes["runner.ts"],
		graderVersion: GRADER_VERSION,
		graderHash: sourceHashes["fixtures.ts"],
		sourceSnapshot: artifactReference(manifestPath, sourceSnapshot),
		inputSnapshot: artifactReference(manifestPath, inputSnapshot),
		sourceHashes,
	};
	await Bun.write(manifestPath, `${JSON.stringify({ ...manifest, status: "running" }, null, 2)}\n`);
	await Promise.all(
		targets.map(async (model) => {
			for (const challenge of targetCases) {
				console.log(`START ${model} case=${challenge.id} effort=low`);
				const result = await runEpisode(model, challenge.id);
				const file = `${docs}/results/${runId}-${model.startsWith("nugjp") ? "luna" : "flash"}-${challenge.id}.json`;
				await Bun.write(
					file,
					`${JSON.stringify({ runId, limits: LIMITS, image: IMAGE, ...result }, null, 2)}\n`,
				);
				files.push(artifactReference(manifestPath, file));
				console.log(
					JSON.stringify({
						model,
						case: challenge.id,
						first: result.firstEvalPass,
						final: result.finalPass,
						evals: result.evalCount,
						helps: result.helps,
						infrastructureError: result.infrastructureError,
						reasons: result.reasons,
					}),
				);
				if (result.infrastructureError) break; // Diagnose infrastructure before spending on more calls.
			}
		}),
	);
	const sourceDrift: string[] = [];
	for (const name of sourceNames) {
		if (
			hash(await Bun.file(`${root}tests/task-call-challenges/${name}`).text()) !==
			sourceHashes[name]
		)
			sourceDrift.push(name);
	}
	await Bun.write(
		manifestPath,
		`${JSON.stringify(
			{
				...manifest,
				status: files.length === targets.length * targetCases.length ? "complete" : "partial",
				sourceDrift,
			},
			null,
			2,
		)}\n`,
	);
	assert.equal(
		sourceDrift.length,
		0,
		`Sources changed during model run: ${sourceDrift.join(", ")}`,
	);
	console.log(`RESULT_MANIFEST ${manifestPath}`);
}

if (import.meta.main) {
	try {
		if (process.argv.includes("--write-api")) {
			await Bun.write(`${docs}/API.md`, renderApiGuide());
			console.log("API.md generated from contract.ts");
		} else if (process.argv.includes("--self-test")) await selfTest();
		else await runModels();
	} catch (error) {
		console.error(safeError(error));
		process.exitCode = 1;
	}
}
