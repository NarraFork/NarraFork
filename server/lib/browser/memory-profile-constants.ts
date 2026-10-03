export const PROFILE_LIMITS = {
	startTimeoutMs: 10_000,
	stopTimeoutMs: 15_000,
	cleanupTimeoutMs: 5_000,
	defaultDurationMs: 30_000,
	minDurationMs: 1_000,
	maxDurationMs: 120_000,
	defaultSamplingIntervalBytes: 32_768,
	minSamplingIntervalBytes: 16_384,
	maxSamplingIntervalBytes: 1_048_576,
	stackDepth: 64,
	messageBytes: 16 * 1024 * 1024,
	allocationBytes: 16 * 1024 * 1024,
	traceBytes: 64 * 1024 * 1024,
	traceBufferKb: 8 * 1024,
	traceReadBytes: 64 * 1024,
	traceBufferUsageIntervalMs: 500,
	traceBufferStopRatio: 0.9,
	tempBytes: 144 * 1024 * 1024,
	warnings: 20,
	warningChars: 512,
	urlChars: 2048,
	functionChars: 256,
	pendingBytes: 8 * 1024 * 1024,
	summaryBytes: 32 * 1024,
	artifactBytes: 96 * 1024 * 1024,
	heapPoints: 122,
	heapIntervalMs: 1_000,
	allocationNodes: 50_000,
	allocationSamples: 100_000,
	traceEvents: 200_000,
	traceEventBytes: 256 * 1024,
	traceDepth: 64,
	gcSpans: 50_000,
} as const;

export class MemoryProfileError extends Error {
	constructor(public readonly stage: string) {
		super(`Memory profile failed (${stage})`);
		this.name = "MemoryProfileError";
	}
}
