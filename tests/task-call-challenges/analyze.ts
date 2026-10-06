import { createHash } from "node:crypto";
import { resolveArtifactPath, writeNewArtifact } from "./artifacts";
import { challenges, GRADER_VERSION, type MockState, type TraceEntry } from "./fixtures";

const manifestPath = process.argv[2];
if (!manifestPath?.endsWith("-manifest.json")) throw new Error("Pass a result manifest path");
const manifest = await Bun.file(manifestPath).json();
const expectedErrors = new Set(["TEST_FAILURE", "CONTRACT_CHANGED"]);
const rows: Array<Record<string, any>> = [];
const repeatOps = ["read", "Bash", "finish"] as const;
function repeatedCalls(trace: TraceEntry[], op: string): number {
	const entries = trace.filter((entry) => entry.op === op);
	return (
		entries.length - new Set(entries.map((entry) => JSON.stringify([entry.key, entry.args]))).size
	);
}
const frozenInputsValid = !manifest.sourceDrift?.length;
for (const file of manifest.files as string[]) {
	const record = await Bun.file(resolveArtifactPath(manifestPath, file)).json();
	const challenge = challenges.find((c) => c.id === record.challengeId)!;
	const state: MockState = record.finalState;
	const strict = challenge.grade(state, record.lastValue);
	// A separate recovery metric: keep successful actions and expected injected
	// failures, but do not count already-rejected attempts as successful mutations.
	const recovered = structuredClone(state);
	recovered.trace = recovered.trace.filter(
		(t) => t.ok || (t.error && expectedErrors.has(t.error.code)),
	);
	const business = challenge.grade(recovered, record.lastValue);
	const calls = record.turns.flatMap((turn: any) => turn.evals);
	const allCode = record.turns
		.flatMap((turn: any) => turn.calls)
		.map((c: any) => c.input?.code ?? "")
		.join("\n");
	const wire = record.turns.flatMap((turn: any) => turn.wire ?? []);
	const errors: TraceEntry[] = state.trace.filter(
		(t) => !t.ok && t.error && !expectedErrors.has(t.error.code),
	);
	rows.push({
		model: record.model,
		case: record.challengeId,
		rawStrictPass: record.finalPass,
		correctedStrictPass: frozenInputsValid && !record.infrastructureError && strict.pass,
		recoveredBusinessPass: frozenInputsValid && !record.infrastructureError && business.pass,
		strictReasons: strict.reasons,
		businessReasons: business.reasons,
		firstEvalGoalPass: record.firstEvalPass,
		firstEvalExecuted: calls[0]?.feedback.ok === true,
		evals: record.evalCount,
		helps: record.helps,
		modelResponses: record.turns.length,
		naturalStop: record.naturalStop,
		errorCodes: errors.map((e) => e.error?.code),
		helpHarnessGap: errors.some(
			(e) =>
				e.error?.code === "UNKNOWN_HELP" && (e.args as { topic?: string })?.topic === "task.block",
		),
		interfaceViolations: record.interfaceViolations,
		wireLowAndEvalOnly:
			wire.length > 0 &&
			wire.every((w: any) => w.effort === "low" && w.tools?.length === 1 && w.tools[0] === "Eval"),
		wireMatchesFrozenDescriptions: manifest.descriptionHash
			? wire.length > 0 &&
				wire.every(
					(w: { descriptionHash?: string; apiHash?: string }) =>
						w.descriptionHash === manifest.descriptionHash && w.apiHash === manifest.apiHash,
				)
			: null,
		readCalls: state.trace.filter((t) => t.op === "read").length,
		bashCalls: state.trace.filter((t) => t.op === "Bash").length,
		repeatCandidates: Object.fromEntries(
			repeatOps.map((op) => [op, repeatedCalls(state.trace, op)]),
		),
		codeChars: allCode.length,
		feedbackChars: calls.reduce(
			(n: number, call: { feedback: unknown }) => n + JSON.stringify(call.feedback).length,
			0,
		),
		codeUsesAwait: /\bawait\b/.test(allCode),
		codeUsesRefPlumbing: /\.ref\b|tasks\.(?:start|finish)\(/.test(allCode),
		usage: record.turns.reduce(
			(acc: any, turn: any) => ({
				input: acc.input + (turn.usage?.promptTokens ?? 0),
				output: acc.output + (turn.usage?.completionTokens ?? 0),
			}),
			{ input: 0, output: 0 },
		),
		finalText: record.finalText,
		file,
	});
}
rows.sort((a, b) => a.model.localeCompare(b.model) || Number(a.case) - Number(b.case));
const summary = [...new Set(rows.map((r) => r.model))].map((model) => {
	const group = rows.filter((r) => r.model === model);
	return {
		model,
		cases: group.length,
		correctedStrictPass: group.filter((r) => r.correctedStrictPass).length,
		recoveredBusinessPass: group.filter((r) => r.recoveredBusinessPass).length,
		firstEvalGoalPass: group.filter((r) => r.firstEvalGoalPass).length,
		firstEvalExecuted: group.filter((r) => r.firstEvalExecuted).length,
		evals: group.reduce((n, r) => n + r.evals, 0),
		helps: group.reduce((n, r) => n + r.helps, 0),
		responses: group.reduce((n, r) => n + r.modelResponses, 0),
		interfaceViolations: group.reduce((n, r) => n + r.interfaceViolations, 0),
		allWireLowAndEvalOnly: group.every((r) => r.wireLowAndEvalOnly),
		allWireMatchesFrozenDescriptions: manifest.descriptionHash
			? group.every((r) => r.wireMatchesFrozenDescriptions)
			: null,
		readCalls: group.reduce((n, r) => n + r.readCalls, 0),
		bashCalls: group.reduce((n, r) => n + r.bashCalls, 0),
		repeatCandidates: Object.fromEntries(
			repeatOps.map((op) => [op, group.reduce((n, r) => n + r.repeatCandidates[op], 0)]),
		),
		codeChars: group.reduce((n, r) => n + r.codeChars, 0),
		feedbackChars: group.reduce((n, r) => n + r.feedbackChars, 0),
		inputTokens: group.reduce((n, r) => n + r.usage.input, 0),
		outputTokens: group.reduce((n, r) => n + r.usage.output, 0),
	};
});
const report = {
	runId: manifest.runId,
	interfaceVersion: manifest.interfaceVersion,
	frozenInputsValid,
	efficiencyNote:
		"repeatCandidates 仅统计相同操作/key/参数的重复调用，不自动视为多余；例如验收前同次 Eval 的 read 是必需的。feedbackChars 是工具反馈 JSON 字符数，不含完整请求重放。token 为对应网关回报值，不能据此跨模型推断成本。",
	gradingNote:
		"原题未要求裸字符串：状态字符串与顶层 {status:...} 均接受。原始 JSON 不覆盖。strict 仍拒绝违规动作尝试；recoveredBusiness 单独报告被拦截后最终正确的结果，不等于全程正确。UNKNOWN_HELP(task.block) 是 v1 夹具缺口，原题4的效率不可用于公平比较。",
	originalGraderVersion: manifest.graderVersion ?? "unversioned",
	currentGraderVersion: GRADER_VERSION,
	originalGraderHash: manifest.graderHash,
	currentGraderHash: createHash("sha256")
		.update(await Bun.file(new URL("./fixtures.ts", import.meta.url)).text())
		.digest("hex"),
	summary,
	rows,
};
const path =
	process.argv.find((arg) => arg.startsWith("--output="))?.slice(9) ??
	manifestPath.replace(/-manifest\.json$/, `-analysis-${GRADER_VERSION}.json`);
await writeNewArtifact(path, report);
console.log(
	JSON.stringify(
		{
			analysis: path,
			summary,
			rows: rows.map(
				({
					model,
					case: id,
					correctedStrictPass,
					recoveredBusinessPass,
					evals,
					helps,
					errorCodes,
					helpHarnessGap,
				}) => ({
					model,
					case: id,
					correctedStrictPass,
					recoveredBusinessPass,
					evals,
					helps,
					errorCodes,
					helpHarnessGap,
				}),
			),
		},
		null,
		2,
	),
);
