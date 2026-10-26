import type { BundledLanguage } from "shiki";
import { createWorkerShiki, type ShikiModule } from "./shiki-loader";
import {
	normalizeThemedTokens,
	type ShikiTokenWorkerRequest,
	type ShikiTokenWorkerResponse,
} from "./shiki-token-worker-protocol";

// TextMate tokenization of inline code/diff bodies runs here, never on the UI thread.
const scope = globalThis as unknown as {
	postMessage(packet: ShikiTokenWorkerResponse): void;
	onmessage: ((event: MessageEvent<ShikiTokenWorkerRequest>) => void) | null;
};

let assetBase = "";
let shiki: Promise<ShikiModule> | null = null;

function getShiki(): Promise<ShikiModule> {
	if (!shiki) {
		const attempt = createWorkerShiki(assetBase);
		shiki = attempt;
		// A failed boot must not stick: the next request retries.
		attempt.catch(() => {
			if (shiki === attempt) shiki = null;
		});
	}
	return shiki;
}

async function highlight(request: Extract<ShikiTokenWorkerRequest, { type: "tokens" }>) {
	try {
		const module = await getShiki();
		if (!(request.lang in module.bundledLanguages)) {
			scope.postMessage({ type: "tokens", id: request.id, tokens: null });
			return;
		}
		const result = await module.codeToTokens(request.code, {
			lang: request.lang as BundledLanguage,
			theme: request.theme,
		});
		scope.postMessage({
			type: "tokens",
			id: request.id,
			tokens: normalizeThemedTokens(result.tokens),
		});
	} catch (error) {
		scope.postMessage({
			type: "error",
			id: request.id,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

scope.onmessage = (event) => {
	const request = event.data;
	if (request.type === "boot") {
		assetBase = request.assetBase;
		return;
	}
	void highlight(request);
};
