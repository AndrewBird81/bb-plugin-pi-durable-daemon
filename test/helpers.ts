import { cpSync, existsSync, mkdtempSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	experimental_assembleCapturedThreadEvents as assembleCapturedThreadEvents,
	experimental_createBridgeJsonRpcTestHarness as createBridgeJsonRpcTestHarness,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import type { BridgeJsonRpcObject, BridgeJsonRpcOutputMessage, ThreadEvent } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { handleLine } from "../src/bridge.ts";
import { closeDaemon } from "../src/daemon.ts";
import { PROVIDER_ID } from "../src/vocabulary.ts";

/** The daemon package under test: it must be the version with client services (src/services.ts). */
export const LIB = process.env.PI_DURABLE_DAEMON_LIB ?? join(homedir(), ".nix-profile/lib/pi-durable");
export const HAS_DAEMON = existsSync(join(LIB, "src/services.ts"));
export const SKIP = HAS_DAEMON ? false : `no pi-durable daemon with client services at ${LIB}; set PI_DURABLE_DAEMON_LIB`;

// test/daemon-fixture.ts, which only resolves beside the daemon's node_modules and so is not type-checked here.
type FauxMessage = unknown;
type Fixture = {
	fauxAssistantMessage(content: unknown, options?: { stopReason?: string }): FauxMessage;
	fauxText(text: string): unknown;
	fauxThinking(text: string): unknown;
	fauxToolCall(name: string, args: Record<string, unknown>): unknown;
	startDaemon(lib: string, dir: string, responses: unknown[], options?: { tokensPerSecond?: number }): Promise<{ socket: string; stop(): Promise<void> }>;
};
let fixture: Promise<Fixture> | undefined;
export function loadFixture(): Promise<Fixture> {
	fixture ??= (async () => {
		const dir = mkdtempSync(join(tmpdir(), "pdd-fixture-"));
		symlinkSync(join(LIB, "node_modules"), join(dir, "node_modules"));
		cpSync(new URL("./daemon-fixture.ts", import.meta.url), join(dir, "daemon-fixture.ts"));
		return (await import(pathToFileURL(join(dir, "daemon-fixture.ts")).href)) as Fixture;
	})();
	return fixture;
}

export const OPTIONS = {
	model: "faux/faux-1",
	reasoningLevel: "medium",
	permissionMode: "full",
	permissionScope: "full",
	approvalReviewer: null,
	permissionEscalation: null,
};
/** A client request id in bb's format: `creq_` and ten characters of its alphabet. */
let requestIds = 0;
export const creq = (): string => `creq_${(++requestIds).toString(8).replace(/[01]/g, (digit) => (digit === "0" ? "a" : "b")).padStart(10, "z")}`;
export const text = (value: string): BridgeJsonRpcObject[] => [{ type: "text", text: value, mentions: [] }];

/** One bridge under test, pointed at one daemon directory. */
export async function withBridge(
	responses: (f: Fixture) => unknown[],
	run: (t: Awaited<ReturnType<typeof openBridge>>) => Promise<void>,
	options: { tokensPerSecond?: number } = {},
): Promise<void> {
	const t = await openBridge(responses, options);
	try {
		await run(t);
	} finally {
		await t.close();
	}
}

async function openBridge(responses: (f: Fixture) => unknown[], options: { tokensPerSecond?: number }) {
	const f = await loadFixture();
	const dir = mkdtempSync(join(tmpdir(), "pdd-test-"));
	let daemon = await f.startDaemon(LIB, dir, responses(f), options);
	process.env.PI_DURABLE_DAEMON_LIB = LIB;
	process.env.PI_DURABLE_SOCKET = daemon.socket;
	const harness = createBridgeJsonRpcTestHarness(handleLine);
	let requests = 0;

	const request = async (method: string, params: BridgeJsonRpcObject): Promise<BridgeJsonRpcOutputMessage> => {
		const id = `t-${++requests}`;
		harness.sendRequest(id, method, params);
		return harness.waitForResponse(id);
	};
	const ok = async (method: string, params: BridgeJsonRpcObject): Promise<Record<string, unknown>> => {
		const response = await request(method, params);
		if (response.error !== undefined) throw new Error(`${method} answered ${JSON.stringify(response.error)}`);
		return response.result as Record<string, unknown>;
	};
	const events = (): ThreadEvent[] => assembleCapturedThreadEvents(harness.messages as never, PROVIDER_ID);
	const until = async (check: () => boolean, what: string, ms = 10_000): Promise<void> => {
		const end = Date.now() + ms;
		while (!check()) {
			if (Date.now() > end) throw new Error(`timed out waiting for ${what}; events: ${events().map((event) => event.type).join(", ")}`);
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	};
	const turnsEnded = () => events().filter((event) => event.type === "turn/completed").length;

	return {
		dir,
		harness,
		request,
		ok,
		events,
		until,
		turnsEnded,
		get daemon() {
			return daemon;
		},
		async start(threadId: string, extra: BridgeJsonRpcObject = {}): Promise<string> {
			const result = await ok("thread/start", { threadId, cwd: dir, instructionMode: "append", options: OPTIONS, ...extra });
			return result.providerThreadId as string;
		},
		/** Sends one turn and waits for it to end. */
		async turn(threadId: string, providerThreadId: string, prompt: string): Promise<void> {
			const before = turnsEnded();
			await ok("turn/start", { threadId, providerThreadId, clientRequestId: creq(), input: text(prompt), options: OPTIONS });
			await until(() => turnsEnded() > before, `the turn "${prompt}" to end`);
		},
		async restartDaemon(next: unknown[]): Promise<void> {
			await daemon.stop();
			daemon = await f.startDaemon(LIB, dir, next, options);
		},
		async close(): Promise<void> {
			harness.restore();
			await closeDaemon();
			await daemon.stop();
		},
	};
}
