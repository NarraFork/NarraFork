import { count, inArray } from "drizzle-orm";
import { chapters, narratorMessages, narrators, projects } from "../../../server/db/schema";
import { getTestDb } from "../../setup";

type BenchFn = () => unknown | Promise<unknown>;
type BenchResult = {
	name: string;
	iterations: number;
	avgMs: number;
	minMs: number;
	maxMs: number;
};

type NarratorStatus = "idle" | "working" | "waiting" | "archived";

const NOW = "2025-01-01T00:00:00.000Z";
const SEARCH_LIMIT = envInt("NARRAFORK_BENCH_SEARCH_LIMIT", 50);
const ITERATIONS = envInt("NARRAFORK_BENCH_ITERATIONS", 20);
const NARRATOR_COUNT = envInt("NARRAFORK_BENCH_NARRATORS", 10_000);
const MESSAGE_COUNT = envInt("NARRAFORK_BENCH_MESSAGES", 5_000);
const MESSAGE_SIZE = envInt("NARRAFORK_BENCH_MESSAGE_SIZE", 4_000);

function envInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const value = Number.parseInt(raw, 10);
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

function chunk<T>(items: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		chunks.push(items.slice(i, i + size));
	}
	return chunks;
}

function formatMs(ms: number): string {
	return ms.toFixed(3);
}

async function bench(name: string, iterations: number, fn: BenchFn): Promise<BenchResult> {
	await fn();
	const times: number[] = [];
	for (let i = 0; i < iterations; i++) {
		const start = performance.now();
		await fn();
		times.push(performance.now() - start);
	}
	const total = times.reduce((sum, value) => sum + value, 0);
	return {
		name,
		iterations,
		avgMs: total / times.length,
		minMs: Math.min(...times),
		maxMs: Math.max(...times),
	};
}

function printResults(results: BenchResult[]) {
	const rows = results.map((result) => ({
		name: result.name,
		iterations: result.iterations,
		avgMs: formatMs(result.avgMs),
		minMs: formatMs(result.minMs),
		maxMs: formatMs(result.maxMs),
	}));
	console.table(rows);
}

function seedNarrators(db: ReturnType<typeof getTestDb>["db"]) {
	const statuses: NarratorStatus[] = ["working", "waiting", "idle", "archived"];
	const rows = Array.from({ length: NARRATOR_COUNT }, (_, index) => ({
		id: `bench-narrator-${index}`,
		status: statuses[index % statuses.length],
		type: "primary" as const,
		variant: "primary" as const,
		inheritMode: "fresh" as const,
		createdAt: NOW,
		updatedAt: NOW,
	}));
	for (const rowsChunk of chunk(rows, 500)) {
		db.insert(narrators).values(rowsChunk).run();
	}
}

function seedMessages(db: ReturnType<typeof getTestDb>["db"]) {
	db.insert(projects)
		.values({
			id: "bench-project",
			name: "Bench",
			gitPath: "/tmp/bench",
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
	db.insert(chapters)
		.values({
			id: "bench-chapter",
			projectId: "bench-project",
			title: "Bench Chapter",
			branch: "chapter/bench",
			baseBranch: "main",
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
	db.insert(narrators)
		.values({
			id: "bench-search-narrator",
			chapterId: "bench-chapter",
			status: "idle",
			type: "primary",
			variant: "primary",
			title: "Bench Search Narrator",
			inheritMode: "fresh",
			model: "bench-model",
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();

	const filler = "x".repeat(Math.max(0, MESSAGE_SIZE - 64));
	const rows = Array.from({ length: MESSAGE_COUNT }, (_, index) => ({
		id: `bench-message-${index}`,
		narratorId: "bench-search-narrator",
		role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
		contentJson: [{ type: "text", text: `needle benchmark message ${index}` }],
		contentText: `needle benchmark message ${index} ${filler}`,
		createdAt: NOW,
	}));
	for (const rowsChunk of chunk(rows, 250)) {
		db.insert(narratorMessages).values(rowsChunk).run();
	}
}

async function main() {
	const { db, sqlite } = getTestDb();
	try {
		seedNarrators(db);
		seedMessages(db);

		const legacyDiagnosticsCount = async () => {
			const rows = await db.query.narrators.findMany({
				where: inArray(narrators.status, ["working", "waiting"]),
				columns: { status: true },
			});
			const working = rows.filter((row) => row.status === "working").length;
			const waiting = rows.length - working;
			return { working, waiting };
		};
		const groupedDiagnosticsCount = async () => {
			const rows = await db
				.select({ status: narrators.status, value: count() })
				.from(narrators)
				.where(inArray(narrators.status, ["working", "waiting"]))
				.groupBy(narrators.status);
			const byStatus = new Map(rows.map((row) => [row.status, row.value]));
			return {
				working: byStatus.get("working") ?? 0,
				waiting: byStatus.get("waiting") ?? 0,
			};
		};

		const legacyMessageSearch = sqlite.prepare(
			`SELECT m.id, m.narrator_id, m.content_text, m.role as message_role, m.created_at,
			  n.chapter_id, n.title as narrator_title, n.model,
			  c.title as chapter_title, p.name as project_name,
			  substr(m.content_text, 1, 240) as snippet
			 FROM narrator_messages m
			 JOIN narrators n ON n.id = m.narrator_id
			 LEFT JOIN chapters c ON c.id = n.chapter_id
			 LEFT JOIN projects p ON p.id = c.project_id
			 WHERE m.content_text LIKE ?
			 LIMIT ?`,
		);
		const previewMessageSearch = sqlite.prepare(
			`SELECT m.id, m.narrator_id, substr(m.content_text, 1, 240) as content_preview,
			  m.role as message_role, m.created_at,
			  n.chapter_id, n.title as narrator_title, n.model,
			  c.title as chapter_title, p.name as project_name,
			  substr(m.content_text, 1, 240) as snippet
			 FROM narrator_messages m
			 JOIN narrators n ON n.id = m.narrator_id
			 LEFT JOIN chapters c ON c.id = n.chapter_id
			 LEFT JOIN projects p ON p.id = c.project_id
			 WHERE m.content_text LIKE ?
			 LIMIT ?`,
		);
		const like = "%needle%";
		const legacySearch = () => {
			const rows = legacyMessageSearch.all(like, SEARCH_LIMIT) as Array<{
				snippet: string | null;
				content_text: string | null;
			}>;
			return rows.map((row) => row.snippet || row.content_text?.slice(0, 240) || "");
		};
		const previewSearch = () => {
			const rows = previewMessageSearch.all(like, SEARCH_LIMIT) as Array<{
				snippet: string | null;
				content_preview: string | null;
			}>;
			return rows.map((row) => row.snippet || row.content_preview || "");
		};
		console.log("Backend hot path micro-benchmark (in-memory SQLite)");
		console.log(
			JSON.stringify(
				{
					narrators: NARRATOR_COUNT,
					messages: MESSAGE_COUNT,
					messageSize: MESSAGE_SIZE,
					searchLimit: SEARCH_LIMIT,
					iterations: ITERATIONS,
				},
				null,
				2,
			),
		);
		printResults([
			await bench("diagnostics legacy row count", ITERATIONS, legacyDiagnosticsCount),
			await bench("diagnostics grouped count", ITERATIONS, groupedDiagnosticsCount),
			await bench("message search legacy content_text", ITERATIONS, legacySearch),
			await bench("message search content_preview", ITERATIONS, previewSearch),
		]);
	} finally {
		sqlite.close();
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
