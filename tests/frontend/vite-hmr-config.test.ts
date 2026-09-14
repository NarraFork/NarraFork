import { describe, expect, test } from "bun:test";
import viteConfig from "../../frontend/vite.config";

const config = await viteConfig({ command: "serve", mode: "production" });
const server = config.server as {
	port?: number;
	strictPort?: boolean;
	hmr?: { clientPort?: number };
};

describe("Vite HMR reverse-proxy configuration", () => {
	test("uses the configured client port and disables localhost direct fallback", () => {
		expect(server.strictPort).toBe(true);
		expect(server.hmr?.clientPort).toBe(server.port);
	});
});
