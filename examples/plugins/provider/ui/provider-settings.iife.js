/**
 * Example `provider-settings` view.
 *
 * Demonstrates the minimum a provider plugin needs to replace the host's generated
 * config form with its own UI: read the plugin's own configuration, render it, and tell
 * the host what happened.
 *
 * Deliberately kept to plain DOM and the injected `globalThis.narrafork` SDK. The iframe
 * is a separate document, so the host's React/Mantine are not available here — a real
 * plugin would bundle whatever it wants, but the contract is exactly this.
 *
 * Note on writes: this view reads config and reports status. It does not write, because
 * the config write endpoint is admin-only and the host owns the save action. A plugin
 * that wants an in-iframe save button would ask the host for one through a command
 * contribution rather than reaching for the HTTP API itself.
 */
(() => {
	const sdk = globalThis.narrafork;
	const root = document.body;

	function line(text, muted) {
		const element = document.createElement("div");
		element.textContent = text;
		element.style.font = "13px/1.6 system-ui, sans-serif";
		element.style.color = muted ? "#8b8b8b" : "#e6e6e6";
		root.appendChild(element);
		return element;
	}

	if (!sdk) {
		// The SDK is installed after the host handshake completes, so its absence means
		// this script ran outside a NarraFork panel.
		line("Plugin UI SDK is unavailable.", true);
		return;
	}

	const heading = document.createElement("div");
	heading.textContent = "Example provider settings";
	heading.style.font = "600 14px/1.8 system-ui, sans-serif";
	heading.style.color = "#e6e6e6";
	root.appendChild(heading);

	const status = line("Loading configuration…", true);

	// `config.get` returns this plugin's non-secret configuration keyed by provider
	// contribution id. Secret values never appear here by design; `secrets.list` reports
	// only whether one is set.
	Promise.all([
		sdk.request("config.get").catch(() => ({})),
		sdk.request("secrets.list").catch(() => ({ secrets: [] })),
	])
		.then(([config, secretStatus]) => {
			const own = config && typeof config === "object" ? config["example-provider"] : undefined;
			const apiMode = own && typeof own === "object" ? own.apiMode : undefined;
			status.textContent = `apiMode: ${apiMode ?? "offline (default)"}`;
			status.style.color = "#e6e6e6";

			const secrets = Array.isArray(secretStatus?.secrets) ? secretStatus.secrets : [];
			line(
				secrets.length > 0
					? `secrets configured: ${secrets.map((entry) => entry.key).join(", ")}`
					: "no secrets configured",
				true,
			);
			line(
				"This panel replaces the host's generated form. Edit apiMode from the plugin's configuration tab.",
				true,
			);
			// Lets the host (and the e2e test) observe that the view reached a usable state.
			sdk.notify("example-provider.settings.ready", { apiMode: apiMode ?? null });
		})
		.catch((error) => {
			status.textContent = `Failed to load configuration: ${String(error)}`;
			status.style.color = "#ff8a8a";
		});
})();
