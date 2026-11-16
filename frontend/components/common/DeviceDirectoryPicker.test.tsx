/**
 * The shared device-aware directory picker.
 *
 * Two browsers, one branch: a local device gets this server's picker (favorites, drives,
 * mkdir), any other device gets the remote browser fed by the caller's listing function.
 * These tests pin the branch, the prop pass-through the remote browser depends on, and
 * the option list every host shares.
 */

import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { RemoteDirectoryLister } from "../permissions/RemoteDirectoryBrowser";

mock.module("@mantine/core", () => ({
	Modal: ({ opened, children }: { opened: boolean; children?: ReactNode }) =>
		opened ? <div data-modal="true">{children}</div> : null,
}));
mock.module("@mantine/hooks", () => ({ useMediaQuery: () => false }));

/** Records what the local browser was handed. */
let localProps: Record<string, unknown> = {};
mock.module("./DirectoryPicker", () => ({
	DirectoryBrowser: (props: Record<string, unknown>) => {
		localProps = props;
		return <div data-local-browser="true" />;
	},
}));

/** Records what the remote browser was handed. */
let remoteProps: Record<string, unknown> = {};
mock.module("../permissions/RemoteDirectoryBrowser", () => ({
	RemoteDirectoryBrowser: (props: Record<string, unknown>) => {
		remoteProps = props;
		return <div data-remote-browser="true" />;
	},
}));

const { DeviceDirectoryBrowser, DeviceDirectoryModal } = await import("./DeviceDirectoryPicker");
const { deviceSelectData, LOCAL_DEVICE } = await import("./device-directory-options");

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
	const { document } = parseHTML("<html><body></body></html>");
	(globalThis as unknown as { window: unknown }).window = document;
	(globalThis as unknown as { document: unknown }).document = document;
	(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	container = document.createElement("div") as unknown as HTMLDivElement;
	document.body.appendChild(container as unknown as Node);
	root = createRoot(container);
	localProps = {};
	remoteProps = {};
});

afterEach(() => {
	act(() => root.unmount());
});

const noop = () => {};

/** A one-level reply shaped like a device's own listing, so the prop type stays honest. */
const listDirectory: RemoteDirectoryLister = async () => ({
	path: "/srv",
	entries: [],
	parent: null,
	sep: "/",
	truncated: false,
});

test("a local target renders this server's browser and never the device one", async () => {
	await act(async () => {
		root.render(
			<DeviceDirectoryBrowser
				deviceId={LOCAL_DEVICE}
				initialPath="/workspace"
				onSelect={noop}
				onCancel={noop}
			/>,
		);
	});
	expect(container.querySelector("[data-local-browser]")).not.toBeNull();
	expect(container.querySelector("[data-remote-browser]")).toBeNull();
	// The local picker is the one that understands a starting directory and new targets.
	expect(localProps.initialPath).toBe("/workspace");
});

test("a remote target renders that device's browser with the caller's lister", async () => {
	await act(async () => {
		root.render(
			<DeviceDirectoryBrowser
				deviceId="win-box"
				deviceLabel="windows box"
				initialPath={"C:\\work"}
				listDirectory={listDirectory}
				queryKey={["workspaceDeviceBrowse", "win-box", null]}
				onSelect={noop}
				onCancel={noop}
			/>,
		);
	});
	expect(container.querySelector("[data-remote-browser]")).not.toBeNull();
	expect(container.querySelector("[data-local-browser]")).toBeNull();
	expect(remoteProps.deviceLabel).toBe("windows box");
	expect(remoteProps.initialPath).toBe("C:\\work");
	expect(remoteProps.listDirectory).toBe(listDirectory);
	// The cache key is the caller's: it identifies which device the listing belongs to.
	expect(remoteProps.queryKey).toEqual(["workspaceDeviceBrowse", "win-box", null]);
});

test("a remote target without a lister renders nothing instead of a broken browser", async () => {
	await act(async () => {
		root.render(<DeviceDirectoryBrowser deviceId="win-box" onSelect={noop} onCancel={noop} />);
	});
	expect(container.querySelector("[data-remote-browser]")).toBeNull();
	expect(container.querySelector("[data-local-browser]")).toBeNull();
});

test("the modal shell mounts its content only while open", async () => {
	await act(async () => {
		root.render(
			<DeviceDirectoryModal
				opened
				onClose={noop}
				title="Select Directory"
				deviceId={LOCAL_DEVICE}
				onSelect={noop}
				onCancel={noop}
			/>,
		);
	});
	expect(container.querySelector("[data-modal]")).not.toBeNull();
	expect(container.querySelector("[data-local-browser]")).not.toBeNull();
	act(() => root.unmount());
	root = createRoot(container);
	await act(async () => {
		root.render(
			<DeviceDirectoryModal
				opened={false}
				onClose={noop}
				title="Select Directory"
				deviceId={LOCAL_DEVICE}
				onSelect={noop}
				onCancel={noop}
			/>,
		);
	});
	expect(container.querySelector("[data-local-browser]")).toBeNull();
});

test("device options put local first and disable an offline device", () => {
	const data = deviceSelectData(
		[
			{ id: "win-box", name: "windows box", online: true },
			{ id: "asleep", name: "asleep box", online: false },
			{ id: LOCAL_DEVICE, name: "should be dropped", online: true },
		],
		{ local: "Local", offline: "offline" },
	);
	expect(data).toEqual([
		{ value: LOCAL_DEVICE, label: "Local" },
		{ value: "win-box", label: "windows box", disabled: false },
		{ value: "asleep", label: "asleep box · offline", disabled: true },
	]);
});
