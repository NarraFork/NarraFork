import { createRequire } from "node:module";

const browserBuffer = createRequire(import.meta.url).resolve("buffer/");

import type { Plugin } from "vite";
/** Only iconv's Worker dependency gets Buffer; never installs an application/global shim. */
export function editorCodecBuffer(): Plugin {
	return {
		name: "narrafork-editor-codec-buffer",
		enforce: "pre",
		resolveId(source, importer) {
			if (source === "buffer" && importer?.includes("safer-buffer")) return browserBuffer;
			// iconv's optional Node Transform API is not used by its incremental write/end API.
			if (source === "stream" && importer?.includes("iconv-lite"))
				return "\u0000editor-codec-no-node-stream";
		},
		load(id) {
			if (id === "\u0000editor-codec-no-node-stream") return "export default {};";
		},
	};
}
