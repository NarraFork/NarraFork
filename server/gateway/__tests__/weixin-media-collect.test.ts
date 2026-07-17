import { describe, expect, test } from "bun:test";
import { collectTopLevelMediaItems } from "../platforms/weixin";

const ITEM_TEXT = 1;
const ITEM_IMAGE = 2;
const ITEM_FILE = 4;

describe("collectTopLevelMediaItems", () => {
	test("keeps top-level images/files and ignores quoted ref_msg media", () => {
		const itemList = [
			{
				type: ITEM_TEXT,
				text_item: { text: "继续看这张旧图" },
				ref_msg: {
					title: "old-photo.jpg",
					message_item: {
						type: ITEM_IMAGE,
						image_item: { aeskey: "abc" },
					},
				},
			},
			{
				type: ITEM_IMAGE,
				image_item: { aeskey: "fresh" },
			},
			{
				type: ITEM_TEXT,
				text_item: { text: "再补一个引用文件" },
				ref_msg: {
					title: "legacy.pdf",
					message_item: {
						type: ITEM_FILE,
						file_item: { file_name: "legacy.pdf" },
					},
				},
			},
			{
				type: ITEM_FILE,
				file_item: { file_name: "new.pdf" },
			},
		];

		const media = collectTopLevelMediaItems(itemList);
		expect(media.images).toHaveLength(1);
		expect(media.files).toHaveLength(1);
		expect((media.images[0] as { image_item?: { aeskey?: string } }).image_item?.aeskey).toBe(
			"fresh",
		);
		expect((media.files[0] as { file_item?: { file_name?: string } }).file_item?.file_name).toBe(
			"new.pdf",
		);
	});

	test("returns empty collections when only quoted media is present", () => {
		const itemList = [
			{
				type: ITEM_TEXT,
				text_item: { text: "只是引用" },
				ref_msg: {
					title: "old.png",
					message_item: { type: ITEM_IMAGE, image_item: {} },
				},
			},
		];

		const media = collectTopLevelMediaItems(itemList);
		expect(media.images).toEqual([]);
		expect(media.files).toEqual([]);
	});
});
