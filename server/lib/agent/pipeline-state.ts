import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { db } from "@server/db";
import { narrators } from "@server/db/schema";
import { eq } from "drizzle-orm";
import { narratorTraitsLock } from "../async-mutex";
import { parseTraits } from "../narrator-utils";
import {
	MAX_PIPELINE_CAPTURE_BYTES,
	MAX_PIPELINE_CAPTURE_CHARS,
	MAX_PIPELINE_CAPTURE_LINES,
	PipelineRuleError,
} from "./pipeline-rules";
import { OUTPUT_DIR, persistOutput } from "./truncate";

const PIPELINE_TRAIT_PREFIX = "pipeline:";
const DEFAULT_PREVIEW_CHARS = 100;
const MAX_PREVIEW_CHARS = 100;
export const MAX_PIPELINE_CAPTURES = 64;

export interface PipelineCapture {
	alias: string;
	toolUseId: string;
	toolName: string;
	outputPath: string;
	bytes: number;
	preview: string;
	isError: boolean;
	createdAt: string;
	metadata?: Record<string, unknown>;
}

export interface PipelineState {
	id: string;
	label?: string;
	maxPreviewChars: number;
	nextAlias: number;
	captures: PipelineCapture[];
}

export interface PipelineCaptureResult {
	state: PipelineState;
	capture: PipelineCapture;
	previewOutput: string;
}

export interface PipelineCaptureReadLimits {
	maxBytes?: number;
	maxChars?: number;
	maxLines?: number;
	deadlineAt?: number;
}

export interface PipelineCaptureReadResult {
	text: string;
	bytes: number;
	chars: number;
	lines: number;
}

function encodeState(state: PipelineState): string {
	return `${PIPELINE_TRAIT_PREFIX}${Buffer.from(JSON.stringify(state), "utf-8").toString("base64url")}`;
}

function decodeStateTrait(trait: string): PipelineState | null {
	if (!trait.startsWith(PIPELINE_TRAIT_PREFIX)) return null;
	try {
		const json = Buffer.from(trait.slice(PIPELINE_TRAIT_PREFIX.length), "base64url").toString(
			"utf-8",
		);
		const parsed = JSON.parse(json) as PipelineState;
		if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.captures)) return null;
		return {
			id: typeof parsed.id === "string" ? parsed.id : `pipe_${Date.now()}`,
			label: typeof parsed.label === "string" ? parsed.label : undefined,
			maxPreviewChars: clampPreviewChars(parsed.maxPreviewChars),
			nextAlias: Number.isInteger(parsed.nextAlias) && parsed.nextAlias > 0 ? parsed.nextAlias : 1,
			captures: parsed.captures.filter(isCapture),
		};
	} catch {
		return null;
	}
}

function isCapture(value: unknown): value is PipelineCapture {
	if (!value || typeof value !== "object") return false;
	const capture = value as PipelineCapture;
	return (
		typeof capture.alias === "string" &&
		typeof capture.toolUseId === "string" &&
		typeof capture.toolName === "string" &&
		typeof capture.outputPath === "string" &&
		typeof capture.preview === "string"
	);
}

function clampPreviewChars(value: unknown): number {
	if (!Number.isInteger(value) || (value as number) <= 0) return DEFAULT_PREVIEW_CHARS;
	return Math.min(value as number, MAX_PREVIEW_CHARS);
}

async function withPipelineLock<T>(narratorId: string, fn: () => Promise<T>): Promise<T> {
	return narratorTraitsLock.acquire(narratorId, fn);
}

async function readTraits(narratorId: string): Promise<string[]> {
	const row = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: { traits: true },
	});
	return parseTraits(row?.traits);
}

async function writePipelineState(narratorId: string, state: PipelineState | null): Promise<void> {
	const traits = await readTraits(narratorId);
	const nextTraits = traits.filter((trait) => !trait.startsWith(PIPELINE_TRAIT_PREFIX));
	if (state) nextTraits.push(encodeState(state));
	await db
		.update(narrators)
		.set({ traits: nextTraits, updatedAt: new Date().toISOString() })
		.where(eq(narrators.id, narratorId));
}

export async function getPipelineState(narratorId: string): Promise<PipelineState | null> {
	const traits = await readTraits(narratorId);
	for (const trait of traits) {
		const state = decodeStateTrait(trait);
		if (state) return state;
	}
	return null;
}

export async function startPipelineState(
	narratorId: string,
	options?: { label?: string; maxPreviewChars?: number },
): Promise<PipelineState> {
	return withPipelineLock(narratorId, async () => {
		const state: PipelineState = {
			id: `pipe_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
			label: options?.label?.trim() || undefined,
			maxPreviewChars: clampPreviewChars(options?.maxPreviewChars),
			nextAlias: 1,
			captures: [],
		};
		await writePipelineState(narratorId, state);
		return state;
	});
}

export async function clearPipelineState(narratorId: string): Promise<void> {
	await withPipelineLock(narratorId, async () => {
		await writePipelineState(narratorId, null);
	});
}

export async function clearPipelineStateIfActive(narratorId: string): Promise<boolean> {
	return withPipelineLock(narratorId, async () => {
		const traits = await readTraits(narratorId);
		if (!traits.some((trait) => trait.startsWith(PIPELINE_TRAIT_PREFIX))) return false;

		const nextTraits = traits.filter((trait) => !trait.startsWith(PIPELINE_TRAIT_PREFIX));
		await db
			.update(narrators)
			.set({ traits: nextTraits, updatedAt: new Date().toISOString() })
			.where(eq(narrators.id, narratorId));
		return true;
	});
}

export async function capturePipelineOutput(params: {
	narratorId: string;
	toolUseId: string;
	toolName: string;
	input: Record<string, unknown>;
	output: string;
	isError?: boolean;
	metadata?: Record<string, unknown>;
}): Promise<PipelineCaptureResult | null> {
	return withPipelineLock(params.narratorId, async () => {
		const state = await getPipelineState(params.narratorId);
		if (!state) return null;
		if (state.captures.length >= MAX_PIPELINE_CAPTURES) {
			throw new PipelineRuleError(
				`Pipeline capture count exceeds the ${MAX_PIPELINE_CAPTURES} capture limit`,
			);
		}

		const alias = `p${state.nextAlias}`;
		const outputPath = persistOutput(params.output);
		const preview = clipText(params.output, state.maxPreviewChars);
		const capture: PipelineCapture = {
			alias,
			toolUseId: params.toolUseId,
			toolName: params.toolName,
			outputPath,
			bytes: Buffer.byteLength(params.output, "utf-8"),
			preview,
			isError: params.isError ?? false,
			createdAt: new Date().toISOString(),
			metadata: params.metadata,
		};

		const nextState: PipelineState = {
			...state,
			nextAlias: state.nextAlias + 1,
			captures: [...state.captures, capture],
		};
		await writePipelineState(params.narratorId, nextState);

		return {
			state: nextState,
			capture,
			previewOutput: formatCapturedPreview(capture),
		};
	});
}

export function clipText(text: string, maxChars = DEFAULT_PREVIEW_CHARS): string {
	const limit = clampPreviewChars(maxChars);
	if (text.length <= limit) return text;
	return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

export function formatCapturedPreview(capture: PipelineCapture): string {
	return [
		`Pipeline capture alias: ${capture.alias}`,
		`Tool: ${capture.toolName}`,
		`Bytes: ${capture.bytes}`,
		"Preview:",
		capture.preview || "(empty)",
	].join("\n");
}

function assertReadDeadline(deadlineAt?: number): void {
	if (deadlineAt !== undefined && performance.now() > deadlineAt) {
		throw new PipelineRuleError("Pipeline execution exceeded its time limit while reading input");
	}
}

function assertCapturePathShape(outputPath: string): string {
	const root = resolve(OUTPUT_DIR);
	const candidate = resolve(outputPath);
	if (dirname(candidate) !== root || !basename(candidate).startsWith("tool_")) {
		throw new PipelineRuleError("Pipeline capture path is outside the controlled output directory");
	}
	return candidate;
}

export async function readCaptureTextBounded(
	capture: PipelineCapture,
	limits: PipelineCaptureReadLimits = {},
): Promise<PipelineCaptureReadResult> {
	const maxBytes = limits.maxBytes ?? MAX_PIPELINE_CAPTURE_BYTES;
	const maxChars = limits.maxChars ?? MAX_PIPELINE_CAPTURE_CHARS;
	const maxLines = limits.maxLines ?? MAX_PIPELINE_CAPTURE_LINES;
	const candidate = assertCapturePathShape(capture.outputPath);
	assertReadDeadline(limits.deadlineAt);

	const fileInfo = await lstat(candidate);
	if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) {
		throw new PipelineRuleError("Pipeline capture path must be a regular file");
	}
	const [rootRealPath, candidateRealPath] = await Promise.all([
		realpath(OUTPUT_DIR),
		realpath(candidate),
	]);
	if (dirname(candidateRealPath) !== rootRealPath) {
		throw new PipelineRuleError("Pipeline capture path escapes the controlled output directory");
	}
	if (fileInfo.size > maxBytes) {
		throw new PipelineRuleError(
			`Pipeline capture ${capture.alias} exceeds ${maxBytes} input bytes`,
		);
	}

	const handle = await open(candidateRealPath, "r");
	try {
		const decoder = new TextDecoder();
		const chunks: string[] = [];
		const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, maxBytes + 1)));
		let bytes = 0;
		let chars = 0;
		let lines = 0;
		while (true) {
			assertReadDeadline(limits.deadlineAt);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;
			bytes += bytesRead;
			if (bytes > maxBytes) {
				throw new PipelineRuleError(
					`Pipeline capture ${capture.alias} exceeds ${maxBytes} input bytes`,
				);
			}
			const chunk = decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
			if (chunk.length > 0) {
				if (chars === 0) lines = 1;
				chars += chunk.length;
				for (let index = 0; index < chunk.length; index++) {
					if (chunk.charCodeAt(index) === 10) lines++;
				}
				if (chars > maxChars) {
					throw new PipelineRuleError(
						`Pipeline capture ${capture.alias} exceeds ${maxChars} characters`,
					);
				}
				if (lines > maxLines) {
					throw new PipelineRuleError(
						`Pipeline capture ${capture.alias} exceeds ${maxLines} lines`,
					);
				}
				chunks.push(chunk);
			}
		}
		const finalChunk = decoder.decode();
		if (finalChunk.length > 0) {
			if (chars === 0) lines = 1;
			chars += finalChunk.length;
			for (let index = 0; index < finalChunk.length; index++) {
				if (finalChunk.charCodeAt(index) === 10) lines++;
			}
			if (chars > maxChars) {
				throw new PipelineRuleError(
					`Pipeline capture ${capture.alias} exceeds ${maxChars} characters`,
				);
			}
			if (lines > maxLines) {
				throw new PipelineRuleError(`Pipeline capture ${capture.alias} exceeds ${maxLines} lines`);
			}
			chunks.push(finalChunk);
		}
		assertReadDeadline(limits.deadlineAt);
		return { text: chunks.join(""), bytes, chars, lines };
	} finally {
		await handle.close();
	}
}

export async function readCaptureText(capture: PipelineCapture): Promise<string> {
	return (await readCaptureTextBounded(capture)).text;
}

export function isPipelineControlTool(toolName: string): boolean {
	return (
		toolName === "StartPipeline" || toolName === "ExtractPipeline" || toolName === "EndPipeline"
	);
}
