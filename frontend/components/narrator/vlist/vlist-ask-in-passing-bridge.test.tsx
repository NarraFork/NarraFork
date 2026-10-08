import { afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import type { TreeMessage } from "@frontend/lib/api/types";
import { publishAskInPassingEvent } from "@frontend/lib/ask-in-passing-events";
import { parseHTML } from "linkedom";
import { act, StrictMode, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
	UseVListAskInPassingArgs,
	VListAskInPassingActions,
} from "./vlist-ask-in-passing-bridge";

// Module mocks and DOM globals live only in a subprocess, never the shared test runner.
if (process.env.NF_AIP_BRIDGE_TEST_CHILD !== "1") {
	it("runs the real bridge hook lifecycle suite in isolation", async () => {
		const child = Bun.spawn([process.execPath, "test", import.meta.path], {
			env: { ...process.env, NARRAFORK_HOME: undefined, NF_AIP_BRIDGE_TEST_CHILD: "1" },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect({ code, output: code ? stdout + stderr : "" }).toEqual({ code: 0, output: "" });
	}, 20000);
} else {
	let useBridge: typeof import("./vlist-ask-in-passing-bridge").useVListAskInPassing;
	const open = mock((_id: string) => {});
	const notify = mock(() => {});
	let finish: (value: { id: string }) => void;
	let reject: (error: Error) => void;
	const resolve = mock(
		(_input: { narratorId: string; pendingMessageId: string; question: string }) =>
			new Promise<{ id: string }>((yes, no) => {
				finish = yes;
				reject = no;
			}),
	);
	const cancel = mock(
		() =>
			new Promise<{ id: string }>((yes, no) => {
				finish = yes;
				reject = no;
			}),
	);
	let root: Root | undefined;
	let container: HTMLElement;
	let actions: VListAskInPassingActions;
	let focusCount = 0;
	const initial = (): UseVListAskInPassingArgs => ({
		narratorId: "n1",
		messages: [],
		sourceIdsByKey: new Map([["row", ["m"]]]),
		renderItems: [
			{ spec: { key: "row", kind: "ask-in-passing", data: { kind: "pending" } } },
		] as unknown as UseVListAskInPassingArgs["renderItems"],
	});
	function Row() {
		const pending = actions.pendingByKey.get("row");
		useEffect(() => {
			if (pending?.focusRequest && pending.onFocusConsumed?.(pending.focusRequest)) focusCount++;
		}, [pending]);
		return null;
	}
	function Harness({ args, row = false }: { args: UseVListAskInPassingArgs; row?: boolean }) {
		actions = useBridge(args);
		return row ? <Row /> : null;
	}
	async function render(args: UseVListAskInPassingArgs, row = false) {
		if (!root) {
			container = document.createElement("div");
			document.body.append(container);
			root = createRoot(container);
		}
		await act(async () =>
			root?.render(
				<StrictMode>
					<Harness args={args} row={row} />
				</StrictMode>,
			),
		);
	}
	const pending = () => {
		const value = actions.pendingByKey.get("row");
		if (!value) throw new Error("missing pending row");
		return value;
	};
	beforeAll(async () => {
		const { window } = parseHTML("<html><body></body></html>");
		Object.assign(globalThis, {
			window,
			document: window.document,
			navigator: window.navigator,
			HTMLElement: window.HTMLElement,
			IS_REACT_ACT_ENVIRONMENT: true,
		});
		mock.module("@frontend/hooks/useNarrator", () => ({
			useAskInPassing: () => ({ mutateAsync: resolve }),
			useCancelAskInPassing: () => ({ mutateAsync: cancel }),
		}));
		mock.module("@mantine/notifications", () => ({ notifications: { show: notify } }));
		mock.module("../question/AskInPassingCard", () => ({
			useOpenAskInPassingNarrator: () => open,
		}));
		useBridge = (await import("./vlist-ask-in-passing-bridge")).useVListAskInPassing;
	});
	afterEach(async () => {
		await act(async () => root?.unmount());
		root = undefined;
		container?.remove();
		open.mockClear();
		notify.mockClear();
		resolve.mockClear();
		cancel.mockClear();
		focusCount = 0;
	});
	const eventMessage = (): TreeMessage => ({
		id: "m",
		narratorId: "n1",
		parentToolUseId: null,
		role: "system",
		contentJson: [],
		contentText: null,
		toolCalls: [],
		createdAt: "2026-01-01",
		children: [],
	});
	describe("list-owned ask-in-passing bridge", () => {
		it("real start events request focus once across duplicate acknowledgements and StrictMode", async () => {
			const args = initial();
			await render(args);
			const event = {
				kind: "start",
				narratorId: "n1",
				message: eventMessage(),
				focus: true,
			} as const;
			await act(async () => publishAskInPassingEvent(event));
			await render(args, true);
			expect(focusCount).toBe(1);
			await act(async () => publishAskInPassingEvent(event));
			await render(args, false);
			await render(args, true);
			expect(focusCount).toBe(1);
		});
		for (const kind of ["resolved", "deleted"] as const) {
			it(`real ${kind} events clear drafts and tombstone retained row callbacks`, async () => {
				const args = initial();
				await render(args);
				await act(async () => pending().onChange("question"));
				const stale = pending();
				await render({ ...args, renderItems: [], messages: [] });
				await act(async () =>
					publishAskInPassingEvent(
						kind === "resolved"
							? { kind, narratorId: "n1", message: eventMessage() }
							: { kind, narratorId: "n1", messageId: "m" },
					),
				);
				await act(async () => {
					stale.onChange("revive");
					stale.onConfirm();
					stale.onCancel();
				});
				await render(args);
				expect(pending().value).toBe("");
				expect(resolve).toHaveBeenCalledTimes(0);
				expect(cancel).toHaveBeenCalledTimes(0);
			});
		}
		it("real events are scoped to the current narrator after switching", async () => {
			const args = initial();
			await render(args);
			await render({ ...args, narratorId: "n2" });
			await act(async () => pending().onChange("new narrator"));
			await act(async () => {
				publishAskInPassingEvent({
					kind: "start",
					narratorId: "n1",
					message: eventMessage(),
					focus: true,
				});
				publishAskInPassingEvent({ kind: "resolved", narratorId: "n1", message: eventMessage() });
				publishAskInPassingEvent({ kind: "deleted", narratorId: "n1", messageId: "m" });
			});
			expect(pending().value).toBe("new narrator");
			expect(pending().focusRequest).toBeNull();
		});
		it("real resolution before HTTP completion still opens the answer with no row mounted", async () => {
			const args = initial();
			await render(args);
			await act(async () => pending().onChange("question"));
			await act(async () => pending().onConfirm());
			await render({ ...args, renderItems: [], messages: [] });
			await act(async () =>
				publishAskInPassingEvent({ kind: "resolved", narratorId: "n1", message: eventMessage() }),
			);
			await act(async () => finish({ id: "answer" }));
			expect(open).toHaveBeenCalledTimes(1);
			expect(open).toHaveBeenCalledWith("answer");
			await render(args);
			expect(pending().value).toBe("");
		});
		it("preserves draft while the rendered row and source window disappear", async () => {
			const args = initial();
			await render(args);
			await act(async () => pending().onChange("keep me"));
			await render({ ...args, renderItems: [], messages: [] });
			await render(args);
			expect(pending().value).toBe("keep me");
		});
		it("claims submission synchronously and restores draft after failure", async () => {
			await render(initial());
			await act(async () => pending().onChange(" draft "));
			await act(async () => {
				const p = pending();
				p.onConfirm();
				p.onConfirm();
				p.onCancel();
			});
			expect(resolve).toHaveBeenCalledTimes(1);
			expect(cancel).toHaveBeenCalledTimes(0);
			expect(resolve.mock.calls[0]).toEqual([
				{ narratorId: "n1", pendingMessageId: "m", question: "draft" },
			]);
			await act(async () => reject(new Error("offline")));
			expect(pending().value).toBe(" draft ");
			expect(pending().busy).toBe(false);
			expect(notify).toHaveBeenCalledTimes(1);
		});
		it("claims cancellation synchronously and retains its draft on failure", async () => {
			await render(initial());
			await act(async () => pending().onChange("draft"));
			await act(async () => {
				const p = pending();
				p.onCancel();
				p.onConfirm();
				p.onCancel();
			});
			expect(cancel).toHaveBeenCalledTimes(1);
			expect(resolve).toHaveBeenCalledTimes(0);
			await act(async () => reject(new Error("offline")));
			expect(pending().value).toBe("draft");
			expect(pending().busy).toBe(false);
		});
		it("opens the answer after canonical WS resolution removes the pending row before HTTP", async () => {
			const args = initial();
			await render(args);
			await act(async () => pending().onChange("question"));
			await act(async () => pending().onConfirm());
			await render({
				...args,
				renderItems: [],
				messages: [
					{
						id: "m",
						contentJson: [
							{ type: "ask_in_passing", status: "resolved", targetNarratorId: "answer" },
						],
					},
				],
			});
			await act(async () => finish({ id: "answer" }));
			expect(open).toHaveBeenCalledTimes(1);
			expect(open).toHaveBeenCalledWith("answer");
			await render(args);
			expect(pending().value).toBe("");
		});
		it("does not resurrect explicitly deleted drafts on late HTTP failure", async () => {
			await render(initial());
			await act(async () => pending().onChange("question"));
			await act(async () => pending().onConfirm());
			await act(async () => actions.forget("m"));
			await act(async () => reject(new Error("late failure")));
			expect(pending().value).toBe("");
			// The row is intentionally retained by this harness after canonical deletion;
			// production removes it immediately. A stale shell must stay inert.
			expect(pending().busy).toBe(true);
		});
		it("clears drafts on successful cancellation", async () => {
			await render(initial());
			await act(async () => pending().onChange("discard me"));
			await act(async () => pending().onCancel());
			await act(async () => finish({ id: "unused" }));
			expect(pending().value).toBe("");
			expect(pending().busy).toBe(true);
			expect(open).toHaveBeenCalledTimes(0);
		});
		it("does not open answers after the list itself unmounts", async () => {
			await render(initial());
			await act(async () => pending().onChange("question"));
			await act(async () => pending().onConfirm());
			await act(async () => root?.unmount());
			root = undefined;
			await act(async () => finish({ id: "answer" }));
			expect(open).toHaveBeenCalledTimes(0);
		});
		it("does not leak drafts or late navigation across narrator switches", async () => {
			const args = initial();
			await render(args);
			await act(async () => pending().onChange("old draft"));
			await act(async () => pending().onConfirm());
			await render({ ...args, narratorId: "n2" });
			expect(pending().value).toBe("");
			await act(async () => pending().onChange("new draft"));
			await act(async () => finish({ id: "old answer" }));
			expect(open).toHaveBeenCalledTimes(0);
			expect(pending().value).toBe("new draft");
		});
		it("consumes pending focus only once during StrictMode row effect replay", async () => {
			const args = initial();
			await render(args);
			await act(async () => actions.requestFocus("m"));
			await render(args, true);
			expect(focusCount).toBe(1);
			await render(args, false);
			await render(args, true);
			expect(focusCount).toBe(1);
		});
	});
}
