/**
 * extension.ts — Activation, commands, and the discovery/status lifecycle.
 *
 * The extension is a front end only: it never starts, stops or configures a NarraFork
 * backend. Everything here is about locating one and rendering its UI in a panel.
 */

import * as vscode from "vscode";
import { type BackendEndpoint, type DiscoveryFailure, discoverBackend } from "./discovery";
import { describeHostEnvironment } from "./external-uri";
import { NarraForkPanel } from "./panel";
import { StatusBar } from "./status-bar";
import { TokenStore } from "./token-store";

let statusBar: StatusBar | undefined;
let output: vscode.OutputChannel | undefined;
let lastEndpoint: BackendEndpoint | undefined;

function configuredServerUrl(): string {
	return vscode.workspace.getConfiguration("narrafork").get<string>("serverUrl", "").trim();
}

/**
 * Locate the backend, updating the status bar as it goes.
 *
 * `notifyOnFailure` separates the two callers: activation runs silently (no backend is a
 * normal state for a window not using NarraFork), while a command has user intent behind
 * it and must say why nothing happened.
 */
async function findBackend(notifyOnFailure: boolean): Promise<BackendEndpoint | undefined> {
	statusBar?.render({ kind: "searching" });
	const result = await discoverBackend({ configuredUrl: configuredServerUrl() });

	if (result.ok) {
		lastEndpoint = result.endpoint;
		statusBar?.render({ kind: "connected", endpoint: result.endpoint });
		output?.appendLine(
			`[discovery] ${result.endpoint.origin} (${result.endpoint.source})` +
				`${result.endpoint.version ? ` version ${result.endpoint.version}` : ""}`,
		);
		return result.endpoint;
	}

	lastEndpoint = undefined;
	statusBar?.render({ kind: "not-found", attempted: result.failure.attempted });
	output?.appendLine(
		`[discovery] no backend responded; tried ${result.failure.attempted.join(", ")}`,
	);
	if (notifyOnFailure) await reportDiscoveryFailure(result.failure);
	return undefined;
}

async function reportDiscoveryFailure(failure: DiscoveryFailure): Promise<void> {
	const tried = failure.attempted.join(", ") || "(nothing)";
	// A pinned URL gets a message that does NOT suggest looking elsewhere: discovery
	// deliberately did not fall back, and implying otherwise would send the user hunting
	// for a problem that is in their setting.
	const message = failure.configured
		? vscode.l10n.t("NarraFork did not respond at the configured address ({0}).", tried)
		: vscode.l10n.t("No NarraFork backend responded. Tried: {0}.", tried);

	const openSettings = vscode.l10n.t("Open Settings");
	const choice = await vscode.window.showWarningMessage(message, openSettings);
	if (choice === openSettings) {
		await vscode.commands.executeCommand("workbench.action.openSettings", "narrafork.serverUrl");
	}
}

async function openPanel(tokens: TokenStore): Promise<void> {
	const endpoint = lastEndpoint ?? (await findBackend(true));
	if (!endpoint) return;
	// biome-ignore lint/style/noNonNullAssertion: output is created in activate()
	await NarraForkPanel.createOrShow(endpoint, tokens, output!);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	output = vscode.window.createOutputChannel("NarraFork");
	statusBar = new StatusBar();
	context.subscriptions.push(output, statusBar);

	const tokens = new TokenStore(context.secrets);
	const env = describeHostEnvironment();
	output.appendLine(
		`[activate] uiKind=${env.isWeb ? "web" : "desktop"} remote=${env.remoteName ?? "local"}`,
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("narrafork.openPanel", () => openPanel(tokens)),
		vscode.commands.registerCommand("narrafork.reconnect", async () => {
			// Re-discover rather than reusing the cached endpoint: "reconnect" exists for the
			// case where the backend moved or was restarted.
			const endpoint = await findBackend(true);
			if (!endpoint) return;
			// `forceReload` is deliberate here and only here: reconnecting means discarding the
			// current view (streaming output, unsent input) to re-establish the connection,
			// which is what the user asked for. Plain "Open Panel" must not do that.
			// biome-ignore lint/style/noNonNullAssertion: output is created above
			await NarraForkPanel.createOrShow(endpoint, tokens, output!, { forceReload: true });
		}),
		vscode.commands.registerCommand("narrafork.signOut", async () => {
			const origin = lastEndpoint?.origin;
			if (origin) await tokens.clear(origin);
			await NarraForkPanel.active?.signOut();
			void vscode.window.showInformationMessage(
				vscode.l10n.t("NarraFork: the stored session token has been removed."),
			);
		}),
		vscode.commands.registerCommand("narrafork.openInBrowser", async () => {
			const endpoint = lastEndpoint ?? (await findBackend(true));
			if (!endpoint) return;
			// `openExternal` performs the same `asExternalUri` resolution internally, so the
			// browser gets a URL that works from wherever the editor is being used.
			await vscode.env.openExternal(vscode.Uri.parse(endpoint.origin));
		}),
		// A changed address invalidates the cached endpoint immediately, so the next
		// command does not silently reuse the previous backend.
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration("narrafork.serverUrl")) {
				lastEndpoint = undefined;
				void findBackend(false);
			}
		}),
	);

	await findBackend(false);

	if (vscode.workspace.getConfiguration("narrafork").get<boolean>("openOnStartup", false)) {
		await openPanel(tokens);
	}
}

export function deactivate(): void {
	// Disposal is handled through `context.subscriptions`.
}
