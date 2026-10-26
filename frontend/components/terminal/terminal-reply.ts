/**
 * Device reports the server headless buffer already writes back to the PTY.
 *
 * xterm.js 5.5 parses `term.write()` on a later turn, so a flag held only for
 * the synchronous call never sees these replies. Both panels drop them by
 * shape. Arrow keys, focus reports (`CSI I` / `CSI O`), and OSC color replies
 * stay: the headless terminal does not emit those, and the browser is their
 * only responder.
 */

const ESC = 0x1b;

function readInt(data: string, index: number): number {
	if (index >= data.length) return -1;
	const digit = data.charCodeAt(index);
	if (digit < 48 || digit > 57) return -1;
	let i = index + 1;
	while (i < data.length) {
		const code = data.charCodeAt(i);
		if (code < 48 || code > 57) break;
		i++;
	}
	return i;
}

/** `digits (; digits)*` starting at `index`. Returns the index after the list. */
function readNumberList(data: string, index: number): number {
	let i = readInt(data, index);
	if (i < 0) return -1;
	while (i < data.length && data.charCodeAt(i) === 59) {
		const next = readInt(data, i + 1);
		if (next < 0) return -1;
		i = next;
	}
	return i;
}

/** CPR: `CSI [?] row ; col R`, exactly two numbers. */
function isCursorReport(data: string): boolean {
	let i = 2;
	if (data.charCodeAt(i) === 63) i++;
	const rowEnd = readInt(data, i);
	if (rowEnd < 0 || data.charCodeAt(rowEnd) !== 59) return false;
	const colEnd = readInt(data, rowEnd + 1);
	return colEnd === data.length - 1 && data.charCodeAt(colEnd) === 82;
}

/** DA1 / DA2: `CSI ? … c` or `CSI > … c`. */
function isDeviceAttributes(data: string): boolean {
	const marker = data.charCodeAt(2);
	if (marker !== 63 && marker !== 62) return false;
	const end = readNumberList(data, 3);
	return end === data.length - 1 && data.charCodeAt(end) === 99;
}

/** DECRPM: `CSI [?] mode ; value $ y`, exactly two numbers. */
function isModeReport(data: string): boolean {
	if (data.charCodeAt(data.length - 1) !== 121 || data.charCodeAt(data.length - 2) !== 36) {
		return false;
	}
	let i = 2;
	if (data.charCodeAt(i) === 63) i++;
	const modeEnd = readInt(data, i);
	if (modeEnd < 0 || data.charCodeAt(modeEnd) !== 59) return false;
	const valueEnd = readInt(data, modeEnd + 1);
	return valueEnd === data.length - 2;
}

/** DECRQSS: `DCS 1 $ r … ST` or `DCS 0 $ r ST`. */
function isStatusStringReport(data: string): boolean {
	if (data.charCodeAt(1) !== 80) return false;
	if (data.charCodeAt(data.length - 2) !== ESC || data.charCodeAt(data.length - 1) !== 92) {
		return false;
	}
	return data.startsWith("\x1bP1$r") || data.startsWith("\x1bP0$r");
}

export function isHeadlessTerminalReply(data: string): boolean {
	if (data.length < 4 || data.charCodeAt(0) !== ESC) return false;
	if (data === "\x1b[0n") return true;
	if (data.charCodeAt(1) === 80) return isStatusStringReport(data);
	if (data.charCodeAt(1) !== 91) return false;
	return isCursorReport(data) || isDeviceAttributes(data) || isModeReport(data);
}
