// @hutch cli=0.27.0-canary.8 cottontail=0.7.0-canary.10
/**
 * Hutch toolchain configuration for the Electrobun desktop shell.
 *
 * Versions are pinned so a desktop build is reproducible: Electrobun 2.x is still in beta and
 * its packaging layout has been changing between releases.
 *
 * The pragma pins the exact Hutch/Cottontail pair that Electrobun 2.0.2-beta.27 was released
 * against (`hutch-artifacts.json` in that GitHub release names Hutch 0.27.0-canary.8; the
 * matching build-time Cottontail is 0.7.0-canary.10, as in upstream `kitchen/hutch.config.ts`).
 * Hutch keeps releases side by side, so this pin is independent of the machine-wide selection.
 */
export default {
	electrobun: {
		version: "2.0.2-beta.27",
	},
	packageManager: "bun",
	scripts: {
		// `production` was retired as an Electrobun build environment and is not an alias; the
		// release channels are `dev`, `canary`, and `stable`.
		build: ["hutch", "electrobun", "build", "--env=stable"],
		dev: ["hutch", "electrobun", "dev"],
	},
};
