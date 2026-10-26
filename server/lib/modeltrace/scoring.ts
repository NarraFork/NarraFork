// Typed port of ModelTrace static/fingerprint-core.js (MIT, xqy2006).
// Source revision: 6cd4a8ff0f3f4e49d6d6969dd2fbadfa1569fde2.
// Preserve arithmetic order: calibration depends on the upstream feature pipeline.
import bankData from "./unified-bank.json";

export const bank = bankData;
const DIMENSION = 355;
const ALPHA = 0.5;
const mean = (values: number[]) =>
	values.reduce((total, value) => total + value, 0) / values.length;

function standardize(values: number[]): number[] {
	const center = mean(values);
	const variance = mean(values.map((value) => (value - center) ** 2));
	const scale = Math.max(Math.sqrt(variance), 1e-12);
	return values.map((value) => (value - center) / scale);
}

function dot(left: number[], right: number[]): number {
	let value = 0;
	for (let index = 0; index < left.length; index += 1) value += left[index] * right[index];
	return value;
}

function normalized(values: number[]): number[] {
	const scale = Math.max(Math.sqrt(dot(values, values)), 1e-12);
	return values.map((value) => value / scale);
}

function subtractBasis(values: number[], basis: number[][]): number[] {
	const output = values.slice();
	for (const vector of basis || []) {
		const projection = dot(output, vector);
		for (let index = 0; index < output.length; index += 1) {
			output[index] -= projection * vector[index];
		}
	}
	return output;
}

function countNumbers(numbers: number[]): number[] {
	const counts: number[] = Array(DIMENSION).fill(0);
	for (const number of numbers) counts[number - 1] += 1;
	return counts;
}

function orderedBlockFeature(numbers: number[]): number[] {
	const base = Math.floor(numbers.length / 4);
	const remainder = numbers.length % 4;
	const chunks: number[][] = [];
	let start = 0;
	for (let index = 0; index < 4; index += 1) {
		const size = base + (index < remainder ? 1 : 0);
		chunks.push(numbers.slice(start, start + size));
		start += size;
	}
	const pieces: number[] = [];
	for (const chunk of chunks) {
		const bins: number[] = Array(16).fill(0.5);
		for (const value of chunk) {
			const index = Math.min(15, Math.floor(((value - 1) / 355) * 16));
			bins[index] += 1;
		}
		const total = bins.reduce((sum, value) => sum + value, 0);
		pieces.push(...bins.map((value) => Math.sqrt(value / total)));
	}
	const lastDigits: number[] = Array(10).fill(0.5);
	for (const value of numbers) lastDigits[value % 10] += 1;
	const lastTotal = lastDigits.reduce((sum, value) => sum + value, 0);
	pieces.push(...lastDigits.map((value) => Math.sqrt(value / lastTotal)));
	return pieces;
}

function robustScoreNumbers(numbers: number[]): number[] {
	const counts = countNumbers(numbers);
	const artifact = bank.robust.hellinger;
	const total = counts.reduce((sum, value) => sum + value, 0) + ALPHA * DIMENSION;
	const feature = counts.map((value) => Math.sqrt((value + ALPHA) / total));
	let projected = feature.map(
		(value, index) => (value - artifact.feature_mean[index]) / artifact.feature_scale[index],
	);
	projected = normalized(subtractBasis(projected, artifact.nuisance_basis));
	const marginal = standardize(artifact.centroids.map((centroid) => dot(projected, centroid)));
	const orderedArtifact = bank.robust.ordered_blocks;
	const weight = Number(orderedArtifact.weight || 0);
	if (weight === 0) return marginal;
	const orderedFeature = orderedBlockFeature(numbers);
	const standardizedFeature = orderedFeature.map(
		(value, index) =>
			(value - orderedArtifact.feature_mean[index]) / orderedArtifact.feature_scale[index],
	);
	const unit = normalized(standardizedFeature);
	const environmentScores = orderedArtifact.environment_centroids.map((centroids) =>
		centroids.map((centroid) => dot(unit, centroid)),
	);
	const template = standardize(
		orderedArtifact.centroids.map((_, modelIndex) =>
			Math.max(...environmentScores.map((scores) => scores[modelIndex])),
		),
	);
	const orderedProjected = normalized(
		subtractBasis(standardizedFeature, orderedArtifact.nuisance_basis),
	);
	const nuisance = standardize(
		orderedArtifact.centroids.map((centroid) => dot(orderedProjected, centroid)),
	);
	const ordered = standardize(template.map((value, index) => 0.5 * value + 0.5 * nuisance[index]));
	return marginal.map((value, index) => (1 - weight) * value + weight * ordered[index]);
}

/** Single-sample closed-set scores; callers must first validate the numeric array. */
export function scoreModelTrace(numbers: number[]) {
	const scores = robustScoreNumbers(numbers);
	const beta = Number(bank.calibration["1"].beta);
	const logits = scores.map((value) => beta * value);
	const maximum = Math.max(...logits);
	const weights = logits.map((value) => Math.exp(value - maximum));
	const total = weights.reduce((sum, value) => sum + value, 0);
	const results = bank.models
		.map((model, index) => ({
			model: model.id,
			displayName: model.display_name,
			family: model.family,
			familyName: model.family_name,
			probability: weights[index] / total,
			score: scores[index],
		}))
		.sort((left, right) => right.probability - left.probability);
	const familyOrder = [...new Set(bank.models.map((model) => model.family))];
	const families = familyOrder.map((family) => ({
		family,
		displayName: results.find((item) => item.family === family)?.familyName || family,
		probability: results
			.filter((item) => item.family === family)
			.reduce((sum, item) => sum + item.probability, 0),
	}));
	return { results, families, beta };
}
