import { afterEach, describe, expect, test } from "bun:test";
import {
	forgetModelTraceRequest,
	getModelTraceRequest,
	rememberModelTraceRequest,
} from "../modeltrace-request";
import type { ChatParams, ProviderAdapter } from "../provider";

const adapter = {} as ProviderAdapter;
const id = "modeltrace-request-test";
afterEach(() => forgetModelTraceRequest(id));

function request(): ChatParams {
	return {
		conversationId: "upstream-session",
		stickySessionKey: "parent-narrator",
		content: "parent input",
		model: "original-model",
		cwd: "/workspace",
		history: [{ role: "system", content: "exact system prefix" }],
		tools: [{ name: "Bash", description: "original tool definition" }],
		toolResults: [{ tool_use_id: "t1", content: "original tool output" }],
		images: [{ format: "png", base64: "original-image" }],
		reasoningEffort: "high",
		maxOutputTokens: 8192,
		serviceTier: "priority",
		metadata: { user_id: "parent-user" },
		signal: new AbortController().signal,
		onRequestStart: () => {},
		onInputCharacters: () => {},
		resetUpstreamSession: true,
	};
}

describe("ModelTrace frozen request prefix", () => {
	test("preserves upstream identity and original system, tool and input prefix", () => {
		const params = request();
		rememberModelTraceRequest(id, adapter, params);
		const snapshot = getModelTraceRequest(id);
		expect(snapshot?.adapter).toBe(adapter);
		expect(snapshot?.params).toMatchObject({
			conversationId: params.conversationId,
			stickySessionKey: params.stickySessionKey,
			content: params.content,
			history: params.history,
			tools: params.tools,
			toolResults: params.toolResults,
			images: params.images,
			model: params.model,
			metadata: params.metadata,
			reasoningEffort: "high",
			maxOutputTokens: 8192,
			serviceTier: "priority",
		});
	});

	test("later appended turns and tools do not extend the frozen prefix", () => {
		const params = request();
		rememberModelTraceRequest(id, adapter, params);
		params.history.push({ role: "assistant", content: "later answer" });
		params.tools.push({ name: "new tool" });
		params.toolResults.push({ content: "later result" });
		params.images?.push({ format: "png", base64: "later-image" });
		if (params.metadata) params.metadata.user_id = "changed-user";
		const snapshot = getModelTraceRequest(id);
		expect(snapshot?.params.history).toHaveLength(1);
		expect(snapshot?.params.tools).toHaveLength(1);
		expect(snapshot?.params.toolResults).toHaveLength(1);
		expect(snapshot?.params.images).toHaveLength(1);
		expect(snapshot?.params.metadata?.user_id).toBe("parent-user");
	});

	test("never inherits a parent signal, callback or request-dump collector", () => {
		const params = request();
		rememberModelTraceRequest(id, adapter, params);
		const snapshot = getModelTraceRequest(id);
		for (const key of [
			"signal",
			"onRequestStart",
			"onInputCharacters",
			"requestDump",
			"resetUpstreamSession",
		]) {
			expect(snapshot?.params).not.toHaveProperty(key);
		}
	});

	test("replaces the latest snapshot and can release retained history", () => {
		rememberModelTraceRequest(id, adapter, request());
		rememberModelTraceRequest(id, adapter, { ...request(), content: "latest input" });
		expect(getModelTraceRequest(id)?.params.content).toBe("latest input");
		forgetModelTraceRequest(id);
		expect(getModelTraceRequest(id)).toBeUndefined();
	});

	test("bounds retained request count and refreshes recently used keys", () => {
		try {
			for (let i = 0; i < 64; i++) rememberModelTraceRequest(`${id}-${i}`, adapter, request());
			rememberModelTraceRequest(`${id}-0`, adapter, request());
			rememberModelTraceRequest(id, adapter, request());
			expect(getModelTraceRequest(`${id}-0`)).toBeDefined();
			expect(getModelTraceRequest(`${id}-1`)).toBeUndefined();
		} finally {
			for (let i = 0; i < 64; i++) forgetModelTraceRequest(`${id}-${i}`);
		}
	});
});
