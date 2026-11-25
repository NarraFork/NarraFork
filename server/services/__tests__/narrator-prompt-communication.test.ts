import { beforeEach, expect, mock, test } from "bun:test";
import { contextChanges } from "@shared/prefix-context";

interface Target {
	id: string;
	title: string | null;
	handle: string | null;
	status: string;
}
let targets: Target[] = [];
let failure: Error | undefined;
const list = mock(async (_source: string, options?: { limit?: number; signal?: AbortSignal }) => {
	options?.signal?.throwIfAborted();
	if (failure) throw failure;
	return targets.slice(0, options?.limit);
});
mock.module("../narrator-communication", () => ({ listCommunicationTargets: list }));
const { buildEffectiveSystemPrompt } = await import("../narrator-prompt");
const options = {
	basePrompt: "Base",
	cwd: "/nonexistent/narrafork-communication-prompt-test",
	locale: "en" as const,
	communicationSourceNarratorId: "source-session",
};
function target(id: string, title = id): Target {
	return { id, title, handle: null, status: "idle" };
}
beforeEach(() => {
	list.mockClear();
	targets = [];
	failure = undefined;
});

test("every request rebuild replaces the communication part without changing the contract", async () => {
	const signal = new AbortController().signal;
	targets = [target("grandchild"), target("exact-peer")];
	const first = await buildEffectiveSystemPrompt({ ...options, communicationSignal: signal });
	targets = [target("new-peer")];
	const next = await buildEffectiveSystemPrompt({ ...options, communicationSignal: signal });
	expect(list).toHaveBeenCalledTimes(2);
	expect(list).toHaveBeenLastCalledWith("source-session", { limit: 51, signal });
	expect(next.contract).toBe(first.contract);
	expect(next.parts.find((part) => part.key === "communication")?.text).toContain(
		'"id":"new-peer"',
	);
	expect(next.prompt).not.toContain('"id":"exact-peer"');
	expect(next.prompt).not.toContain('"id":"grandchild"');
	const baseline = new Map(first.parts.map((part) => [part.key, part.text]));
	expect(contextChanges(baseline, next.parts).map((change) => change.key)).toEqual([
		"communication",
	]);
	expect(next.prompt).toContain("Peers are not transitive");
	expect(next.prompt).toContain("ContextAsk, Stop, TeamStatus");
});

test("read or ACL failure replaces rather than retains an earlier sensitive list", async () => {
	targets = [target("private-session", "Sensitive title")];
	const first = await buildEffectiveSystemPrompt(options);
	failure = new Error("ACL revoked");
	const next = await buildEffectiveSystemPrompt(options);
	expect(first.prompt).toContain("Sensitive title");
	expect(next.prompt).not.toContain("Sensitive title");
	expect(next.prompt).not.toContain("private-session");
	expect(next.prompt).toContain("Do not rely on an earlier snapshot");
	expect(next.keepParts ?? []).not.toContain("communication");
});

test("long lists are bounded, marked truncated, and keep stable full IDs", async () => {
	targets = Array.from({ length: 75 }, (_, index) => target(`stable-${index}`, "名".repeat(1000)));
	const built = await buildEffectiveSystemPrompt(options);
	const text = built.parts.find((part) => part.key === "communication")?.text ?? "";
	expect(list).toHaveBeenCalledWith("source-session", { limit: 51, signal: undefined });
	expect(text).toContain('"id":"stable-0"');
	expect(text).not.toContain('"id":"stable-50"');
	expect(text).not.toContain("名".repeat(161));
	expect(text).toContain("List truncated");
	expect(Buffer.byteLength(text)).toBeLessThan(26 * 1024);
});

test("a cancelled request cannot publish an unavailable snapshot instead of aborting", async () => {
	const controller = new AbortController();
	controller.abort(new Error("request cancelled"));
	await expect(
		buildEffectiveSystemPrompt({ ...options, communicationSignal: controller.signal }),
	).rejects.toThrow("request cancelled");
	expect(list).not.toHaveBeenCalled();
});

test("ordinary prompt-only callers do not read communication state without a source", async () => {
	const { communicationSourceNarratorId: _source, ...plain } = options;
	const built = await buildEffectiveSystemPrompt(plain);
	expect(list).not.toHaveBeenCalled();
	expect(built.parts.some((part) => part.key === "communication")).toBe(false);
});
