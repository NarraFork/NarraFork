import { describe, expect, test } from "bun:test";
import {
	buildRevealUri,
	claimRevealToken,
	issueRevealToken,
	parseRevealActivation,
	REVEAL_SERVER_FLAG,
} from "../reveal-protocol";
import { revealHandlerCommand } from "../reveal-protocol-registration";

describe("reveal protocol tokens", () => {
	test("a token reveals its path exactly once", () => {
		const target = { path: "C:\\work\\repo", selectFile: false };
		const token = issueRevealToken(target);
		expect(claimRevealToken(token)).toEqual(target);
		expect(claimRevealToken(token)).toBeNull();
	});

	test("an expired token reveals nothing", () => {
		const token = issueRevealToken({ path: "C:\\work\\repo", selectFile: false }, 0);
		expect(claimRevealToken(token, 10_000)).toBeNull();
	});

	test("an unknown token reveals nothing", () => {
		expect(claimRevealToken("nope")).toBeNull();
	});
});

describe("parseRevealActivation", () => {
	const server = `${REVEAL_SERVER_FLAG}http://127.0.0.1:7779`;

	test("ordinary startup is not an activation", () => {
		expect(parseRevealActivation(["narrafork.exe", "--port=7779"])).toBeNull();
	});

	test("reads the token from the URI and the server from the registered flag", () => {
		const argv = ["narrafork.exe", server, buildRevealUri("abc_123")];
		expect(parseRevealActivation(argv)).toEqual({
			token: "abc_123",
			server: "http://127.0.0.1:7779",
		});
	});

	test("tolerates the trailing slash some shells append", () => {
		expect(parseRevealActivation(["x", server, "narrafork://reveal/abc/"])?.token).toBe("abc");
	});

	test("any other narrafork:// URI is an activation with no token", () => {
		expect(parseRevealActivation(["x", server, "NarraFork://reveal?path=C:\\Windows"])).toEqual({
			token: "",
			server: "http://127.0.0.1:7779",
		});
	});
});

describe("revealHandlerCommand", () => {
	test("compiled exe: the exe itself handles the URI", () => {
		expect(revealHandlerCommand("http://127.0.0.1:7779", "C:\\apps\\narrafork.exe", null)).toBe(
			'"C:\\apps\\narrafork.exe" "--reveal-server=http://127.0.0.1:7779" "%1"',
		);
	});

	test("from source: bun runs the entry script", () => {
		expect(
			revealHandlerCommand("http://127.0.0.1:7779", "C:\\bun\\bun.exe", "C:\\nf\\server\\index.ts"),
		).toBe(
			'"C:\\bun\\bun.exe" "C:\\nf\\server\\index.ts" "--reveal-server=http://127.0.0.1:7779" "%1"',
		);
	});
});
