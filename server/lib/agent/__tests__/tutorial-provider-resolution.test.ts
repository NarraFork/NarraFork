/**
 * `tutorial:` is a RESERVED provider prefix.
 *
 * The interactive tutorial routes real narrator sessions through
 * `TutorialProvider` so scripted turns never contact an AI API. That guarantee
 * rests entirely on where the branch sits in `createProviderByName`: it is checked
 * before every configured provider and before the plugin resolver, so nothing a
 * user or plugin configures can claim the prefix.
 *
 * If that ordering regressed, tutorial traffic would resolve to a real upstream
 * and be billed — with no error anywhere, because a working provider answering a
 * tutorial prompt looks like a working tutorial.
 *
 * Deliberately a separate file from `provider-resolution.test.ts`: that suite
 * process-wide-mocks every provider module to `MockProvider`, so an
 * `instanceof TutorialProvider` assertion there would prove nothing.
 */

import { describe, expect, test } from "bun:test";
import { TUTORIAL_PROVIDER_PREFIX } from "@shared/tutorial/lessons";
import { getVisibleModels } from "../../settings";
import { registerExternalProviderResolver, resolveProviderAndModel } from "../provider";
import { TutorialProvider, tutorialModelForLesson } from "../tutorial-provider";

describe("tutorial provider resolution", () => {
	test("a tutorial model resolves to the scripted provider", () => {
		const resolved = resolveProviderAndModel(tutorialModelForLesson("first-turn", "en"));
		expect(resolved.provider).toBe(TUTORIAL_PROVIDER_PREFIX);
		expect(resolved.adapter).toBeInstanceOf(TutorialProvider);
	});

	test("the lesson and locale survive resolution unchanged", () => {
		// The model value is the only carrier for lesson + locale (ChatParams has no
		// locale field). If resolution rewrote the model — as it does when falling
		// back to a different provider — the provider would lose both and every
		// lesson would play the no-script line in English.
		const model = tutorialModelForLesson("first-turn", "zh-CN");
		expect(resolveProviderAndModel(model).model).toBe(model);
	});

	test("a plugin cannot shadow the tutorial prefix", () => {
		let pluginResolverCalls = 0;
		const unregister = registerExternalProviderResolver(() => {
			pluginResolverCalls += 1;
			return {} as never;
		});
		try {
			const resolved = resolveProviderAndModel(`${TUTORIAL_PROVIDER_PREFIX}:guide/first-turn/en`);
			expect(resolved.adapter).toBeInstanceOf(TutorialProvider);
			expect(pluginResolverCalls).toBe(0);
		} finally {
			unregister();
		}
	});

	test("a bare tutorial model still resolves", () => {
		// Legacy or hand-edited narrator rows must not become unusable: the provider
		// answers with its no-script line rather than resolution throwing.
		const resolved = resolveProviderAndModel(`${TUTORIAL_PROVIDER_PREFIX}:guide`);
		expect(resolved.adapter).toBeInstanceOf(TutorialProvider);
	});

	test("resolution needs no configured provider and no model source", () => {
		// The tutorial model is deliberately NOT registered with
		// `registerExtraModelSource`, so it never appears in the normal model pickers
		// where a user could select it for real work. This asserts resolution does not
		// secretly depend on that registration.
		expect(
			getVisibleModels().some((model) => model.startsWith(`${TUTORIAL_PROVIDER_PREFIX}:`)),
		).toBe(false);
		expect(
			resolveProviderAndModel(tutorialModelForLesson("first-turn", "en")).adapter,
		).toBeInstanceOf(TutorialProvider);
	});
});
