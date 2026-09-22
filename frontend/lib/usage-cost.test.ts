import { describe, expect, test } from "bun:test";
import { formatReferenceCost, referenceCostStatus } from "./usage-cost";

const labels = { unknown: "未定价", partial: "已知部分" };
describe("reference cost completeness display", () => {
	test("unknown numeric zero never appears to be free", () => {
		expect(formatReferenceCost({ costStatus: "unknown" }, 0, labels)).toBe("未定价");
	});
	test("a partial subtotal stays incomplete including a zero known subtotal", () => {
		expect(formatReferenceCost({ costStatus: "partial" }, 0, labels)).toBe("$0.000000 (已知部分)");
		expect(formatReferenceCost({ costStatus: "partial" }, 2, labels)).toBe("$2.000000 (已知部分)");
	});
	test("an explicit complete zero is free", () => {
		expect(formatReferenceCost({ costStatus: "complete" }, 0, labels)).toBe("$0.000000");
	});
	test("historical amounts are not reclassified or re-priced", () => {
		expect(formatReferenceCost({}, 0.125, labels)).toBe("$0.125000");
		expect(formatReferenceCost({}, 0, labels)).toBe("$0.000000");
		expect(formatReferenceCost({}, null, labels)).toBe("未定价");
	});
	test("aggregates and compact numbers preserve completeness", () => {
		expect(referenceCostStatus({ unpricedRequestCount: 2 }, 9)).toBe("partial");
		expect(formatReferenceCost({ costIsPartial: true }, 1200, labels, "$1.2K")).toBe(
			"$1.2K (已知部分)",
		);
	});
});
