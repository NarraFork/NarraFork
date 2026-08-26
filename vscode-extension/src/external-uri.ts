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
import { isLoopbackHost, isMappableByExternalUri, toMappableLoopbackOrigin } from "./loopback";

/** Raised when the resolved URL cannot be reached from the webview's browser. */
export class UnreachableWebviewUrlError extends Error {
	constructor(
		readonly backendOrigin: string,
		readonly resolved: string,
		/**
		 * Whether `asExternalUri` could even have mapped this authority.
		 *
		 * False means the address was spelled in a form its regex does not accept (an
		 * IPv6 literal), which the user can fix by changing `narrafork.serverUrl`. True
		 * means the editor declined to forward a form it does understand — a different
		 * problem, and one no rewording here would solve. The two need different advice,
		 * so the distinction travels with the error rather than being re-derived.
		 */
		readonly wasMappable: boolean,
	) {
		super(`Resolved URL is not reachable from this editor's browser: ${resolved}`);
		this.name = "UnreachableWebviewUrlError";
	}
}

/**
 * Resolve `origin` to a webview-reachable base URL, always ending in `/`.
 *
 * ⚠️ The trailing slash is load-bearing, not cosmetic. code-server's `/proxy/<port>`
 * without it resolves relative requests against the parent directory, so every asset
 * request lands one level too high and 404s. The official documentation calls this out
 * explicitly ("you must use trailing slashes"), and the resulting blank panel gives no
 * hint about the cause.
 *
 * The origin is normalized to a spelling `asExternalUri` can map BEFORE the call (see
 * `loopback.ts`): an IPv6 literal silently defeats its port-mapping regex, and the
 * resulting URL points at the user's own machine.
 */
export async function resolveWebviewBaseUrl(origin: string): Promise<string> {
	const mappable = toMappableLoopbackOrigin(origin);
	const external = await vscode.env.asExternalUri(vscode.Uri.parse(mappable));
	const asString = external.toString(true);
	const withSlash = asString.endsWith("/") ? asString : `${asString}/`;

	assertReachableFromWebview(mappable, withSlash);
	return withSlash;
}

/**
 * Refuse a resolved URL that the webview's browser cannot reach.
 *
 * ⚠️ `asExternalUri` does NOT report failure. When it cannot map an authority it
 * returns the input unchanged, so "no mapping was needed" and "no mapping was
 * possible" are the same value and must be told apart from context:
 *
 *  - Desktop VS Code: the webview runs on this machine, so an unchanged loopback URL
 *    is correct and expected.
 *  - A browser-hosted editor (code-server) or a remote/tunnelled window: the browser
 *    is somewhere else, so a loopback URL addresses the USER'S machine, where nothing
 *    is listening. Framing it yields a blank panel with no server-side error.
 *
 * Throwing here converts that into a message naming the cause. `isMappableByExternalUri`
 * keeps the check honest: a still-loopback URL whose authority WAS mappable means the
 * editor deliberately declined to forward (nothing we can fix by rewording), while an
 * unmappable authority is the bug this guards.
 */
function assertReachableFromWebview(requested: string, resolved: string): void {
	const env = describeHostEnvironment();
	const webviewIsElsewhere = env.isWeb || env.remoteName !== undefined;
	if (!webviewIsElsewhere) return;

	let hostname: string;
	try {
		hostname = new URL(resolved).hostname;
	} catch {
		return;
	}
	if (!isLoopbackHost(hostname)) return;

	// Still loopback in an environment where the browser is not this machine.
	throw new UnreachableWebviewUrlError(requested, resolved, isMappableByExternalUri(requested));
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
