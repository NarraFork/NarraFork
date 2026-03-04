import { describe, expect, it } from "bun:test";
import {
	decideContainerProxyRuntimeAction,
	type ProxyRuntimeAction,
} from "../../../server/services/container-proxy";

describe("decideContainerProxyRuntimeAction", () => {
	const cases: Array<{
		name: string;
		current: { running: boolean; port: number | null };
		desired: { enabled: boolean; port: number };
		expected: ProxyRuntimeAction;
	}> = [
		{
			name: "disabled and not running -> noop",
			current: { running: false, port: null },
			desired: { enabled: false, port: 7780 },
			expected: "noop",
		},
		{
			name: "disabled and running -> stop",
			current: { running: true, port: 7780 },
			desired: { enabled: false, port: 7780 },
			expected: "stop",
		},
		{
			name: "enabled and not running -> start",
			current: { running: false, port: null },
			desired: { enabled: true, port: 7780 },
			expected: "start",
		},
		{
			name: "enabled and running same port -> noop",
			current: { running: true, port: 7780 },
			desired: { enabled: true, port: 7780 },
			expected: "noop",
		},
		{
			name: "enabled and running different port -> restart",
			current: { running: true, port: 7780 },
			desired: { enabled: true, port: 7781 },
			expected: "restart",
		},
		{
			name: "enabled and running but unknown port -> restart",
			current: { running: true, port: null },
			desired: { enabled: true, port: 7780 },
			expected: "restart",
		},
	];

	for (const c of cases) {
		it(c.name, () => {
			expect(decideContainerProxyRuntimeAction(c.current, c.desired)).toBe(c.expected);
		});
	}
});
