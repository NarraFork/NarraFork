/**
 * OSC 52 clipboard handler for xterm.js.
 *
 * Intercepts OSC 52 sequences from the terminal output:
 * - Write requests (\x1b]52;c;<base64>\x07) → validated and blocked by default
 * - Read requests (\x1b]52;c;?\x07) → blocked to prevent input corruption
 *
 * Usage: call setupOsc52Handler(terminal) after terminal.open().
 */
import type { Terminal } from "@xterm/xterm";

const MAX_OSC52_DECODED_BYTES = 4 * 1024 * 1024;
const MAX_OSC52_PAYLOAD_CHARS = Math.ceil((MAX_OSC52_DECODED_BYTES / 3) * 4);

/**
 * Attach an OSC 52 handler to the terminal.
 * Returns a dispose function to clean up.
 */
export function setupOsc52Handler(terminal: Terminal): () => void {
	// xterm.js fires onOsc with the OSC number and data string.
	// OSC 52 format: 52;Pc;Pd  where Pc is clipboard selection (c/p/s) and Pd is base64 data or ?
	const disposable = terminal.parser.registerOscHandler(52, (data) => {
		const separatorIndex = data.indexOf(";");
		if (separatorIndex === -1) return false;

		const payload = data.slice(separatorIndex + 1);

		// Read request — block it (responding would inject text into the terminal input).
		if (payload === "?") {
			return true; // handled, don't pass through
		}

		// Write request — keep size/format validation, but do not write to the clipboard silently.
		// Empty payloads are still write attempts and must be consumed.
		if (payload) {
			if (payload.length > MAX_OSC52_PAYLOAD_CHARS) return true;
			try {
				atob(payload);
			} catch {
				// Invalid base64 — ignore while still blocking the OSC 52 sequence.
			}
		}

		return true;
	});

	return () => disposable.dispose();
}
