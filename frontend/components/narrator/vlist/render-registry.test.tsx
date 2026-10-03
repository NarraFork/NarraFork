import { describe, expect, it } from "bun:test";
import { isValidElement } from "react";
import { FileReferenceScopeProvider } from "../composer/FileReferenceScope";
import type { MeasuredElement } from "./prepared-block";
import { VLIST_ELEMENT_KINDS, type VListElementKind } from "./registry";
import { RenderMarkdown } from "./render/RenderMarkdown";
import { RenderMessageBubble } from "./render/RenderMessageBubble";
import { RenderToolRun, RenderTraceCountLine } from "./render/RenderToolRun";
import { type RenderExtra, renderElement } from "./render-registry";

// A minimal MeasuredElement stub — renderElement only forwards it as a prop, so
// element-type routing can be asserted without running the component bodies.
const STUB: MeasuredElement = {
	height: 10,
	blocks: [],
	frame: { blocks: [], contentHeight: 10, usedWidth: 0 },
	contentWidth: 100,
	usedWidth: 0,
};

/** Read the component function a rendered element routes to. */
function unwrapScope(node: React.ReactNode): React.ReactNode {
	return isValidElement<{ children: React.ReactNode }>(node) &&
		node.type === FileReferenceScopeProvider
		? node.props.children
		: node;
}

function elementType(node: React.ReactNode): unknown {
	const content = unwrapScope(node);
	return isValidElement(content) ? content.type : null;
}

describe("render-registry dispatch", () => {
	it("keeps read-only ExactRow text disclosure live and rebinds callbacks by spec key", async () => {
		const { parseHTML } = await import("linkedom");
		const { act } = await import("react");
		const { createRoot } = await import("react-dom/client");
		const { MantineProvider } = await import("@mantine/core");
		const { installCanvasStub } = await import("./measure/test-canvas-stub");
		installCanvasStub();
		const { window: win } = parseHTML("<!doctype html><html><body></body></html>");
		Object.assign(globalThis, {
			window: win,
			document: win.document,
			navigator: win.navigator,
			HTMLElement: win.HTMLElement,
			Element: win.Element,
			Node: win.Node,
			IS_REACT_ACT_ENVIRONMENT: true,
		});
		const { ExactRow } = await import("./ExactRow");
		const { measureInjectionBubble } = await import("./measure/measure-injection-bubble");
		const markdown = "line of full content\n\n".repeat(500);
		const measured = measureInjectionBubble({ markdown }, 400, 5);
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		const calls: string[] = [];
		let bubbled = 0;

		const labels = { textPreview: { expand: "展开内容", collapse: "收起正文" } };
		const tree = (key: string) => (
			<MantineProvider>
				<fieldset
					onKeyDown={() => {}}
					onClick={() => {
						bubbled++;
					}}
				>
					<ExactRow
						item={{ spec: { kind: "injection-bubble", key, data: { markdown } }, measured }}
						top={0}
						height={measured.height}
						hitHeight={measured.height}
						contentWidth={400}
						itemId={undefined}
						sourceIds={[]}
						interactionSig="read-only"
						toggles={{
							onToggle: () => {},
							onToggleItems: () => {},
							onToggleEarlier: () => {},
							onToggleRow: () => {},
							onToggleTranslation: () => {},
							onTogglePrompt: () => {},
							onToggleFileChanges: () => {},
							onToggleTextExpanded: () => calls.push(key),
						}}
						renderLabels={labels as never}
						narratorId="public-share"
					/>
				</fieldset>
			</MantineProvider>
		);
		try {
			await act(async () => {
				root.render(tree("first"));
			});
			expect(host.querySelector("[data-block-id]")).toBeNull();
			const first = host.querySelector("[data-vlist-text-preview-toggle]");
			if (!first) throw new Error("Missing read-only text preview toggle");
			expect(first.textContent).toBe("展开内容");
			await act(async () => {
				first.dispatchEvent(new win.Event("click", { bubbles: true }));
			});
			await act(async () => {
				root.render(tree("second"));
			});
			await act(async () => {
				host
					.querySelector("[data-vlist-text-preview-toggle]")
					?.dispatchEvent(new win.Event("click", { bubbles: true }));
			});
			expect(calls).toEqual(["first", "second"]);
			expect(bubbled).toBe(0);
		} finally {
			await act(async () => {
				root.unmount();
			});
			host.remove();
		}
	});

	it.each([
		"injection-bubble",
		"communication-bubble",
		"reasoning",
		"reasoning-steps",
		"activity-trace",
	] as const)("forwards reader-only text preview controls to %s", (kind) => {
		const labels = { expand: "展开内容", collapse: "收起正文" };
		const toggle = (_bodyKey?: string) => {};
		const node = unwrapScope(
			renderElement(kind, STUB, { textPreviewLabels: labels, onToggleTextExpanded: toggle }),
		);
		expect(isValidElement(node)).toBe(true);
		const props = (node as React.ReactElement<Record<string, unknown>>).props;
		expect(props.textPreviewLabels).toBe(labels);
		expect(props.onToggleTextExpanded).toBe(toggle);
	});

	it("returns a valid React element for every registered kind", () => {
		for (const kind of VLIST_ELEMENT_KINDS) {
			const extra: RenderExtra = kindExtra(kind);
			const node = renderElement(kind, STUB, extra);
			expect(isValidElement(node)).toBe(true);
		}
	});

	it("routes representative kinds to the correct render component", () => {
		expect(elementType(renderElement("markdown", STUB))).toBe(RenderMarkdown);
		expect(elementType(renderElement("message-bubble", STUB, { role: "user" }))).toBe(
			RenderMessageBubble,
		);
		// Several trace kinds share RenderToolRun / RenderTraceCountLine.
		expect(elementType(renderElement("activity-trace", STUB))).toBe(RenderToolRun);
		expect(elementType(renderElement("reasoning-steps", STUB))).toBe(RenderToolRun);
		expect(elementType(renderElement("tool-run-count", STUB))).toBe(RenderTraceCountLine);
		expect(elementType(renderElement("reasoning-count", STUB))).toBe(RenderTraceCountLine);
	});

	it("passes the message-bubble role through to props", () => {
		const node = renderElement("message-bubble", STUB, { role: "user" });
		const props = isValidElement(node) ? (node as React.ReactElement).props : {};
		expect((props as { role: string }).role).toBe("user");
	});

	it("defaults message-bubble role to assistant when unspecified", () => {
		const node = renderElement("message-bubble", STUB);
		const props = isValidElement(node) ? (node as React.ReactElement).props : {};
		expect((props as { role: string }).role).toBe("assistant");
	});

	it("resolveRenderExtra derives web-search isSearching from status", async () => {
		const { resolveRenderExtra } = await import("./render-registry");
		// completed → not searching; anything else → searching (else a running
		// search renders as done — the render-path cast risk this closes).
		expect(
			(
				resolveRenderExtra({ kind: "web-search", data: { status: "completed" } }) as {
					isSearching: boolean;
				}
			).isSearching,
		).toBe(false);
		expect(
			(
				resolveRenderExtra({ kind: "web-search", data: { status: "searching" } }) as {
					isSearching: boolean;
				}
			).isSearching,
		).toBe(true);
		expect(
			(resolveRenderExtra({ kind: "web-search", data: {} }) as { isSearching: boolean })
				.isSearching,
		).toBe(false);
	});

	it("resolveRenderExtra passes message-bubble role and subagent description", async () => {
		const { resolveRenderExtra } = await import("./render-registry");
		expect(
			(resolveRenderExtra({ kind: "message-bubble", data: { role: "user" } }) as { role: string })
				.role,
		).toBe("user");
		expect(
			(
				resolveRenderExtra({ kind: "subagent-card", data: { description: "d" } }) as {
					description: string;
				}
			).description,
		).toBe("d");
	});

	it("forwards the subagent model + reasoning-effort badges to render props", async () => {
		const { resolveRenderExtra } = await import("./render-registry");
		const extra = resolveRenderExtra({
			kind: "subagent-card",
			data: { description: "d", model: "sonnet", reasoningEffort: "high" },
		}) as { model: string; reasoningEffort: string };
		expect(extra.model).toBe("sonnet");
		expect(extra.reasoningEffort).toBe("high");
		const node = renderElement("subagent-card", STUB, extra);
		const props = isValidElement(node) ? (node as React.ReactElement).props : {};
		expect((props as { reasoningEffort?: string }).reasoningEffort).toBe("high");
	});

	it("resolveRenderExtra forwards message-bubble header data (creator/createdAt/hasHeader)", async () => {
		const { resolveRenderExtra } = await import("./render-registry");
		const creator = { id: "u1", username: "alice", avatarColor: "#f00", avatarImageId: null };
		const createdAt = "2026-01-01T12:34:00.000Z";
		const extra = resolveRenderExtra({
			kind: "message-bubble",
			data: { role: "user", hasHeader: true, creator, createdAt },
		}) as {
			role: string;
			hasHeader: boolean;
			creator: typeof creator;
			createdAt: string;
		};
		expect(extra.role).toBe("user");
		expect(extra.hasHeader).toBe(true);
		expect(extra.creator).toEqual(creator);
		expect(extra.createdAt).toBe(createdAt);
	});

	it("resolveRenderExtra forwards interaction callbacks from measured specs", async () => {
		const { resolveRenderExtra } = await import("./render-registry");
		const onToggle = () => {};
		const onToggleItems = () => {};
		const onToggleEarlier = () => {};
		const onToggleRow = (_index: number) => {};
		const onToggleTranslation = () => {};
		const extra = resolveRenderExtra({
			kind: "activity-trace",
			data: { items: [] },
			opts: { onToggle, onToggleItems, onToggleEarlier, onToggleRow, onToggleTranslation },
		});
		expect(extra.onToggle).toBe(onToggle);
		expect(extra.onToggleItems).toBe(onToggleItems);
		expect(extra.onToggleEarlier).toBe(onToggleEarlier);
		expect(extra.onToggleRow).toBe(onToggleRow);
		expect(extra.onToggleTranslation).toBe(onToggleTranslation);
	});

	it("forwards the drill-down card slot from `extra`, never from spec.opts", async () => {
		const { renderElement, resolveRenderExtra } = await import("./render-registry");
		const rowCard = () => null;
		// The slot is a React factory: it must NOT travel through spec.opts, which is
		// digested into the measure cache key (it would land in the `?function`
		// fallback and blur the key's meaning). The shell assigns it on `extra`.
		const extra = resolveRenderExtra({
			kind: "activity-trace",
			data: { items: [] },
			opts: { rowCard },
		});
		expect(extra.rowCard).toBeUndefined();
		const node = renderElement("activity-trace", STUB, { rowCard });
		const props = isValidElement(node) ? (node as React.ReactElement).props : {};
		expect((props as { rowCard?: unknown }).rowCard).toBe(rowCard);
	});

	it("hands reasoning its language toggle (the inert show-original button)", () => {
		// The dispatch used to drop onToggleTranslation, so RenderReasoning drew the
		// "show original" row with no handler: a control that looked live and did
		// nothing. Asserted on the forwarded prop, which is the exact hole.
		const onToggleTranslation = () => {};
		const node = renderElement("reasoning", STUB, { onToggleTranslation });
		const props = isValidElement(node) ? (node as React.ReactElement).props : {};
		expect((props as { onToggleTranslation?: () => void }).onToggleTranslation).toBe(
			onToggleTranslation,
		);
	});

	it("resolveRenderExtra forwards kind+data for system-text / ask-in-passing", async () => {
		const { resolveRenderExtra } = await import("./render-registry");
		const extra = resolveRenderExtra({
			kind: "system-text",
			data: { kind: "error", text: "boom" },
		}) as {
			kind: string;
			data: unknown;
		};
		expect(extra.kind).toBe("error");
		expect(extra.data).toEqual({ kind: "error", text: "boom" });
	});

	it("dispatch covers exactly the registry kinds (no missing case)", () => {
		// If a kind were missing from the switch, renderElement returns undefined
		// (not a valid element) — the first test would already fail; this asserts
		// symmetry with the measure registry explicitly.
		const rendered = VLIST_ELEMENT_KINDS.filter((k) =>
			isValidElement(renderElement(k, STUB, kindExtra(k))),
		);
		expect(rendered.length).toBe(VLIST_ELEMENT_KINDS.length);
	});

	it("forwards narratorId to tool-call / tool-call-group / media (image resolution)", () => {
		for (const kind of ["tool-call", "tool-call-group", "media"] as const) {
			const node = renderElement(kind, STUB, { narratorId: "nar_123" });
			const props = isValidElement(node) ? (node as React.ReactElement).props : {};
			expect((props as { narratorId?: string }).narratorId).toBe("nar_123");
		}
	});

	it("hands the tool card its timeout sender (else the editor is inert)", () => {
		// The `update_timeout` WS send lives outside vlist/, so a dropped forward would
		// render a timeout that looks editable and silently does nothing.
		const onUpdateTimeout = (_ms: number) => {};
		const node = renderElement("tool-call", STUB, { onUpdateTimeout });
		const props = isValidElement(node) ? (node as React.ReactElement).props : {};
		expect((props as { onUpdateTimeout?: (ms: number) => void }).onUpdateTimeout).toBe(
			onUpdateTimeout,
		);
	});

	it("hands the tool card its viewer wiring (the route to a truncated payload)", () => {
		// A truncated payload is now reached through the BODY, not through a notice
		// row: the viewer host requests the real bytes once the reader scrolls into
		// the body's later half (or opens it fullscreen). That makes `viewControls`
		// the load-bearing forward — dropping it leaves every prefix body stuck on
		// its preview with no route out, which is the hole this pins down.
		const viewControls = {
			isWrapped: () => true,
			isSourceShown: () => false,
			toggleWrap: () => {},
			toggleSource: () => {},
			openFullscreen: () => {},
			requestFullPayload: () => {},
		};
		const viewTargets = [
			{ id: "tool-tu_1:b0", slot: "b0", kind: "code" as const, text: "body", truncated: true },
		];
		const node = renderElement("tool-call", STUB, { viewTargets, viewControls });
		const props = isValidElement(node) ? (node as React.ReactElement).props : {};
		expect((props as { viewControls?: unknown }).viewControls).toBe(viewControls);
		expect((props as { viewTargets?: unknown }).viewTargets).toBe(viewTargets);
	});

	it("hands plain content rows their source toggle (else 'view source' is inert)", () => {
		// The dispatch used to drop these, so a markdown / reasoning row's action bar
		// flipped shell state that no renderer read: the button lit up and the text on
		// screen never changed. Asserted on the forwarded props, which is the hole.
		for (const kind of ["markdown", "reasoning"] as const) {
			const node = unwrapScope(
				renderElement(kind, STUB, { showSource: true, sourceText: "# raw" }),
			);
			const props = isValidElement(node) ? (node as React.ReactElement).props : {};
			expect((props as { showSource?: boolean }).showSource).toBe(true);
			expect((props as { sourceText?: string }).sourceText).toBe("# raw");
		}
	});

	it("hands the card + subagent bodies their fullscreen-viewer wiring", () => {
		// Same dispatch hole: without these forwards every body inside a tool or
		// subagent card lost its hover action bar (copy / wrap / source / fullscreen),
		// leaving the reader with a 200px scroll window and no way out.
		const viewTargets = [{ id: "k:b0", slot: "b0", kind: "code" as const, text: "x" }];
		const viewControls = {
			isWrapped: () => true,
			isSourceShown: () => false,
			toggleWrap: () => {},
			toggleSource: () => {},
			openFullscreen: () => {},
		};
		for (const kind of ["tool-call", "subagent-card"] as const) {
			const node = renderElement(kind, STUB, { description: "d", viewTargets, viewControls });
			const props = isValidElement(node) ? (node as React.ReactElement).props : {};
			expect((props as { viewTargets?: unknown }).viewTargets).toBe(viewTargets);
			expect((props as { viewControls?: unknown }).viewControls).toBe(viewControls);
		}
	});

	it("hands the grouped header its timing labels (aggregate duration tooltip)", () => {
		const timingLabels = { title: "T" };
		const node = renderElement("tool-call-group", STUB, { timingLabels });
		const props = isValidElement(node) ? (node as React.ReactElement).props : {};
		expect((props as { timingLabels?: unknown }).timingLabels).toBe(timingLabels);
	});

	it("routes the subagent card its labels bundle (which carries the timing strings)", () => {
		// The card's own timing values ride the MEASURED element; only the wording
		// needs the bundle, so a dropped `labels` forward would leave the header and
		// its recent rows showing English while the rest of the card is translated.
		const labels = { recentCalls: "近期调用", timing: { title: "时间线" } };
		const node = renderElement("subagent-card", STUB, { description: "d", labels });
		const props = isValidElement(node) ? (node as React.ReactElement).props : {};
		expect((props as { labels?: unknown }).labels).toBe(labels);
	});

	it("resolveRenderExtra derives media `generating` from status (measure parity)", async () => {
		const { resolveRenderExtra } = await import("./render-registry");
		const generating = (data: Record<string, unknown>) =>
			(resolveRenderExtra({ kind: "media", data }) as { generating?: boolean }).generating;
		// measure-media reserves the header loader slot for any non-completed status,
		// so the render flag must be derived identically or the loader is never drawn.
		expect(generating({ status: "generating" })).toBe(true);
		expect(generating({ status: "in_progress" })).toBe(true);
		expect(generating({ status: "completed" })).toBe(false);
		// A persisted block carries no status — it is done, not generating.
		expect(generating({})).toBe(false);
	});
});

/** Provide the minimal extra props a few kinds need to render an element. */
function kindExtra(kind: VListElementKind): RenderExtra {
	switch (kind) {
		case "message-bubble":
			return { role: "assistant" };
		case "ask-in-passing":
			return { kind: "pending" };
		case "subagent-card":
			return { description: "desc" };
		case "system-text":
			return { kind: "info", data: { text: "" } };
		default:
			return {};
	}
}
