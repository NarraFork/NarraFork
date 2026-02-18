/**
 * OSC 52 clipboard handler for xterm.js.
 *
 * Intercepts OSC 52 sequences from the terminal output:
 * - Write requests (\x1b]52;c;<base64>\x07) → writes to system clipboard
 * - Read requests (\x1b]52;c;?\x07) → blocked to prevent input corruption
 *
 * Usage: call setupOsc52Handler(terminal) after terminal.open().
 */
import type { Terminal } from "@xterm/xterm";

/**
 * Attach an OSC 52 handler to the terminal.
 * Returns a dispose function to clean up.
 */
export function setupOsc52Handler(terminal: Terminal): () => void {
	// xterm.js fires onOsc with the OSC number and data string.
	// OSC 52 format: 52;Pc;Pd  where Pc is clipboard selection (c/p/s) and Pd is base64 data or ?
	const disposable = terminal.parser.registerOscHandler(52, (data) => {
		const parts = data.split(";");
		if (parts.length < 2) return false;

		const payload = parts.slice(1).join(";");

		// Read request — block it (responding would inject text into the terminal input)
		if (payload === "?") {
			return true; // handled, don't pass through
		}

		// Write request — decode base64 and write to clipboard
		if (payload) {
			try {
				const decoded = atob(payload);
				navigator.clipboard.writeText(decoded).catch(() => {
					// Clipboard write failed (e.g. not focused, permissions denied)
				});
			} catch {
				// Invalid base64 — ignore
			}
			return true;
		}

		return false;
	});

	return () => disposable.dispose();
}
