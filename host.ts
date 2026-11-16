import { experimental_defineProviderBridge } from "@get-bb/plugin-sdk/provider-bridge";
import { handleLine } from "./src/bridge.ts";
import { closeDaemon } from "./src/daemon.ts";

// The daemon connection would keep this process alive after bb is gone. Runs in flight continue in the daemon.
const shutdown = () => void closeDaemon().finally(() => process.exit(0));

export const experimental_providerBridge = experimental_defineProviderBridge({
	handleLine,
	onClose: shutdown,
	onSigterm: shutdown,
	onSigint: shutdown,
});
