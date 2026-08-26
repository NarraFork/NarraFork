/**
 * external-uri.ts — Turn a local backend origin into a URL the webview can load.
 *
 * The webview runs in a browser context that is not the extension host, so "the URL the
 * backend listens on" and "the URL the webview can reach" are not the same string:
 *
 *   - **Desktop VS Code**: the webview can reach loopback directly, and
 *     `asExternalUri` returns the input unchanged for localhost.
 *   - **code-server**: the browser may be anywhere; `asExternalUri` returns
 *     `<code-server-root>/proxy/<port>/` (its `proxyEndpointTemplate` default), a
 *     PATH-STRIPPING proxy. That is why the SPA had to become mount-prefix aware — see
 *     `server/lib/spa-base-href.ts`.
 *   - **Remote SSH / devcontainers / tunnels**: `asExternalUri` establishes forwarding
 *     and returns whatever address that produced.
 *
 * ⚠️ Behaviour is deliberately NOT branched per environment. Every case goes through
 * `asExternalUri`, and the environment is inspected only to word errors and the status
 * bar. A branch would create a path that only one environment ever executes, which is
 * the shape that silently rots — and the API already answers the question correctly in
 * all of them.
 */

import * as vscode from "vscode";

/**
 * Resolve `origin` to a webview-reachable base URL, always ending in `/`.
 *
 * ⚠️ The trailing slash is load-bearing, not cosmetic. code-server's `/proxy/<port>`
 * without it resolves relative requests against the parent directory, so every asset
 * request lands one level too high and 404s. The official documentation calls this out
 * explicitly ("you must use trailing slashes"), and the resulting blank panel gives no
 * hint about the cause.
 */
export async function resolveWebviewBaseUrl(origin: string): Promise<string> {
	const external = await vscode.env.asExternalUri(vscode.Uri.parse(origin));
	const asString = external.toString(true);
	return asString.endsWith("/") ? asString : `${asString}/`;
}

/** The origin part of a base URL, for CSP directives that take an origin. */
export function originOf(baseUrl: string): string {
	try {
		return new URL(baseUrl).origin;
	} catch {
		return baseUrl;
	}
}

export interface HostEnvironment {
	/** True in a browser-hosted editor (code-server, vscode.dev). */
	isWeb: boolean;
	/** Remote name (`ssh-remote`, `dev-container`, …) or undefined when local. */
	remoteName?: string;
}

export function describeHostEnvironment(): HostEnvironment {
	return {
		isWeb: vscode.env.uiKind === vscode.UIKind.Web,
		remoteName: vscode.env.remoteName,
	};
}
