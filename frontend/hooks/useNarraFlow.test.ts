import { describe, expect, test } from "bun:test";
import type { ProjectGraphResponse } from "../lib/api/projects";
import { type GraphRuntimeStatus, summarizeGraphRuntimeState } from "./useNarraFlow";

describe("summarizeGraphRuntimeState", () => {
	test("defaults to a healthy graph runtime when metadata is absent", () => {
		const result = summarizeGraphRuntimeState(undefined);

		expect(result).toEqual<GraphRuntimeStatus>({
			degraded: false,
			fallbackMessages: [],
		});
	});

	test("surfaces fallback diagnostics with reason and error detail", () => {
		const graph: ProjectGraphResponse = {
			nodes: [],
			edges: [],
			degraded: false,
			fallbacks: [
				{
					feature: "graph.gitMetadata",
					reason: "git_metadata_refresh_failed",
					error: "writeback failed",
				},
			],
		};

		expect(summarizeGraphRuntimeState(graph)).toEqual<GraphRuntimeStatus>({
			degraded: true,
			fallbackMessages: ["graph.gitMetadata: git_metadata_refresh_failed — writeback failed"],
		});
	});

	test("surfaces message-only fallback diagnostics", () => {
		const graph: ProjectGraphResponse = {
			nodes: [],
			edges: [],
			fallbacks: [{ feature: "graph.commitSync", message: "commit sync refresh failed" }],
		};

		expect(summarizeGraphRuntimeState(graph)).toMatchObject({
			degraded: true,
			fallbackMessages: ["graph.commitSync: commit sync refresh failed"],
		} satisfies Partial<GraphRuntimeStatus>);
	});
});
