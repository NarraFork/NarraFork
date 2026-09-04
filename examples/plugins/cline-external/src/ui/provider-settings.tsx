/**
 * `provider-settings` view entry: hand off to the panel in `./panel`.
 *
 * The panel is loaded with a dynamic import on purpose. A host that predates the
 * `runtime: "host-react"` contract — or injects a runtime version this bundle was not
 * built against — makes `host-runtime.ts` throw *during module evaluation*. With a
 * static import that exception would abort this whole bundle before any fallback could
 * run, leaving a blank iframe and an error only in a console nobody can see. The dynamic
 * import turns the same failure into a rejection the plain-DOM fallback below renders.
 */

import { errorMessage, type PluginUiSdk } from "./panel-types";
import { t } from "./strings";

/**
 * Report a failure without using the host runtime.
 *
 * Deliberately plain DOM: the failures this covers are "React or Mantine is unusable", so
 * rendering the message with them would fail the same way and leave the panel blank — which
 * is indistinguishable from the panel never having been asked to load.
 *
 * `strings.ts` is safe here because it reads `globalThis.narrafork.i18n`, which the host installs
 * before this file runs and which does not depend on the runtime that just failed.
 */
function renderFatal(detail: string): void {
	const box = document.createElement("div");
	box.style.padding = "12px";
	box.style.font = "13px/1.5 var(--nf-font, system-ui, sans-serif)";
	// Host tokens with the previous values as fallbacks: this path runs when the shared runtime is
	// broken, but the token stylesheet is injected by the shell and is unaffected by that.
	box.style.color = "var(--nf-color-error, #ffa8a8)";
	box.style.background = "var(--nf-color-surface, #2e1a1a)";
	box.style.borderRadius = "6px";
	box.style.margin = "12px";
	box.style.whiteSpace = "pre-wrap";
	box.style.wordBreak = "break-word";

	const title = document.createElement("div");
	title.style.fontWeight = "600";
	title.style.marginBottom = "4px";
	title.textContent = t("runtimeMissingTitle");
	box.appendChild(title);

	const body = document.createElement("div");
	body.textContent = detail;
	box.appendChild(body);

	document.body.style.margin = "0";
	document.body.appendChild(box);
}

const sdk = (globalThis as { narrafork?: PluginUiSdk }).narrafork;
if (sdk) {
	void import("./panel").then(
		({ mount }) => {
			// A throw here is not recoverable — `createRoot` failing, or a runtime that satisfied
			// `host-runtime.ts`'s checks but is not actually usable — but it must still say so.
			// Letting it escape leaves an empty iframe with no indication anything was attempted.
			try {
				mount(sdk);
			} catch (error: unknown) {
				renderFatal(errorMessage(error));
			}
		},
		(error: unknown) => renderFatal(errorMessage(error)),
	);
} else {
	// The host injects `globalThis.narrafork` before loading this file. Without it the panel
	// cannot reach its backend at all, and previously did nothing at all to say so.
	renderFatal("The host did not provide the plugin UI SDK (globalThis.narrafork).");
}
