import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { artifactReference, verifyFrozenBaseline } from "./artifacts";
import { challenges, GRADER_VERSION } from "./fixtures";
import { assertPodmanReady, IMAGE } from "./isolate";
import {
	coherentProfiles,
	experimentProfiles,
	FROZEN_V4,
	FROZEN_V5,
	FROZEN_V6,
	qualificationProfile,
} from "./profiles";
import { LIMITS, MODELS, runEpisode, safeError } from "./run";

const root = fileURLToPath(new URL("../../", import.meta.url));
const docs = `${root}docs/task-call-challenges`;
const sourcesToFreeze = [
	"fixtures.ts",
	"contract.ts",
	"profiles.ts",
	"runner.ts",
	"isolate.ts",
	"client.ts",
	"error-redaction.ts",
	"artifacts.ts",
	"run.ts",
	"analyze.ts",
	"delivery.test.ts",
	"delivery-experiment.ts",
];
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
type Episode = Awaited<ReturnType<typeof runEpisode>>;
type Trial = Episode & {
	stage: "pilot" | "regression" | "qualification";
	condition: "A" | "B";
	repeat: number;
	ordinal: number;
	file: string;
};

export interface CompletionEvidence {
	infrastructureError?: string;
	deliveryAccepted: boolean;
	naturalStop: boolean;
	turns: Array<{
		stopReason?: string;
		upstreamStopReason?: string;
		calls: unknown[];
		notExecutedAfterDelivery?: unknown[];
		evals: Array<{ feedback: { ok: boolean }; delivery?: unknown }>;
	}>;
}

export function completionKind(result: CompletionEvidence): string {
	if (result.infrastructureError) return "infrastructure";
	const lastTurn = result.turns.at(-1);
	const reason = lastTurn?.upstreamStopReason ?? lastTurn?.stopReason;
	if (reason === "max_tokens" || reason === "length") return "truncated";
	const lastEval = result.turns.flatMap((turn) => turn.evals).at(-1);
	if (!lastEval) return "no_execution";
	if (!lastEval.feedback.ok) return "unresolved_error";
	if (result.deliveryAccepted) {
		if (lastTurn?.notExecutedAfterDelivery?.length) return "delivery_conflict";
		return lastEval.delivery !== undefined ? "delivery" : "invalid_delivery";
	}
	if (result.naturalStop && lastTurn?.calls.length === 0) {
		return reason === "end_turn" ? "natural" : "unknown_stop";
	}
	return "budget";
}

export function qualifies(result: CompletionEvidence & { finalPass: boolean }): boolean {
	return result.finalPass && ["delivery", "natural"].includes(completionKind(result));
}

function diagnose(trial: Trial) {
	const evals = trial.turns.flatMap((turn) => turn.evals) as Array<{
		number: number;
		gradeAfterEval: { pass: boolean };
		feedback: { error?: { code: string } };
	}>;
	const firstPassing = evals.find((e) => e.gradeAfterEval.pass)?.number;
	const usage = trial.turns as Array<{
		usage?: { promptTokens?: number; completionTokens?: number };
		wire: unknown[];
	}>;
	return {
		stage: trial.stage,
		condition: trial.condition,
		model: trial.model,
		case: trial.challengeId,
		repeat: trial.repeat,
		ordinal: trial.ordinal,
		interfaceVersion: trial.interfaceVersion,
		strictPass: trial.finalPass,
		qualified: qualifies(trial),
		completion: completionKind(trial),
		deliveryEnabled: trial.deliveryEnabled,
		deliveryAccepted: trial.deliveryAccepted,
		correctDelivery: trial.correctDelivery,
		deliveryProtocolErrors: trial.deliveryProtocolErrors,
		interfaceViolations: trial.interfaceViolations,
		firstPassingEval: firstPassing ?? null,
		evalsAfterFirstPass: firstPassing === undefined ? null : trial.evalCount - firstPassing,
		regressedAfterPassing: firstPassing !== undefined && !trial.finalPass,
		evals: trial.evalCount,
		helps: trial.helps,
		modelResponses: trial.turns.length,
		requests: usage.reduce((n, t) => n + t.wire.length, 0),
		inputTokens: usage.reduce((n, t) => n + (t.usage?.promptTokens ?? 0), 0),
		outputTokens: usage.reduce((n, t) => n + (t.usage?.completionTokens ?? 0), 0),
		usageComplete: usage.every(
			(t) =>
				typeof t.usage?.promptTokens === "number" && typeof t.usage?.completionTokens === "number",
		),
		termination: trial.infrastructureError
			? "infrastructure"
			: trial.deliveryAccepted
				? "delivery"
				: trial.naturalStop
					? "natural"
					: "budget",
		lastValueType: Array.isArray(trial.lastValue)
			? "array"
			: trial.lastValue === null
				? "null"
				: typeof trial.lastValue,
		errorCodes: [
			...new Set(trial.finalState.trace.flatMap((t) => (t.error ? [t.error.code] : []))),
		],
		infrastructureError: trial.infrastructureError,
		reasons: trial.reasons,
		file: trial.file,
	};
}

async function main() {
	assert(
		process.argv.slice(2).every((arg) => ["--coherent", "--qualify"].includes(arg)),
		"Only --coherent or --qualify is supported",
	);
	const qualification = process.argv.includes("--qualify");
	const coherent = process.argv.includes("--coherent");
	assert(!(qualification && coherent), "Choose one experiment mode");
	await assertPodmanReady();
	const profiles =
		qualification || coherent ? await coherentProfiles() : await experimentProfiles();
	if (qualification) profiles.delivery = await qualificationProfile();
	const conditions = { A: profiles.baseline, B: profiles.delivery };
	const activeConditions = qualification ? { B: conditions.B } : conditions;
	const maxTrials = qualification ? 24 : 28;
	const runId = new Date().toISOString().replace(/[:.]/g, "-");
	const prefix = `${docs}/results/${runId}-${qualification ? "qualification" : coherent ? "coherent-delivery" : "delivery"}`;
	const files: string[] = [];
	const trials: Trial[] = [];
	const failures: Array<{ model: string; case: string; error: string }> = [];
	let aborted = false;
	let attempted = 0;
	let gatePassed = false;
	const sources = Object.fromEntries(
		await Promise.all(
			sourcesToFreeze.map(
				async (name) =>
					[name, await Bun.file(`${root}tests/task-call-challenges/${name}`).text()] as const,
			),
		),
	);
	const sourceHashes = Object.fromEntries(
		Object.entries(sources).map(([name, text]) => [name, hash(text)]),
	);
	const frozenManifestPath = `${docs}/results/${FROZEN_V4}-manifest.json`;
	const challengeInputs = Object.fromEntries(
		await Promise.all(
			challenges.map(
				async (c) =>
					[
						c.id,
						{
							file: c.file,
							text: await Bun.file(`${docs}/${c.file}`).text(),
							fixtureHash: hash(JSON.stringify(c.makeState())),
						},
					] as const,
			),
		),
	);
	const { originalGraderHash } = await verifyFrozenBaseline(
		frozenManifestPath,
		Object.entries(challengeInputs).map(([id, input]) => ({ id, ...input })),
	);
	const manifestPath = `${prefix}-manifest.json`;
	const sourceSnapshot = `${prefix}-sources.json`;
	const inputSnapshot = `${prefix}-inputs.json`;
	await Bun.write(sourceSnapshot, `${JSON.stringify({ sources, sourceHashes }, null, 2)}\n`);
	await Bun.write(
		inputSnapshot,
		`${JSON.stringify({ conditions: activeConditions, challenges: challengeInputs }, null, 2)}\n`,
	);
	const manifest = {
		runId,
		experiment: qualification
			? "full-suite-qualification"
			: coherent
				? "coherent-delivery-abba"
				: "explicit-delivery-abba",
		image: IMAGE,
		models: MODELS,
		effort: "low",
		limits: LIMITS,
		...(qualification
			? {
					qualification: {
						rounds: 2,
						cases: challenges.map((c) => c.id),
						roundOrder: [challenges.map((c) => c.id), challenges.map((c) => c.id).reverse()],
						planned: 24,
					},
					qualificationGate:
						"All 24 trials pass the versioned corrected business grader and end with trusted delivery or a normal natural end_turn after a successful Eval. Truncation, budget exhaustion, unresolved errors, infrastructure failure, or source drift do not qualify. No production implementation before explicit user go-ahead.",
				}
			: {
					pilot: {
						cases: ["3", "5"],
						order: ["A", "B", "B", "A"],
						repeatsPerCondition: 2,
						planned: 16,
					},
					regressionGate:
						"Only when all 8 B pilot trials strictly pass, deliver cleanly, and have zero interface violations; no infrastructure errors or source drift.",
				}),
		maximumTrials: maxTrials,
		frozenBaseline: qualification ? FROZEN_V6 : coherent ? FROZEN_V5 : FROZEN_V4,
		conditions: Object.fromEntries(
			Object.entries(activeConditions).map(([key, profile]) => [
				key,
				{ id: profile.id, deliveryEnabled: !!profile.contract.delivery },
			]),
		),
		sourceHashes,
		sourceSnapshot: artifactReference(manifestPath, sourceSnapshot),
		inputSnapshot: artifactReference(manifestPath, inputSnapshot),
		files,
		graderVersion: GRADER_VERSION,
		originalGraderHash,
		graderHash: sourceHashes["fixtures.ts"],
		profileHashes: Object.fromEntries(
			Object.entries(activeConditions).map(([condition, p]) => [
				condition,
				{
					api: hash(p.api),
					description: hash(p.description),
					parameters: hash(JSON.stringify(p.parameters)),
					contract: hash(JSON.stringify(p.contract)),
				},
			]),
		),
	};
	async function driftedSources() {
		const drift: string[] = [];
		for (const name of sourcesToFreeze)
			if (
				hash(await Bun.file(`${root}tests/task-call-challenges/${name}`).text()) !==
				sourceHashes[name]
			)
				drift.push(name);
		return drift;
	}
	async function saveManifest(status: string) {
		await Bun.write(
			manifestPath,
			`${JSON.stringify({ ...manifest, status, attempted, gatePassed, failures, sourceDrift: await driftedSources() }, null, 2)}\n`,
		);
	}
	async function runTrial(
		model: string,
		id: string,
		stage: Trial["stage"],
		condition: Trial["condition"],
		repeat: number,
		ordinal: number,
	) {
		if (aborted) return;
		assert(++attempted <= maxTrials, "Pre-registered experiment limit exceeded");
		console.log(
			`START ${stage} ${model} case=${id} condition=${condition} repeat=${repeat} effort=low`,
		);
		try {
			const result = await runEpisode(model, id, conditions[condition]);
			const file = `${prefix}-${stage}-${model.startsWith("nugjp") ? "luna" : "flash"}-${id}-${condition}-${repeat}.json`;
			const trial: Trial = {
				...result,
				stage,
				condition,
				repeat,
				ordinal,
				file: artifactReference(manifestPath, file),
			};
			assert.equal(result.fixtureHash, challengeInputs[id].fixtureHash);
			assert.equal(result.challengeHash, hash(challengeInputs[id].text));
			await Bun.write(
				file,
				`${JSON.stringify({ runId, image: IMAGE, limits: LIMITS, ...trial }, null, 2)}\n`,
			);
			files.push(trial.file);
			trials.push(trial);
			console.log(JSON.stringify(diagnose(trial)));
			if (result.infrastructureError) {
				aborted = true;
				failures.push({ model, case: id, error: result.infrastructureError });
			}
		} catch (error) {
			aborted = true;
			failures.push({ model, case: id, error: safeError(error) });
		}
	}
	await saveManifest("running");
	try {
		if (qualification) {
			await Promise.all(
				MODELS.map(async (model) => {
					for (const repeat of [1, 2]) {
						const ordered = repeat === 1 ? [...challenges] : [...challenges].reverse();
						for (const [index, c] of ordered.entries()) {
							if (aborted) return;
							await runTrial(
								model,
								c.id,
								"qualification",
								"B",
								repeat,
								(repeat - 1) * challenges.length + index + 1,
							);
						}
					}
				}),
			);
			gatePassed =
				!aborted &&
				trials.length === 24 &&
				trials.every(qualifies) &&
				(await driftedSources()).length === 0;
			console.log(
				`QUALIFICATION_GATE ${gatePassed ? "PASS: wait for user go-ahead" : "NOT MET: retain failures for diagnosis"}`,
			);
		} else {
			await Promise.all(
				MODELS.map(async (model) => {
					for (const id of ["3", "5"]) {
						const repeats = { A: 0, B: 0 };
						for (const [index, condition] of (["A", "B", "B", "A"] as const).entries()) {
							if (aborted) return;
							await runTrial(model, id, "pilot", condition, ++repeats[condition], index + 1);
						}
					}
				}),
			);
			const deliveryTrials = trials.filter((t) => t.stage === "pilot" && t.condition === "B");
			gatePassed =
				!aborted &&
				trials.length === 16 &&
				deliveryTrials.length === 8 &&
				deliveryTrials.every((t) => t.correctDelivery && t.interfaceViolations === 0) &&
				(await driftedSources()).length === 0;
			console.log(
				`REGRESSION_GATE ${gatePassed ? "PASS: running 12 full-suite delivery trials" : "NOT MET: no expansion"}`,
			);
			await saveManifest(gatePassed ? "regression" : "pilot-finished");
			if (gatePassed)
				await Promise.all(
					MODELS.map(async (model) => {
						for (const c of challenges) {
							if (aborted) return;
							await runTrial(model, c.id, "regression", "B", 1, Number(c.id));
						}
					}),
				);
		}
	} finally {
		await saveManifest(aborted ? "partial" : "complete");
		const rows = trials.map(diagnose);
		const groups = [...new Set(rows.map((r) => `${r.stage}:${r.model}:${r.condition}`))].map(
			(key) => {
				const group = rows.filter((r) => `${r.stage}:${r.model}:${r.condition}` === key);
				return {
					stage: group[0].stage,
					model: group[0].model,
					condition: group[0].condition,
					trials: group.length,
					strictPass: group.filter((r) => r.strictPass).length,
					qualified: group.filter((r) => r.qualified).length,
					validNaturalStops: group.filter((r) => r.completion === "natural").length,
					correctDelivery: group[0].deliveryEnabled
						? group.filter((r) => r.correctDelivery).length
						: null,
					deliveries: group.filter((r) => r.deliveryAccepted).length,
					regressedAfterPassing: group.filter((r) => r.regressedAfterPassing).length,
					deliveryProtocolErrors: group.reduce((n, r) => n + r.deliveryProtocolErrors, 0),
					evals: group.reduce((n, r) => n + r.evals, 0),
					helps: group.reduce((n, r) => n + r.helps, 0),
					requests: group.reduce((n, r) => n + r.requests, 0),
					inputTokens: group.reduce((n, r) => n + r.inputTokens, 0),
					outputTokens: group.reduce((n, r) => n + r.outputTokens, 0),
				};
			},
		);
		await Bun.write(
			`${prefix}-comparison.json`,
			`${JSON.stringify(
				{
					runId,
					gatePassed,
					attempted,
					failures,
					sourceDrift: await driftedSources(),
					groups,
					rows,
					note: qualification
						? "Full-suite qualification: unchanged frozen candidate and business scorer, two complete rounds per model. Explicit delivery and normal natural end_turn are both valid. Truncation and budget exhaustion are not successful termination. Qualification does not authorize production changes; wait for the user."
						: coherent
							? "V5 versus coherent V6: both profiles have identical delivery capabilities and limits; only guide/help/workflow/error wording differs. Original business grader unchanged. No schema coercion, IIFE rule changes, or grader-based stopping. ABBA pilot and gated regression are separate; beating V5 does not demonstrate superiority to default V4."
							: "Original business grader unchanged. Delivery correctness additionally requires a trusted delivery and zero delivery protocol errors. A retains natural final responses; B may eliminate that response mechanically. No schema coercion or grader-based stopping. ABBA pilot and gated regression are reported separately; no best-of selection.",
				},
				null,
				2,
			)}\n`,
		);
		console.log(`RESULT_MANIFEST ${prefix}-manifest.json`);
		console.log(JSON.stringify({ gatePassed, groups }, null, 2));
	}
	assert(
		!aborted,
		"Infrastructure interrupted the experiment; inspect preserved manifest before retrying",
	);
	assert.deepEqual(await driftedSources(), [], "Sources changed during experiment");
}

if (import.meta.main) {
	try {
		await main();
	} catch (error) {
		console.error(safeError(error));
		process.exitCode = 1;
	}
}
