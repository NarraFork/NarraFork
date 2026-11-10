import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { StepUpMethod } from "../../lib/api/auth";

// Shared by credential transfer and data export with providers: the passphrase seals the
// file, the password and second factor are the step-up the server requires.

const originalAuthApi = { ...(await import("../../lib/api/auth")) };
const originalI18n = { ...(await import("react-i18next")) };
let methods: StepUpMethod[] = ["totp", "backup_code"];
const stepUpCalls: unknown[] = [];
mock.module("react-i18next", () => ({
	...originalI18n,
	useTranslation: () => ({ t: (key: string) => key }),
}));
mock.module("../../lib/api/auth", () => ({
	...originalAuthApi,
	authApi: {
		...originalAuthApi.authApi,
		stepUpMethods: async () => ({ methods }),
		stepUp: async (input: unknown) => {
			stepUpCalls.push(input);
			return { token: "nfsu_grant", expiresAt: Date.now() + 60_000 };
		},
	},
}));
const { StepUpFields, useStepUpFields } = await import("./StepUpFields");

let root: Root | null = null;
let container: HTMLElement;
let client: QueryClient;
let latest: ReturnType<typeof useStepUpFields> | null = null;
const globals = new Map<string, PropertyDescriptor | undefined>();
function install(key: string, value: unknown) {
	globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
	Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
}

function Harness() {
	const fields = useStepUpFields(true);
	latest = fields;
	return <StepUpFields fields={fields} />;
}

beforeEach(() => {
	methods = ["totp", "backup_code"];
	stepUpCalls.length = 0;
	latest = null;
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	// Mantine's SegmentedControl measures its indicator through `window.getComputedStyle`;
	// linkedom has no layout, so it gets the same stub provider-add-routing.test.tsx uses.
	Object.defineProperty(window, "getComputedStyle", {
		value: () => ({ getPropertyValue: () => "", overflow: "visible" }),
		configurable: true,
	});
	install("window", window);
	install(
		"getComputedStyle",
		(window as unknown as { getComputedStyle: unknown }).getComputedStyle,
	);
	install(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
	install("requestAnimationFrame", (callback: (time: number) => void) =>
		setTimeout(() => callback(Date.now()), 0),
	);
	install("cancelAnimationFrame", (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
	install("document", window.document);
	install("navigator", window.navigator);
	install("HTMLElement", window.HTMLElement);
	install("Element", window.Element);
	install("Node", window.Node);
	install("IS_REACT_ACT_ENVIRONMENT", true);
	// linkedom has none; Mantine's SegmentedControl only uses it to re-measure its indicator.
	install(
		"MutationObserver",
		class {
			observe() {}
			disconnect() {}
			takeRecords() {
				return [];
			}
		},
	);
	install("matchMedia", () => ({
		matches: false,
		addEventListener() {},
		removeEventListener() {},
		addListener() {},
		removeListener() {},
	}));
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	container = window.document.createElement("div") as unknown as HTMLElement;
	window.document.body.appendChild(container);
});
afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	container.remove();
	client.clear();
	for (const [key, descriptor] of globals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	globals.clear();
});
afterAll(() => mock.restore());

async function render() {
	root = createRoot(container);
	await act(async () =>
		root?.render(
			<MantineProvider>
				<QueryClientProvider client={client}>
					<Harness />
				</QueryClientProvider>
			</MantineProvider>,
		),
	);
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 15));
	});
}

const fill = async (patch: Partial<ReturnType<typeof useStepUpFields>["state"]>) =>
	act(async () => latest?.setState((prev) => ({ ...prev, ...patch })));

describe("StepUpFields", () => {
	test("ready only with a long enough, confirmed passphrase, the password and a code", async () => {
		await render();
		expect(latest?.ready).toBe(false);
		await fill({ passphrase: "short", confirmation: "short", password: "pw", code: "123456" });
		expect(latest?.ready).toBe(false);
		await fill({ passphrase: "long enough phrase", confirmation: "long enough phrasX" });
		expect(latest?.ready).toBe(false);
		await fill({ confirmation: "long enough phrase" });
		expect(latest?.ready).toBe(true);
		await fill({ code: "" });
		expect(latest?.ready).toBe(false);
	});

	test("verify sends the purpose, password and code; clearCode spends the code", async () => {
		await render();
		await fill({
			passphrase: "long enough phrase",
			confirmation: "long enough phrase",
			password: "pw",
			code: " 123456 ",
		});
		await act(async () => {
			await latest?.verify("storage.export.providers");
		});
		expect(stepUpCalls).toEqual([
			{ purpose: "storage.export.providers", password: "pw", method: "totp", code: "123456" },
		]);
		await act(async () => latest?.clearCode());
		expect(latest?.state.code).toBe("");
		expect(latest?.state.passphrase).toBe("long enough phrase");
	});

	test("an account without a second factor is told so and can never be ready", async () => {
		methods = [];
		await render();
		expect(latest?.noSecondFactor).toBe(true);
		expect(container.textContent).toContain("errors:STEP_UP_MFA_REQUIRED");
		await fill({
			passphrase: "long enough phrase",
			confirmation: "long enough phrase",
			password: "pw",
			code: "123456",
		});
		expect(latest?.ready).toBe(false);
	});
});
