import { expect, test } from "bun:test";
import { getMentionQuery } from "./MentionPopover";

function query(text: string) {
	return getMentionQuery(text, text.length);
}

test("mention search uses Unicode folding and a 32-code-point bound", () => {
	expect(query("你好，@小明")).toBe("小明");
	expect(query("@E\u0301quipe")).toBe("équipe");
	expect(query(`@${"𐐀".repeat(32)}`)).toBe("𐐨".repeat(32));
	expect(query(`@${"𐐀".repeat(33)}`)).toBeNull();
	expect(query("@")).toBe("");
	expect(query("mail@example")).toBeNull();
	expect(query("@invalid space")).toBeNull();
});
