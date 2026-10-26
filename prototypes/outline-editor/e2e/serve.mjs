import { startServer } from "./server.mjs";

const { url } = await startServer(Number(process.env.PORT ?? 7790));
console.log(`原型页面：${url}  性能模式：${url}?mode=perf&n=2000`);
