/**
 * The team page's coordinator line stands in for the narrator panel's hidden header on one more
 * point: the 「连接断开」 badge. The panel reports its socket state (`useReportPanelConnection`,
 * the panel's `onConnectionChange`); the line shows it and a click runs the panel's reconnect.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import type { TeamPageSummary } from "@shared/project-teams";
import { createInstance } from "i18next";
import { parseHTML } from "linkedom";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import en from "../../locales/en/projects.json";
import zh from "../../locales/zh-CN/projects.json";
import type { NarratorPanelConnection } from "../narrator/narrator-panel-types";
import { useReportPanelConnection } from "../narrator/panel-connection";
import { TeamCoordinatorHeader } from "./TeamCoordinatorHeader";

const keys = ["window", "document", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originals = keys.map(
	(key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
);

beforeAll(() => {
	const { window, document } = parseHTML("<!doctype html><html><body></body></html>");
	const matchMedia = () => ({
		matches: false,
		media: "",
		onchange: null,
		addListener: () => {},
		removeListener: () => {},
		addEventListener: () => {},
		removeEventListener: () => {},
		dispatchEvent: () => false,
	});
	Object.defineProperty(window, "matchMedia", { configurable: true, value: matchMedia });
	for (const [key, value] of [
		["window", window],
		["document", document],
		["navigator", window.navigator],
		["IS_REACT_ACT_ENVIRONMENT", true],
	] as const)
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
});

afterAll(() => {
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});

async function i18nFor(lng: "en" | "zh-CN") {
	const i18n = createInstance();
	await i18n.init({
		lng,
		resources: { en: { projects: en }, "zh-CN": { projects: zh } },
		defaultNS: "projects",
		interpolation: { escapeValue: false },
	});
	return i18n;
}

const summary: TeamPageSummary = {
	teamId: "lead",
	access: "write",
	coordinatorStatus: "idle",
	runningAgents: [],
	runningCount: 0,
	pendingApprovalCount: 0,
	columnCounts: { queued: 0, in_progress: 0, review: 0, done: 0, cancelled: 0 },
	lastEventId: null,
	lastEventAt: null,
};

/** The panel's side (its socket state and own reconnect) wired to the line as the route does. */
let setPanelDisconnected: (value: boolean) => void = () => {};
function Wired({ panelReconnect }: { panelReconnect: () => void }) {
	const [disconnected, setDisconnected] = useState(false);
	setPanelDisconnected = setDisconnected;
	const [connection, setConnection] = useState<NarratorPanelConnection | null>(null);
	return (
		<>
			<PanelStandIn
				disconnected={disconnected}
				reconnect={panelReconnect}
				onConnectionChange={setConnection}
			/>
			<TeamCoordinatorHeader summary={summary} connection={connection} />
		</>
	);
}

function PanelStandIn({
	disconnected,
	reconnect,
	onConnectionChange,
}: {
	disconnected: boolean;
	reconnect: () => void;
	onConnectionChange: (connection: NarratorPanelConnection) => void;
}) {
	useReportPanelConnection(onConnectionChange, disconnected, reconnect);
	return null;
}

async function mount(node: React.ReactNode, lng: "en" | "zh-CN" = "zh-CN") {
	const i18n = await i18nFor(lng);
	const host = document.createElement("div");
	document.body.appendChild(host);
	let root: Root | null = null;
	await act(async () => {
		root = createRoot(host);
		root.render(
			<I18nextProvider i18n={i18n}>
				<MantineProvider>{node}</MantineProvider>
			</I18nextProvider>,
		);
	});
	return {
		badge: () => host.querySelector<HTMLElement>("[data-testid=team-coordinator-disconnected]"),
		unmount: async () => {
			await act(async () => root?.unmount());
			host.remove();
		},
	};
}

describe("the coordinator line's 连接断开", () => {
	test("shows while the panel reports its socket down; a click runs the panel's reconnect", async () => {
		const calls: string[] = [];
		const view = await mount(<Wired panelReconnect={() => calls.push("panel")} />);
		expect(view.badge()).toBeNull();
		await act(async () => setPanelDisconnected(true));
		const badge = view.badge();
		expect(badge?.textContent).toBe("连接断开");
		expect(badge?.getAttribute("title")).toBe("点击重新连接");
		await act(async () => badge?.click());
		expect(calls).toEqual(["panel"]);
		// Back up: the badge goes.
		await act(async () => setPanelDisconnected(false));
		expect(view.badge()).toBeNull();
		await view.unmount();
	});

	test("the click reaches the panel's current reconnect, not the one first reported", async () => {
		const calls: string[] = [];
		let latest = () => calls.push("first");
		let rerender: (fn: () => void) => void = () => {};
		function Swapping() {
			const [reconnect, setReconnect] = useState<() => void>(() => latest);
			rerender = (fn) => setReconnect(() => fn);
			const [connection, setConnection] = useState<NarratorPanelConnection | null>(null);
			return (
				<>
					<PanelStandIn disconnected reconnect={reconnect} onConnectionChange={setConnection} />
					<TeamCoordinatorHeader summary={summary} connection={connection} />
				</>
			);
		}
		const view = await mount(<Swapping />, "en");
		expect(view.badge()?.textContent).toBe("Disconnected");
		latest = () => calls.push("second");
		await act(async () => rerender(latest));
		await act(async () => view.badge()?.click());
		expect(calls).toEqual(["second"]);
		await view.unmount();
	});
});
