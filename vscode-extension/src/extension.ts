/**
 * extension.ts — Activation, commands, and the discovery/status lifecycle.
 *
 * The extension is a front end only: it never starts, stops or configures a NarraFork
 * backend. Everything here is about locating one and rendering its UI in a panel.
 */

import * as vscode from "vscode";
import { type BackendEndpoint, type DiscoveryFailure, discoverBackend } from "./discovery";
import { describeHostEnvironment, UnreachableWebviewUrlError } from "./external-uri";
import { NarraForkPanel } from "./panel";
import { UnrepresentableFrameOriginError } from "./shell";
import { StatusBar } from "./status-bar";
import { TokenStore } from "./token-store";

let statusBar: StatusBar | undefined;
let output: vscode.OutputChannel | undefined;
let lastEndpoint: BackendEndpoint | undefined;

function configuredServerUrl(): string {
	return vscode.workspace.getConfiguration("narrafork").get<string>("serverUrl", "").trim();
}

/**
 * How long to wait after a settings edit before probing.
 *
 * ⚠️ Not a nicety. VS Code's settings UI writes the value on EVERY KEYSTROKE, so
 * `onDidChangeConfiguration` fires once per character. Each fire previously started its
 * own discovery with a 3s-per-candidate timeout and no cancellation, so typing
 * `http://localhost:7778` launched ~21 overlapping probe chains — each rendering into
 * the shared status bar as it finished, in completion order rather than keystroke order.
 *
 * The user-visible effect is a settings field that feels like it is fighting back:
 * the window busy-spins while a partial address like `http://l` is probed, and the
 * status bar flickers between stale verdicts. Debouncing means only the value the user
 * has actually stopped typing gets probed.
 */
const CONFIG_CHANGE_DEBOUNCE_MS = 600;

let configChangeTimer: ReturnType<typeof setTimeout> | undefined;
/**
 * Generation counter, so a probe that was in flight when the setting changed again
 * cannot render its (now irrelevant) verdict over the newer one. A late reply from a
 * half-typed address must be dropped, not displayed.
 */
let discoveryGeneration = 0;

/**
 * Locate the backend, updating the status bar as it goes.
 *
 * `notifyOnFailure` separates the two callers: activation runs silently (no backend is a
 * normal state for a window not using NarraFork), while a command has user intent behind
 * it and must say why nothing happened.
 */
async function findBackend(notifyOnFailure: boolean): Promise<BackendEndpoint | undefined> {
	const generation = ++discoveryGeneration;
	/** True once a newer discovery has started; this one must then stay silent. */
	const superseded = () => generation !== discoveryGeneration;

	statusBar?.render({ kind: "searching" });
	const result = await discoverBackend({ configuredUrl: configuredServerUrl() });

	if (result.ok) {
		if (superseded()) return result.endpoint;
		lastEndpoint = result.endpoint;
		statusBar?.render({ kind: "connected", endpoint: result.endpoint });
		output?.appendLine(
			`[discovery] ${result.endpoint.origin} (${result.endpoint.source})` +
				`${result.endpoint.version ? ` version ${result.endpoint.version}` : ""}`,
		);
		return result.endpoint;
	}

	// A superseded failure must not clear `lastEndpoint` or repaint: the value it probed
	// is no longer the configured one, so its verdict says nothing about the current
	// setting. Dropping it is what stops a half-typed address from evicting a working
	// endpoint.
	if (superseded()) return undefined;

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

async function openPanel(
	tokens: TokenStore,
	options: { forceReload?: boolean } = {},
): Promise<void> {
	const endpoint = lastEndpoint ?? (await findBackend(true));
	if (!endpoint) return;
	try {
		// biome-ignore lint/style/noNonNullAssertion: output is created in activate()
		await NarraForkPanel.createOrShow(endpoint, tokens, output!, options);
	} catch (err) {
		await reportPanelFailure(err, endpoint);
	}
}

/**
 * Explain why a panel could not be opened.
 *
 * ⚠️ Exists because the two errors below otherwise manifest as a BLANK PANEL with the
 * only evidence in a webview devtools console — which is the one place a user will not
 * look. Both are address-shape problems with a concrete fix, so the message names it.
 */
async function reportPanelFailure(err: unknown, endpoint: BackendEndpoint): Promise<void> {
	output?.appendLine(`[panel] failed to open for ${endpoint.origin}: ${String(err)}`);

	const isAddressShapeProblem =
		err instanceof UnreachableWebviewUrlError || err instanceof UnrepresentableFrameOriginError;
	if (!isAddressShapeProblem) {
		void vscode.window.showErrorMessage(
			vscode.l10n.t("NarraFork could not open the panel: {0}", String(err)),
		);
		return;
	}

	// The remedy is the same in both cases and it is not guessable: this editor runs in a
	// browser elsewhere, so the panel needs an address that editor can forward or reach.
	const message = vscode.l10n.t(
		"NarraFork cannot display {0} in this editor: the address could not be forwarded to your browser. Set narrafork.serverUrl to a hostname this editor can reach (use localhost rather than an IPv6 literal like [::1], or a public address if the backend is remote).",
		endpoint.origin,
	);
	const openSettings = vscode.l10n.t("Open Settings");
	const choice = await vscode.window.showErrorMessage(message, openSettings);
	if (choice === openSettings) {
		await vscode.commands.executeCommand("workbench.action.openSettings", "narrafork.serverUrl");
	}
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
			lastEndpoint = endpoint;
			// `forceReload` is deliberate here and only here: reconnecting means discarding the
			// current view (streaming output, unsent input) to re-establish the connection,
			// which is what the user asked for. Plain "Open Panel" must not do that.
			await openPanel(tokens, { forceReload: true });
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
		//
		// The PROBE is debounced but the invalidation is not: the settings UI fires this
		// per keystroke, and probing every intermediate value is what made the field feel
		// like it was fighting the user (see CONFIG_CHANGE_DEBOUNCE_MS). Clearing the
		// cache immediately is still correct and costs nothing — it only means the next
		// command re-discovers.
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (!event.affectsConfiguration("narrafork.serverUrl")) return;
			lastEndpoint = undefined;
			if (configChangeTimer) clearTimeout(configChangeTimer);
			configChangeTimer = setTimeout(() => {
				configChangeTimer = undefined;
				void findBackend(false);
			}, CONFIG_CHANGE_DEBOUNCE_MS);
		}),
		// Cancel a pending probe on deactivation, so it cannot fire into a disposed
		// status bar after the extension host has torn this extension down.
		new vscode.Disposable(() => {
			if (configChangeTimer) clearTimeout(configChangeTimer);
			configChangeTimer = undefined;
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
