const MAX_TEXT = 2000;

export function describeSelection(input) {
	const text = typeof input?.text === "string" ? input.text.slice(0, MAX_TEXT) : "";
	return { length: text.length, preview: text.slice(0, 80) };
}

export function openTool() {
	return { opened: true };
}
