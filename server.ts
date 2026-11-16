import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { PROVIDER_ID, REASONING_LEVELS } from "./src/vocabulary.ts";

export default function plugin(bb: BbPluginApi) {
	bb.providers.register({
		id: PROVIDER_ID,
		displayName: "Pi Durable",
		icon: "Database",
		strings: {
			signInHint: "Models and logins are the pi-durable daemon's: run `pi` on the machine to sign in.",
			expiredHint: "A login of the pi-durable daemon expired. Run `pi` on the machine, then reload.",
			installUrl: "https://github.com/AndrewBird81/bb-plugin-pi-durable-daemon",
		},
		// Shown only on hosts where the daemon's client is installed (provider/health).
		experimental_visibility: "installed",
		maintenance: { health: true, usage: false, installation: false },
		capabilities: {
			supportsServiceTier: false,
			supportsNativeUserQuestion: false,
			fork: "none",
			supportsManualCompaction: false,
			supportsThreadArchive: false,
			supportsThreadRename: false,
			permissionModes: ["full"],
			reasoningLevels: REASONING_LEVELS.map((level) => level.id),
		},
		reasoningLevels: REASONING_LEVELS.map((level) => ({ id: level.id, label: level.label })),
		composerActions: [],
		// The daemon's model list is per host: each host's daemon has its own logins.
		models: { fallback: [], scope: "host" },
	});
}
