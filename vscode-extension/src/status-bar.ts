/**
 * status-bar.ts — Report connection state without interrupting the user.
 *
 * Discovery runs on activation, and a missing backend is the NORMAL state for a window
 * where the user is not using NarraFork right now. So a failure updates this item and
 * nothing else — no notification. Errors are raised only when the user invokes a command,
 * i.e. only when they have expressed intent.
 */

import * as vscode from "vscode";
import type { BackendEndpoint } from "./discovery";

export type ConnectionState =
	| { kind: "idle" }
	| { kind: "searching" }
	| { kind: "connected"; endpoint: BackendEndpoint }
	| { kind: "not-found"; attempted: string[] };

export class StatusBar implements vscode.Disposable {
	private readonly item: vscode.StatusBarItem;

	constructor() {
		this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
		this.item.command = "narrafork.openPanel";
		this.item.name = "NarraFork";
		this.render({ kind: "idle" });
		this.item.show();
	}

	render(state: ConnectionState): void {
		switch (state.kind) {
			case "idle":
				this.item.text = "$(git-branch) NarraFork";
				this.item.tooltip = "NarraFork: click to open the panel";
				break;
			case "searching":
				this.item.text = "$(sync~spin) NarraFork";
				this.item.tooltip = "NarraFork: looking for a local backend…";
				break;
			case "connected": {
				const port = portOf(state.endpoint.origin);
				this.item.text = `$(git-branch) NarraFork${port ? ` (${port})` : ""}`;
				this.item.tooltip = [
					`Connected to ${state.endpoint.origin}`,
					state.endpoint.version ? `Version ${state.endpoint.version}` : undefined,
					`Discovered via: ${state.endpoint.source}`,
				]
					.filter(Boolean)
					.join("\n");
				break;
			}
			case "not-found":
				// `$(warning)` rather than an error colour: no backend is an ordinary state
				// for a window that is not using NarraFork, not a fault to alarm about.
				this.item.text = "$(warning) NarraFork";
				this.item.tooltip = [
					"No NarraFork backend responded.",
					`Tried: ${state.attempted.join(", ") || "(nothing)"}`,
					"Start NarraFork, or set narrafork.serverUrl.",
				].join("\n");
				break;
		}
	}

	dispose(): void {
		this.item.dispose();
	}
}

function portOf(origin: string): string | null {
	try {
		const url = new URL(origin);
		return url.port || (url.protocol === "https:" ? "443" : "80");
	} catch {
		return null;
	}
}
