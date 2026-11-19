import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { benchmarkSuites, narratorMessages, narrators } from "../../db/schema";
import { readDomainTask } from "../../db/worker-read";
import { createBenchmarkSuiteListStream } from "../benchmark-suite-stream";
import { getNarratorWorkerTestDb } from "./narrator-worker-fixture";

const fixture = getNarratorWorkerTestDb();
beforeAll(() => fixture.ready);
afterAll(() => fixture.close());

test("dedicated suite reads and streaming lists retain legal payloads above generic observations", async () => {
	const tasks = Array.from({ length: 30 }, (_, index) => ({
		id: `task-${index}`,
		name: `task-${index}`,
		prompt: `中文${"x".repeat(180_000)}`,
	}));
	fixture.db
		.insert(benchmarkSuites)
		.values({
			id: "large-suite",
			name: "large",
			tasksJson: tasks,
			createdAt: "2026-01-01T00:00:00.000Z",
		})
		.run();
	const forbidden = () => {
		throw new Error("Owning connection must not read benchmark bodies");
	};
	const prepare = spyOn(fixture.sqlite, "prepare").mockImplementation(forbidden);
	const query = spyOn(fixture.sqlite, "query").mockImplementation(forbidden);
	try {
		const suite = await readDomainTask(
			fixture.sqlite,
			"benchmarkSuiteSnapshot",
			{ suiteId: "large-suite", format: "raw" },
			{ executionPolicy: "worker-required" },
		);
		if (suite === null || typeof suite === "string")
			throw new Error("Expected raw benchmark suite");
		expect(JSON.parse(suite.tasksJson ?? "null")).toEqual(tasks);
		const stream = await createBenchmarkSuiteListStream(fixture.sqlite);
		const rows = (await new Response(stream).json()) as Array<{ id: string; tasksJson: unknown }>;
		expect(rows.map((row) => row.id)).toEqual(["large-suite"]);
		expect(rows[0].tasksJson).toEqual(tasks);
		expect(prepare).not.toHaveBeenCalled();
		expect(query).not.toHaveBeenCalled();
	} finally {
		prepare.mockRestore();
		query.mockRestore();
	}
});

test("metrics scan all current message metadata and load only the final assistant body", async () => {
	const narratorId = "benchmark-metrics-narrator";
	const createdAt = "2026-01-01T00:00:00.000Z";
	fixture.db
		.insert(narrators)
		.values({ id: narratorId, title: "metrics", createdAt, updatedAt: createdAt })
		.run();
	const historicalText = "h".repeat(5 * 1024 * 1024);
	fixture.db
		.insert(narratorMessages)
		.values({
			id: "metrics-a-assistant",
			narratorId,
			role: "assistant",
			contentJson: [
				{ type: "text", text: "historical" },
				{
					type: "tool_use",
					id: "historical-call",
					name: "Write",
					input: { file_path: "historical.txt", content: historicalText },
				},
			],
			contentText: "historical",
			tokensIn: 1,
			outputTokens: 3,
			reasoningTokens: 5,
			costUsd: 0.1,
			createdAt,
		})
		.run();
	for (let offset = 0; offset < 1001; offset += 200) {
		fixture.db
			.insert(narratorMessages)
			.values(
				Array.from({ length: Math.min(200, 1001 - offset) }, (_, index) => ({
					id: `metrics-m-user-${(offset + index).toString().padStart(4, "0")}`,
					narratorId,
					role: "user" as const,
					contentJson: [],
					contentText: "",
					tokensIn: 1,
					createdAt,
				})),
			)
			.run();
	}
	fixture.db
		.insert(narratorMessages)
		.values({
			id: "metrics-z-assistant",
			narratorId,
			role: "assistant",
			contentJson: [{ type: "text", text: "final answer" }],
			contentText: "final answer",
			tokensIn: 1,
			outputTokens: 7,
			reasoningTokens: 11,
			costUsd: 0.2,
			createdAt: "2026-01-02T00:00:00.000Z",
		})
		.run();
	const forbidden = () => {
		throw new Error("Metrics must not read message bodies on the owning connection");
	};
	const prepare = spyOn(fixture.sqlite, "prepare").mockImplementation(forbidden);
	const query = spyOn(fixture.sqlite, "query").mockImplementation(forbidden);
	try {
		expect(
			await readDomainTask(
				fixture.sqlite,
				"benchmarkMetricsSnapshot",
				{ narratorId },
				{ executionPolicy: "worker-required" },
			),
		).toEqual({
			tokensIn: 1003,
			tokensOut: 26,
			costUsd: 0.3,
			messageCount: 1003,
			toolCallCount: 0,
			lastAssistantText: "final answer",
		});
		expect(prepare).not.toHaveBeenCalled();
		expect(query).not.toHaveBeenCalled();
	} finally {
		prepare.mockRestore();
		query.mockRestore();
	}
});

test("consumer cancellation releases the suite snapshot instead of buffering the remaining list", async () => {
	fixture.db
		.insert(benchmarkSuites)
		.values({
			id: "cancel-suite",
			name: "cancel",
			tasksJson: [],
			createdAt: "2026-01-02T00:00:00.000Z",
		})
		.run();
	const stream = await createBenchmarkSuiteListStream(fixture.sqlite);
	const reader = stream.getReader();
	const first = await reader.read();
	expect(new TextDecoder().decode(first.value)).toBe("[");
	await reader.cancel();
	expect(
		await readDomainTask(
			fixture.sqlite,
			"benchmarkSuiteSnapshot",
			{ suiteId: "cancel-suite", format: "raw" },
			{ executionPolicy: "worker-required" },
		),
	).not.toBeNull();
});
