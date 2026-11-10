/**
 * The device rows must distinguish "switch there" from "enter a directory first".
 *
 * A session keeps one working directory per device, and switching to a device with no
 * recorded directory is refused by the server (it would run tools somewhere nobody
 * chose). The picker therefore routes that click to the directory dialog instead of
 * attempting the switch — with an unknown map degrading to the old behaviour so a
 * stale client only ever gets the server's 409, never a silent wrong switch.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { MantineProvider, Menu } from "@mantine/core";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ExecutionDeviceOptions } from "./ExecutionDeviceMenu";

let root: Root;
let host: HTMLDivElement;
const previousGlobals = new Map<string, PropertyDescriptor | undefined>();

beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	const globals = {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		Event: window.Event,
		getComputedStyle: () => ({ getPropertyValue: () => "", direction: "ltr" }),
		matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
		requestAnimationFrame: (callback: FrameRequestCallback) => {
			callback(0);
			return 1;
		},
		cancelAnimationFrame: () => {},
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	for (const [key, value] of Object.entries(globals)) {
		previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	host = window.document.createElement("div") as unknown as HTMLDivElement;
	(window.document.body as unknown as { appendChild: (node: unknown) => void }).appendChild(host);
	root = createRoot(host);
});

afterEach(async () => {
	await act(async () => root.unmount());
	for (const [key, descriptor] of previousGlobals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	previousGlobals.clear();
});

const devices = [
	{ id: "configured", name: "configured box", online: true },
	{ id: "unconfigured", name: "unconfigured box", online: true },
	{ id: "asleep", name: "asleep box", online: false },
];

async function render(options: {
	directories?: Record<string, { cwd: string; pathFlavor: "posix" | "windows" }>;
	onSelect: (deviceId: string | null) => void;
	onRequireDirectory?: (deviceId: string) => void;
}) {
	await act(async () => {
		root.render(
			<MantineProvider env="test">
				<Menu opened>
					<ExecutionDeviceOptions
						label="Executor"
						localLabel="Local server"
						offlineLabel="offline"
						noDirectoryLabel="no directory yet"
						devices={devices}
						currentDeviceId="configured"
						directories={options.directories}
						onSelect={options.onSelect}
						onRequireDirectory={options.onRequireDirectory}
					/>
				</Menu>
			</MantineProvider>,
		);
	});
}

function clickRow(label: string) {
	const button = [...host.querySelectorAll("button")].find((element) =>
		element.textContent?.includes(label),
	);
	if (!button) throw new Error(`Row ${label} not rendered`);
	act(() => button.click());
}

test("a configured device switches directly", async () => {
	const selected: Array<string | null> = [];
	await render({
		directories: {
			local: { cwd: "/work", pathFlavor: "posix" },
			configured: { cwd: "/srv/app", pathFlavor: "posix" },
			unconfigured: { cwd: "/srv/other", pathFlavor: "posix" },
		},
		onSelect: (deviceId) => selected.push(deviceId),
		onRequireDirectory: () => {
			throw new Error("must not ask for a directory");
		},
	});
	clickRow("configured box");
	clickRow("Local server");
	expect(selected).toEqual(["configured", null]);
});

test("a device with no recorded directory asks for one instead of switching", async () => {
	const selected: Array<string | null> = [];
	const asked: string[] = [];
	await render({
		directories: {
			local: { cwd: "/work", pathFlavor: "posix" },
			configured: { cwd: "/srv/app", pathFlavor: "posix" },
		},
		onSelect: (deviceId) => selected.push(deviceId),
		onRequireDirectory: (deviceId) => asked.push(deviceId),
	});
	clickRow("unconfigured box");
	expect(selected).toEqual([]);
	expect(asked).toEqual(["unconfigured"]);
	expect(host.textContent).toContain("no directory yet");
});

test("local without a recorded directory asks for one too", async () => {
	const selected: Array<string | null> = [];
	const asked: string[] = [];
	await render({
		directories: { remote: { cwd: "C:\\work", pathFlavor: "windows" } },
		onSelect: (deviceId) => selected.push(deviceId),
		onRequireDirectory: (deviceId) => asked.push(deviceId),
	});
	clickRow("Local server");
	expect(selected).toEqual([]);
	expect(asked).toEqual(["local"]);
});

test("an unknown directory map degrades to attempting the switch", async () => {
	// A client that has not received `directories` yet must not block the user: the
	// server's 409 is the backstop, and it carries the device id.
	const selected: Array<string | null> = [];
	await render({
		onSelect: (deviceId) => selected.push(deviceId),
		onRequireDirectory: () => {
			throw new Error("must not ask for a directory");
		},
	});
	clickRow("configured box");
	expect(selected).toEqual(["configured"]);
	expect(host.textContent).not.toContain("no directory yet");
});
