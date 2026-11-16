// A pi-durable daemon for the bridge's tests: the real harness, socket server and SQLite storage from the daemon
// package under test, with pi-ai's faux model. This file is copied beside a link to that package's node_modules
// before it is imported (test/helpers.ts), so these imports resolve to the daemon's own copies.
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

export { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall };

/** Starts a daemon on `<dir>/d.sock` over `<dir>/harness.sqlite`; a second start on the same dir resumes the first. */
export async function startDaemon(lib: string, dir: string, responses: unknown[], options: { tokensPerSecond?: number } = {}) {
	const { openHarness } = await import(join(lib, "src/harness.ts"));
	const { serve } = await import(join(lib, "src/remote/server.ts"));
	const { createServices } = await import(join(lib, "src/services.ts"));
	const context = BACKGROUND_CONTEXT;
	const faux = fauxProvider(options);
	faux.setResponses(responses as never);
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	const harness = await openHarness({ storage: await openNodeSqliteStorage(join(dir, "harness.sqlite")), models, cwd: dir, context, registry });
	harness.resume();
	const defaultModel = { provider: "faux", modelId: "faux-1" };
	const served = await serve({ harness, path: join(dir, "d.sock"), services: createServices({ harness, registry, models, defaultModel }) });
	let stopped: Promise<void> | undefined;
	return {
		socket: join(dir, "d.sock"),
		harness,
		context,
		stop: () =>
			(stopped ??= (async () => {
				await served.close();
				await harness.close(context);
			})()),
	};
}
