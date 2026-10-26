// 静态文件服务（测试与手动试用共用）。只服务 dist/。
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = join(fileURLToPath(new URL(".", import.meta.url)), "..", "dist");
const TYPES = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript",
	".css": "text/css",
	".map": "application/json",
};

export function startServer(port = 0) {
	return new Promise((resolve) => {
		const srv = createServer((req, res) => {
			const url = new URL(req.url ?? "/", "http://x");
			const rel = normalize(url.pathname === "/" ? "/index.html" : url.pathname).replace(
				/^(\.\.[/\\])+/,
				"",
			);
			const file = join(DIST, rel);
			if (!file.startsWith(DIST) || !existsSync(file) || !statSync(file).isFile()) {
				res.writeHead(404);
				res.end("not found");
				return;
			}
			res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
			createReadStream(file).pipe(res);
		});
		srv.listen(port, "127.0.0.1", () =>
			resolve({ srv, url: `http://127.0.0.1:${srv.address().port}/` }),
		);
	});
}
