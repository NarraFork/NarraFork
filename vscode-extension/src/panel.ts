/**
 * panel.ts — The single NarraFork webview panel and its message plumbing.
 */

import * as vscode from "vscode";
import type { BackendEndpoint } from "./discovery";
import { originOf, resolveWebviewBaseUrl } from "./external-uri";
import { buildFrameUrl, generateNonce, renderShellHtml } from "./shell";
import type { TokenStore } from "./token-store";

interface ShellMessage {
	type?: unknown;
	token?: unknown;
}

export class NarraForkPanel {
	private static current: NarraForkPanel | undefined;

	/**
	 * Reveal the panel, creating it if needed.
	 *
	 * ⚠️ An already-open panel is REVEALED, not re-rendered. Re-rendering assigns
	 * `webview.html`, which tears the iframe down and reloads the SPA — losing exactly what
	 * `retainContextWhenHidden` below exists to preserve: a streaming narrator, live
	 * WebSocket subscriptions, unsent composer text. "Open Panel" on a panel that is already
	 * open must be a no-op beyond focusing it.
	 *
	 * `forceReload` is how `narrafork.reconnect` opts into the destructive path, and a
	 * changed endpoint forces it regardless: continuing to display a panel bound to a
	 * backend that is no longer the target would be worse than losing the view state.
	 */
	static async createOrShow(
		endpoint: BackendEndpoint,
		tokens: TokenStore,
		output: vscode.OutputChannel,
		options: { forceReload?: boolean } = {},
	): Promise<NarraForkPanel> {
		if (NarraForkPanel.current) {
			const existing = NarraForkPanel.current;
			existing.panel.reveal(vscode.ViewColumn.Active);
			const endpointChanged = existing.origin !== endpoint.origin;
			if (options.forceReload || endpointChanged) {
				await existing.load(endpoint);
			}
			return existing;
		}

		const panel = vscode.window.createWebviewPanel(
			"narrafork.panel",
			"NarraFork",
			vscode.ViewColumn.Active,
			{
				enableScripts: true,
				// The panel holds a live SPA: WebSocket subscriptions, an in-flight narrator
				// stream, unsent composer text. Letting VS Code dispose the webview when the
				// tab is hidden would drop all of it, and the user would read that as the
				// extension losing their work.
				retainContextWhenHidden: true,
				// No `localResourceRoots`: the document is generated in memory and everything
				// else lives in the iframe on the backend's origin.
				localResourceRoots: [],
			},
		);

		const instance = new NarraForkPanel(panel, tokens, output);
		NarraForkPanel.current = instance;
		await instance.load(endpoint);
		return instance;
	}

	static get active(): NarraForkPanel | undefined {
		return NarraForkPanel.current;
	}

	private readonly disposables: vscode.Disposable[] = [];
	private origin: string | null = null;
	private shellReady = false;
	private pendingBootstrap = false;

	private constructor(
		private readonly panel: vscode.WebviewPanel,
		private readonly tokens: TokenStore,
		private readonly output: vscode.OutputChannel,
	) {
		this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
		this.panel.webview.onDidReceiveMessage(
			(message: ShellMessage) => void this.onShellMessage(message),
			null,
			this.disposables,
		);
	}

	/** (Re)point the panel at `endpoint` and render a fresh shell. */
	async load(endpoint: BackendEndpoint): Promise<void> {
		const baseUrl = await resolveWebviewBaseUrl(endpoint.origin);
		// The BACKEND origin keys the token, not the webview-reachable one: the latter is
		// a code-server proxy URL that varies with how the editor is reached, while the
		// session belongs to the backend.
		this.origin = endpoint.origin;
		this.shellReady = false;
		this.pendingBootstrap = true;

		const baseOrigin = originOf(baseUrl);
		this.panel.webview.html = renderShellHtml({
			baseUrl,
			baseOrigin,
			nonce: generateNonce(),
			handshakeNonce: generateNonce(),
			loadingLabel: vscode.l10n.t("Connecting to NarraFork…"),
		});
		this.output.appendLine(
			`[panel] loading ${buildFrameUrl(baseUrl, "<nonce>")} (backend ${endpoint.origin})`,
		);
	}

	/**
	 * Drop the stored token and tell the SPA to end its session.
	 *
	 * ⚠️ Clearing the secret is NOT sufficient on its own, and this is the part that is easy
	 * to get wrong: the SPA authenticates with its OWN `localStorage` copy on the backend
	 * origin, which this side cannot touch. Without the explicit message the panel stays
	 * logged in, and the next time it reports a renewed token the host would store it again
	 * — a sign-out that undoes itself.
	 *
	 * A dedicated message rather than `bootstrap { token: null }`, because that one means
	 * "the host has no stored copy" and must not destroy a live session.
	 */
	async signOut(): Promise<void> {
		if (this.origin) await this.tokens.clear(this.origin);
		this.panel.webview.postMessage({ type: "narrafork.sign-out" });
	}

	private async onShellMessage(message: ShellMessage): Promise<void> {
		if (message?.type === "narrafork.shell-ready") {
			this.shellReady = true;
			if (this.pendingBootstrap) await this.sendBootstrap();
			return;
		}

		if (message?.type === "narrafork.token-changed") {
			if (!this.origin) return;
			if (message.token === null) {
				await this.tokens.clear(this.origin);
				this.output.appendLine("[panel] session token cleared by the app");
				return;
			}
			const stored = await this.tokens.write(this.origin, message.token);
			// Length only, never the value: this channel is a diagnostic log the user may
			// paste into an issue.
			this.output.appendLine(
				stored
					? "[panel] session token updated from the app"
					: "[panel] ignored a token-changed message whose value was not a session token",
			);
		}
	}

	private async sendBootstrap(): Promise<void> {
		if (!this.shellReady || !this.origin) return;
		this.pendingBootstrap = false;
		const token = await this.tokens.read(this.origin);
		// Sent even when absent, so the SPA can stop waiting and render its login form
		// rather than sitting on a spinner for a handshake that will never arrive.
		this.panel.webview.postMessage({ type: "narrafork.bootstrap", token: token ?? null });
	}

	private dispose(): void {
		NarraForkPanel.current = undefined;
		while (this.disposables.length) this.disposables.pop()?.dispose();
	}
}
