/**
 * An EMPTY `agent.summaryModel` must never reach the model catalog.
 *
 * Regression: compact (and title generation) read `settings.agent.summaryModel`
 * raw and handed the empty string straight to the model catalog, which failed
 * deep inside query validation as an opaque "Invalid string at
 * ModelQuery.upstreamModelId" — logged 261 times in the field, and retried
 * because nothing recognized it as a configuration error. The fix makes the
 * summary wrappers refuse an empty model up front, with an error that is
 * classifiable (`isProviderUnavailableError`) so the picker prompt fires and no
 * retry/backoff is spent on it.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// Keep the publication singleton from bootstrapping DB state at import time.
const databaseAccess = mock(() => {
	throw new Error("Unexpected database access");
});
mock.module("../../../db", () => ({
	db: new Proxy({}, { get: databaseAccess }),
	sqlite: new Proxy({}, { get: databaseAccess }),
	activeDatabaseBackend: "sqlite",
	postgresRuntime: null,
	databaseMaintenance: new Proxy({}, { get: databaseAccess }),
	startupShutdownState: {},
	markDatabaseCleanShutdown: databaseAccess,
	releaseDatabaseInstanceLockOnly: databaseAccess,
	closePostgresRuntime: databaseAccess,
}));
mock.module("../../../services/agent-runtime/publication", () => ({
	runtimePublication: { setLegacyRuntimeAdmissionReader: () => {} },
	getRuntimePublicationService: databaseAccess,
	PUBLICATION_FALLBACK_BYTES: 65536,
	publicationEvent: databaseAccess,
	isRuntimePublicationUnavailableError: databaseAccess,
	publicationSummary: databaseAccess,
	createRuntimePublicationService: databaseAccess,
	createUnwiredPublicationFacade: databaseAccess,
	flushRuntimePublications: databaseAccess,
	setLegacyCompletionAdmissionReader: () => {},
	migrateLegacyTaskNotice: databaseAccess,
	setRuntimePublicationWake: () => {},
	taskPublicationRun: databaseAccess,
}));

let generateAttempts = 0;
const realProviderModule = { ...(await import("../provider")) };
mock.module("../provider", () => ({
	...realProviderModule,
	resolveProviderAndModel: () => ({
		provider: "anthropic",
		model: "claude-haiku",
		adapter: {
			generateWithMeta: async () => {
				generateAttempts++;
				return { text: "summary" };
			},
		},
	}),
}));

const { summaryGenerate, summaryGenerateWithHistory } = await import("../index");
const { settings } = await import("../../settings");
const { isProviderUnavailableError } = await import("../../provider-availability-error");

beforeEach(() => {
	generateAttempts = 0;
});

afterAll(() => {
	mock.module("../provider", () => realProviderModule);
	mock.restore();
});

/** Capture the error instead of letting it escape the assertion. */
async function capture(run: () => Promise<unknown>): Promise<unknown> {
	try {
		await run();
		return undefined;
	} catch (err) {
		return err;
	}
}

describe("empty summary model", () => {
	test("summaryGenerate fails fast with a classifiable error", async () => {
		settings.agent.summaryModel = "";

		const caught = await capture(() =>
			summaryGenerate("text", "system", undefined, undefined, undefined, undefined, undefined, false),
		);

		expect(caught).toBeInstanceOf(Error);
		const err = caught as Error;
		expect(err.name).toBe("SummaryModelNotConfiguredError");
		// The old failure mode leaked the empty id into the catalog.
		expect(err.message).not.toContain("upstreamModelId");
		// Classified as "cannot be served" — this is what broadcasts the picker
		// prompt AND keeps it off the transient-retry path.
		expect(isProviderUnavailableError(err)).toBe(true);
		// It never built a request.
		expect(generateAttempts).toBe(0);
	});

	test("summaryGenerateWithHistory fails fast the same way", async () => {
		settings.agent.summaryModel = "";

		const caught = await capture(() => summaryGenerateWithHistory("system", "content"));

		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).name).toBe("SummaryModelNotConfiguredError");
		expect(generateAttempts).toBe(0);
	});

	test("a caller-supplied model override still runs when the setting is empty", async () => {
		settings.agent.summaryModel = "";

		// Compact retries pass the model that was pinned when the attempt started,
		// so a retry must not be blocked by a setting that is now empty.
		const result = await summaryGenerate(
			"text",
			"system",
			undefined,
			undefined,
			undefined,
			"anthropic:claude-haiku",
			undefined,
			false,
		);

		expect(result.text).toBe("summary");
		expect(generateAttempts).toBe(1);
	});

	test("a configured summary model is unaffected", async () => {
		settings.agent.summaryModel = "anthropic:claude-haiku";

		const result = await summaryGenerate("text", "system", undefined, undefined, undefined, undefined, undefined, false);

		expect(result.text).toBe("summary");
		expect(generateAttempts).toBe(1);
	});
});
