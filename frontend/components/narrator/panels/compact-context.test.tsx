import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act, createContext, useContext, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { NarratorPanelProps } from "../narrator-panel-types";
import {
	createResponsiveNarratorPanel,
	NarratorPanelCompactContext,
	useNarratorPanelCompact,
} from "./compact-context";

const SessionContext = createContext("initial");
let renders: Record<string, number>;
let latestBodyProps: Omit<NarratorPanelProps, "compact">;
let setDraft: (draft: string) => void;
let setOwnState: (state: number) => void;
let root: Root;
let host: HTMLElement;
const originals = new Map<string, PropertyDescriptor | undefined>();

function HeaderChrome() {
	renders.header++;
	return (
		<header>
			<NarratorPanelCompactContext.Consumer>
				{(compact) => {
					renders.icon++;
					return <span data-icon>{compact ? "external" : "back"}</span>;
				}}
			</NarratorPanelCompactContext.Consumer>
		</header>
	);
}

function StatusLeaf() {
	renders.status++;
	const compact = useNarratorPanelCompact();
	return <span data-status>{String(compact)}</span>;
}

function ComposerDraft() {
	renders.composer++;
	const [draft, updateDraft] = useState("");
	setDraft = updateDraft;
	return <textarea value={draft} readOnly />;
}

function ListProbe() {
	renders.list++;
	return <div data-list />;
}

function ClosedModalProbe() {
	renders.modal++;
	return null;
}

function BodyProbe(props: Omit<NarratorPanelProps, "compact">) {
	renders.body++;
	latestBodyProps = props;
	const session = useContext(SessionContext);
	const [ownState, updateOwnState] = useState(0);
	setOwnState = updateOwnState;
	return (
		<section data-session={session} data-own-state={ownState} data-narrator={props.narratorId}>
			<HeaderChrome />
			<ListProbe />
			<StatusLeaf />
			<ComposerDraft />
			<ClosedModalProbe />
		</section>
	);
}

// Exercise the production factory, instantiated once just like NarratorPanel.
const ResponsivePanel = createResponsiveNarratorPanel<NarratorPanelProps>(BodyProbe);

beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	host = document.body.appendChild(document.createElement("div"));
	root = createRoot(host);
	renders = { body: 0, header: 0, icon: 0, list: 0, status: 0, composer: 0, modal: 0 };
});

afterEach(async () => {
	await act(async () => root.unmount());
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	originals.clear();
});

async function render(props: Partial<NarratorPanelProps> = {}, session = "initial") {
	await act(async () => {
		root.render(
			<SessionContext.Provider value={session}>
				<ResponsivePanel narratorId="narrator" {...props} />
			</SessionContext.Provider>,
		);
	});
}

describe("responsive narrator compact boundary", () => {
	test("640 compact flips update only the icon/status leaves and preserve the composer draft", async () => {
		await render();
		expect(host.querySelector("[data-icon]")?.textContent).toBe("back");
		expect(host.querySelector("[data-status]")?.textContent).toBe("undefined");
		await act(async () => setDraft("unsent draft"));
		const textarea = host.querySelector("textarea");
		const counts = { ...renders };
		for (const compact of [true, false, true, false, undefined]) {
			await render({ compact });
			expect(host.querySelector("[data-icon]")?.textContent).toBe(compact ? "external" : "back");
			expect(host.querySelector("[data-status]")?.textContent).toBe(String(compact));
			expect(host.querySelector("textarea")).toBe(textarea);
			expect(textarea?.value).toBe("unsent draft");
			for (const key of ["body", "header", "list", "composer", "modal"]) {
				expect(renders[key]).toBe(counts[key]);
			}
			expect(Object.hasOwn(latestBodyProps, "compact")).toBe(false);
		}
		expect(renders.icon).toBe(counts.icon + 5);
		expect(renders.status).toBe(counts.status + 5);
	});

	test("same compact and shallow-equal body props do not render any subtree", async () => {
		await render({ compact: true });
		const counts = { ...renders };
		await render({ compact: true });
		expect(renders).toEqual(counts);
	});

	test("real narrator/flag/callback prop changes all reach the memo body without remounting", async () => {
		await render({ compact: false });
		await act(async () => setDraft("preserved"));
		const textarea = host.querySelector("textarea");
		let props: Partial<NarratorPanelProps> = { compact: false };
		const changes: Partial<NarratorPanelProps>[] = [
			{ narratorId: "other" },
			{
				narrator: {
					id: "other",
					model: "new",
					status: "running",
					totalCostUsd: 0,
					permissionMode: null,
				},
			},
			{ highlightRequestId: "next-highlight" },
			{ terminalOpen: true },
			{ onBack: () => {} },
			{ onForkFromMessage: () => {} },
			{ onToggleDetailsPanel: () => {} },
			{ onFileModPropsChange: () => {} },
		];
		for (const change of changes) {
			const count = renders.body;
			props = { ...props, ...change };
			await render(props);
			expect(renders.body).toBe(count + 1);
			for (const [key, value] of Object.entries(change)) {
				expect(Reflect.get(latestBodyProps, key)).toBe(value);
			}
			expect(host.querySelector("textarea")).toBe(textarea);
			expect(textarea?.value).toBe("preserved");
		}
		// Replacing an existing callback must not leave the old action captured.
		const nextBack = () => {};
		const count = renders.body;
		await render({ ...props, compact: true, onBack: nextBack });
		expect(renders.body).toBe(count + 1);
		expect(latestBodyProps.onBack).toBe(nextBack);
	});

	test("body-owned state and non-responsive contexts continue to render", async () => {
		await render({ compact: true });
		await act(async () => setOwnState(7));
		expect(renders.body).toBe(2);
		expect(host.querySelector("section")?.getAttribute("data-own-state")).toBe("7");
		await render({ compact: true }, "updated-session");
		expect(renders.body).toBe(3);
		expect(host.querySelector("section")?.getAttribute("data-session")).toBe("updated-session");
		expect(host.querySelector("section")?.getAttribute("data-own-state")).toBe("7");
		await render({ compact: false }, "updated-session");
		expect(renders.body).toBe(3);
	});

	test("no provider retains undefined and each panel owns its compact scope", async () => {
		await act(async () => {
			root.render(
				<>
					<div data-outside>
						<StatusLeaf />
					</div>
					<ResponsivePanel narratorId="compact" compact />
					<ResponsivePanel narratorId="default" />
				</>,
			);
		});
		expect(host.querySelector("[data-outside] [data-status]")?.textContent).toBe("undefined");
		expect(host.querySelector('[data-narrator="compact"] [data-status]')?.textContent).toBe("true");
		expect(host.querySelector('[data-narrator="default"] [data-status]')?.textContent).toBe(
			"undefined",
		);
	});

	test("production panel uses the tested boundary, with responsive consumers only at the leaves", async () => {
		const panel = await Bun.file(new URL("../NarratorPanel.tsx", import.meta.url)).text();
		const interaction = await Bun.file(
			new URL("../NarratorInteractionArea.tsx", import.meta.url),
		).text();
		expect(panel).toContain("createResponsiveNarratorPanel<NarratorPanelProps>(NarratorPanelBody)");
		const bodyProps = panel.slice(
			panel.indexOf("function NarratorPanelBody({"),
			panel.indexOf("const navigate ="),
		);
		expect(bodyProps).toContain('Omit<NarratorPanelProps, "compact">');
		expect(bodyProps).not.toMatch(/\bcompact\s*,/);
		expect(panel).not.toContain("useNarratorPanelCompact(");
		expect(panel).not.toContain("useContext(NarratorPanelCompactContext)");
		expect(panel).toContain("<NarratorPanelCompactContext.Consumer>");
		expect(panel).toContain(
			"common={{ narratorId, narrator, isWorkspacePreview, isMobileViewport }}",
		);
		expect(interaction).toContain("const compact = useNarratorPanelCompact();");
		expect(interaction).toContain(
			"useStatusBarProps({ ...props.common, ...props.statusBarInputs, compact })",
		);
		const common = interaction.slice(
			interaction.indexOf("export interface NarratorInteractionCommon"),
			interaction.indexOf("export interface NarratorInteractionAreaProps"),
		);
		expect(common).not.toMatch(/\bcompact\s*:/);
		expect(interaction).toContain(
			'"narratorId" | "narrator" | "isWorkspacePreview" | "compact" | "isMobileViewport"',
		);
	});
});
