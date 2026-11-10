import { describe, expect, test } from "bun:test";
import { followIdentityKind } from "./git-identity-follow-label";

const identity = (name: string) => ({ name });

describe("git 身份跟随谁", () => {
	test("文件夹设过身份时跟文件夹，即使存在全局默认", () => {
		expect(followIdentityKind(identity("文件夹身份"), identity("默认身份"))).toBe("folder");
	});

	test("文件夹没设时跟全局默认", () => {
		expect(followIdentityKind(undefined, identity("默认身份"))).toBe("default");
	});

	test("两者都没有时不跟任何具体身份", () => {
		expect(followIdentityKind(null, undefined)).toBe("none");
	});
});
