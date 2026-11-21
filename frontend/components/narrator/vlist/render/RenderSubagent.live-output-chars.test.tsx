/**
 * RenderSubagent.live-output-chars.test.tsx — the running subagent card's live
 * output counter badge.
 *
 * The server streams the child's reply length as a bare numeric `tool_output`
 * payload (the ContextAsk convention); the adapter surfaces it as
 * `liveOutputChars` and the card paints it on the fixed header badge row — so
 * it must appear only while the child is still working, and never move the
 * card's measured height.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
	replaceSubagentOutputCounts,
	retainSubagentOutputCounts,
	setSubagentOutputCount,
} from "../../subagent-output-count-store";
import { measureSubagentCard, type SubagentCardData } from "../measure/measure-subagent";
import { installCanvasStub } from "../measure/test-canvas-stub";
import { renderElement, resolveRenderExtra } from "../render-registry";
import { RenderSubagent } from "./RenderSubagent";

const disposeCanvasStub = installCanvasStub();
afterAll(() => disposeCanvasStub());

const WIDTH = 700;

function renderCard(opts: { isActive: boolean; liveOutputChars?: number }) {
	const data: SubagentCardData = {
		agentType: "explore",
		description: "explore the repo",
		...(opts.isActive ? {} : { isTerminal: true }),
	};
	const measured = measureSubagentCard(data, WIDTH, 5, { isActive: opts.isActive });
	const html = renderToStaticMarkup(
		<MantineProvider defaultColorScheme="dark">
			<RenderSubagent
				measured={measured}
				description={data.description}
				agentType={data.agentType}
				isActive={opts.isActive}
				status={opts.isActive ? "running" : "success"}
				liveOutputChars={opts.liveOutputChars}
			/>
		</MantineProvider>,
	);
	const { document } = parseHTML(`<!doctype html><html><body><div id="r">${html}</div></body>`);
	return document as unknown as Document;
}

describe("RenderSubagent live output counter badge", () => {
	it("updates a completed background Agent card by exact execution without remeasurement", async () => {
		const { window } = parseHTML("<!doctype html><html><body></body></html>");
		const globals = {
			window,
			document: window.document,
			navigator: window.navigator,
			HTMLElement: window.HTMLElement,
			Element: window.Element,
			Node: window.Node,
			IS_REACT_ACT_ENVIRONMENT: true,
			matchMedia: () => ({
				matches: false,
				addEventListener() {},
				removeEventListener() {},
				addListener() {},
				removeListener() {},
			}),
			requestAnimationFrame: () => 0,
			cancelAnimationFrame: () => {},
		};
		const previous = new Map(
			Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
		);
		for (const [key, value] of Object.entries(globals))
			Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
		const release = retainSubagentOutputCounts("count-owner");
		const data = {
			agentType: "explore",
			description: "background work",
			isBackground: true,
			toolUseId: "agent",
			toolCallId: "agent-pk",
			executionAttempt: 2,
		};
		const measured = measureSubagentCard(data, WIDTH, 5);
		const height = measured.height;
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		const value = {
			childNarratorId: "child",
			logicalRunId: "run",
			toolUseId: "agent",
			toolCallId: "agent-pk",
			attempt: 2,
			count: 0,
			active: true,
		};
		const badge = () => host.querySelector('[data-testid="subagent-output-chars"]');
		try {
			await act(async () =>
				root.render(
					<MantineProvider>
						{renderElement("subagent-card", measured, {
							...resolveRenderExtra({ kind: "subagent-card", data } as never),
							narratorId: "count-owner",
							isActive: false,
							status: "success",
						})}
					</MantineProvider>,
				),
			);
			expect(badge()).toBeNull();
			await act(async () => setSubagentOutputCount("count-owner", value));
			expect(badge()?.textContent).toBe("0 chars");
			await act(async () => setSubagentOutputCount("count-owner", { ...value, count: 1240 }));
			expect(badge()?.textContent).toBe("1240 chars");
			await act(async () =>
				setSubagentOutputCount("count-owner", { ...value, attempt: 1, count: 9999 }),
			);
			expect(badge()?.textContent).toBe("1240 chars");
			await act(async () => setSubagentOutputCount("count-owner", { ...value, count: 500 }));
			expect(badge()?.textContent).toBe("500 chars");
			await act(async () => replaceSubagentOutputCounts("count-owner", []));
			expect(badge()).toBeNull();
			expect(measured.height).toBe(height);
		} finally {
			await act(async () => root.unmount());
			release();
			for (const [key, descriptor] of previous) {
				if (descriptor) Object.defineProperty(globalThis, key, descriptor);
				else Reflect.deleteProperty(globalThis, key);
			}
		}
	});
	it("paints the count on the header badge row while the child is working", () => {
		const doc = renderCard({ isActive: true, liveOutputChars: 1240 });
		expect(doc.querySelector('[data-testid="subagent-output-chars"]')?.textContent).toBe(
			"1240 chars",
		);
	});

	it("is absent on a terminal card even with a stale count", () => {
		const doc = renderCard({ isActive: false, liveOutputChars: 1240 });
		expect(doc.querySelector('[data-testid="subagent-output-chars"]')).toBeNull();
	});

	it("is absent before the first delta arrives", () => {
		const doc = renderCard({ isActive: true });
		expect(doc.querySelector('[data-testid="subagent-output-chars"]')).toBeNull();
	});

	it("is height-neutral: the header row reserves the same height either way", () => {
		const withBadge = measureSubagentCard(
			{ agentType: "explore", description: "d", liveOutputChars: 1240 },
			WIDTH,
			5,
			{ isActive: true },
		);
		const without = measureSubagentCard({ agentType: "explore", description: "d" }, WIDTH, 5, {
			isActive: true,
		});
		expect(withBadge.height).toBe(without.height);
	});
});
