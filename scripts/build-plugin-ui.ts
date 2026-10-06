/** Usage: bun scripts/build-plugin-ui.ts <entry.tsx> <panel.iife.js> [--development]
 * Run standalone, never inside Vite. Declare CSS in the plugin manifest, not imports.
 * This is a repository pilot, not the external SDK CLI.
 */
import { resolve } from "node:path";
import { buildPluginUi } from "../frontend/build/plugin-ui-bun";

const [entry, output, mode, ...extra] = process.argv.slice(2);
if (!entry || !output || (mode && mode !== "--development") || extra.length) {
	console.error(
		"Usage: bun scripts/build-plugin-ui.ts <entry.tsx> <panel.iife.js> [--development]",
	);
	process.exit(1);
}
if (resolve(entry) === resolve(output) || !output.endsWith(".iife.js")) {
	console.error("Output must be a separate .iife.js file");
	process.exit(1);
}
// A hard deadline belongs to this disposable CLI process, not the host server.
const deadline = setTimeout(() => {
	console.error("Plugin UI build timed out after 60000ms");
	process.exit(1);
}, 60_000);
try {
	const artifact = await buildPluginUi(resolve(entry), { development: mode === "--development" });
	await Bun.write(resolve(output), artifact);
	console.info(`Built plugin UI IIFE (${artifact.size} bytes). CSS must be declared separately.`);
} catch (error) {
	console.error(String(error).slice(0, 16_384));
	process.exitCode = 1;
} finally {
	clearTimeout(deadline);
}
