import { afterEach, describe, expect, test } from "bun:test";
import { applyUpdate } from "../update-client";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

const apply = () => applyUpdate("http://127.0.0.1:7779", "test-token", "1.2.3", "a".repeat(64));

function respond(body: unknown, status = 200): void {
	globalThis.fetch = (async () => Response.json(body, { status })) as unknown as typeof fetch;
}

describe("manager applyUpdate", () => {
	test("HTTP 200 的业务失败不能当成已排程", async () => {
		for (const error of [
			"No verified prepared update file found",
			"System shutdown preparation is already scheduled",
		]) {
			respond({ success: false, error });
			expect(await apply()).toEqual({ success: false, error });
		}
	});

	test("只有显式 success true 才接受排程", async () => {
		for (const body of [{}, { success: "true" }, { restarting: true }]) {
			respond(body);
			expect(await apply()).toEqual({ success: false, error: "Update was not accepted" });
		}
		respond({ success: true, restarting: true });
		expect(await apply()).toEqual({ success: true });
	});

	test("身份冲突仍保留服务端错误", async () => {
		respond({ success: false, error: "Prepared update changed" }, 409);
		expect(await apply()).toEqual({ success: false, error: "Prepared update changed" });
	});

	test("HTTP 错误不会被 success true 绕过", async () => {
		respond({ success: true }, 503);
		expect(await apply()).toEqual({ success: false, error: "HTTP 503" });
	});

	test("损坏的响应不证明更新已排程", async () => {
		globalThis.fetch = (async () => new Response("not json")) as unknown as typeof fetch;
		expect((await apply()).success).toBe(false);
	});

	test("网络失败不伪装成替换进程已经启动", async () => {
		globalThis.fetch = (async () => {
			throw new Error("Connection refused");
		}) as unknown as typeof fetch;
		expect(await apply()).toEqual({ success: false, error: "Connection refused" });
	});
});
