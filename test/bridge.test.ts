// The bridge against a real pi-durable daemon (faux model) over its socket, read through bb's own delta assembler.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	experimental_captureBridgeJsonRpcOutput as captureBridgeJsonRpcOutput,
	experimental_formatConformanceReport as formatConformanceReport,
	experimental_runBridgeConformance as runBridgeConformance,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import type { ThreadEvent } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { handleLine } from "../src/bridge.ts";
import { closeDaemon } from "../src/daemon.ts";
import { PROVIDER_ID } from "../src/vocabulary.ts";
import { LIB, OPTIONS, SKIP, creq, loadFixture, text, withBridge } from "./helpers.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Canonical items as bb's assembler builds them; read loosely, since their types are bb's, not this plugin's.
type Item = Record<string, any>;
const completed = (events: ThreadEvent[]): Item[] =>
	events.filter((event) => event.type === "item/completed").map((event) => (event as { item: Item }).item);
const ofType = (items: Item[], type: string): Item[] => items.filter((item) => item.type === type);
const turnEnds = (events: ThreadEvent[]) =>
	events.filter((event): event is Extract<ThreadEvent, { type: "turn/completed" }> => event.type === "turn/completed");

test("passes bb's protocol conformance suite", { skip: SKIP }, async () => {
	const f = await loadFixture();
	const dir = mkdtempSync(join(tmpdir(), "pdd-conformance-"));
	const daemon = await f.startDaemon(LIB, dir, Array.from({ length: 40 }, () => f.fauxAssistantMessage("hello")));
	process.env.PI_DURABLE_DAEMON_LIB = LIB;
	process.env.PI_DURABLE_SOCKET = daemon.socket;
	const output = captureBridgeJsonRpcOutput();
	try {
		const report = await runBridgeConformance({
			transport: { send: handleLine, takeMessages: output.takeMessages },
			providerId: PROVIDER_ID,
			session: { cwd: dir, promptInput: text("say hello") as never },
			timeoutMs: 5_000,
		});
		output.restore();
		const failed = report.results.filter((result) => result.status === "fail");
		assert.deepEqual(failed, [], formatConformanceReport(report));
		assert.equal(report.passed, true);
	} finally {
		output.restore();
		await closeDaemon();
		await daemon.stop();
	}
});

test("a turn streams thinking and text, runs tools in the thread's cwd, and ends completed", { skip: SKIP }, () =>
	withBridge(
		(f) => [
			f.fauxAssistantMessage(
				[f.fauxThinking("considering"), f.fauxText("Running it."), f.fauxToolCall("bash", { command: "pwd; echo line-2" }), f.fauxToolCall("read", { path: "note.txt" })],
				{ stopReason: "toolUse" },
			),
			f.fauxAssistantMessage("All done."),
		],
		async (t) => {
			writeFileSync(join(t.dir, "note.txt"), "a note\n");
			const providerThreadId = await t.start("thr_stream");
			assert.match(providerThreadId, /^[0-9a-f-]{36}:\d+$/);
			await t.turn("thr_stream", providerThreadId, "go");

			const events = t.events();
			const items = completed(events);
			assert.deepEqual(ofType(items, "agentMessage").map((item) => item.text), ["Running it.", "All done."]);
			assert.deepEqual(ofType(items, "reasoning").map((item) => item.content.join("")), ["considering"]);
			const [command] = ofType(items, "commandExecution");
			assert.equal(command!.command, "pwd; echo line-2");
			assert.match(command!.aggregatedOutput ?? "", new RegExp(`${t.dir.split("/").pop()}\\nline-2`));
			assert.equal(command!.exitCode, 0);
			assert.deepEqual(ofType(items, "fileRead").map((item) => [item.path, item.status]), [["note.txt", "completed"]]);
			assert.deepEqual(turnEnds(events).map((event) => event.status), ["completed"]);
			assert.ok(events.some((event) => event.type === "thread/tokenUsage/updated"), "usage is reported");
		},
	));

test("interrupt settles the turn before the stop is answered, and the thread resumes afterwards", { skip: SKIP }, () =>
	withBridge(
		(f) => [f.fauxAssistantMessage(`slow ${"word ".repeat(400)}`), f.fauxAssistantMessage("after the stop")],
		async (t) => {
			const providerThreadId = await t.start("thr_stop");
			await t.ok("turn/start", { threadId: "thr_stop", providerThreadId, clientRequestId: creq(), input: text("long"), options: OPTIONS });
			await t.until(() => t.events().some((event) => event.type === "item/agentMessage/delta"), "the answer to start streaming");

			await t.ok("thread/stop", { threadId: "thr_stop", providerThreadId, intent: "interrupt", activeTurnId: null });
			assert.deepEqual(turnEnds(t.events()).map((event) => event.status), ["interrupted"], "settled when thread/stop returned");

			await t.ok("thread/resume", { threadId: "thr_stop", providerThreadId, cwd: t.dir, instructionMode: "append", options: OPTIONS });
			await t.turn("thr_stop", providerThreadId, "again");
			assert.equal(ofType(completed(t.events()), "agentMessage").at(-1)!.text, "after the stop");
			assert.equal(turnEnds(t.events()).at(-1)!.status, "completed");
		},
		{ tokensPerSecond: 40 },
	));

test("a steer goes into the running turn: one turn, both inputs accepted", { skip: SKIP }, () =>
	withBridge(
		(f) => [f.fauxAssistantMessage(`slow ${"word ".repeat(120)}`), f.fauxAssistantMessage("steered")],
		async (t) => {
			const providerThreadId = await t.start("thr_steer");
			const [first, second] = [creq(), creq()];
			await t.ok("turn/start", { threadId: "thr_steer", providerThreadId, clientRequestId: first, input: text("long"), options: OPTIONS });
			await t.until(() => t.events().some((event) => event.type === "item/agentMessage/delta"), "the answer to start streaming");
			await t.ok("turn/steer", { threadId: "thr_steer", providerThreadId, clientRequestId: second, expectedTurnId: "turn", input: text("change course"), options: OPTIONS });
			await t.until(() => t.turnsEnded() === 1, "the turn to end");

			const events = t.events();
			const accepted = events.filter((event) => event.type === "turn/input/accepted").map((event) => (event as { clientRequestId: string }).clientRequestId);
			assert.deepEqual(accepted, [first, second]);
			assert.equal(events.filter((event) => event.type === "turn/started").length, 1);
			assert.equal(turnEnds(events)[0]!.status, "completed");
			assert.equal(ofType(completed(events), "agentMessage").at(-1)!.text, "steered");

			const idle = await t.request("turn/steer", { threadId: "thr_steer", providerThreadId, clientRequestId: creq(), expectedTurnId: "turn", input: text("too late"), options: OPTIONS });
			assert.match(JSON.stringify(idle.error), /No active turn/);
		},
		{ tokensPerSecond: 60 },
	));

test("a bb tool the model calls is run by bb, and its result goes back to the model", { skip: SKIP }, () =>
	withBridge(
		(f) => [
			f.fauxAssistantMessage(f.fauxToolCall("bb_stamp", { text: "hi" }), { stopReason: "toolUse" }),
			(context: { messages: { role: string; content: unknown }[] }) => f.fauxAssistantMessage(`model saw: ${JSON.stringify(context.messages.at(-1)!.content)}`),
		],
		async (t) => {
			const stamp = {
				name: "bb_stamp",
				description: "Stamp text",
				inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
				presentation: { label: { pending: "Stamping", completed: "Stamped" }, icon: { glyph: "Stamp" } },
			};
			const providerThreadId = await t.start("thr_tool", { dynamicTools: [stamp] });
			await t.ok("turn/start", { threadId: "thr_tool", providerThreadId, clientRequestId: creq(), input: text("stamp it"), options: OPTIONS });

			await t.until(() => t.harness.messages.some((message) => message.method === "item/tool/call"), "the bridge to call the bb tool");
			const call = t.harness.messages.find((message) => message.method === "item/tool/call")!;
			const params = call.params as { tool: string; arguments: unknown; callId: string; threadId: string };
			assert.deepEqual([params.tool, params.arguments, params.threadId], ["bb_stamp", { text: "hi" }, "thr_tool"]);
			const opened = t.harness.messages.findIndex((message) => JSON.stringify(message).includes('"item.open"') && JSON.stringify(message).includes(params.callId));
			assert.ok(opened >= 0 && opened < t.harness.messages.indexOf(call), "the tool's item opens before bb is asked to run it");
			handleLine(JSON.stringify({ jsonrpc: "2.0", id: call.id, result: { success: true, contentItems: [{ type: "inputText", text: "stamped: hi" }] } }));

			await t.until(() => t.turnsEnded() === 1, "the turn to end");
			const items = completed(t.events());
			const [tool] = ofType(items, "toolCall");
			assert.deepEqual([tool!.tool, tool!.server, tool!.result], ["bb_stamp", "bb", "stamped: hi"]);
			assert.match(ofType(items, "agentMessage").at(-1)!.text, /model saw: .*stamped: hi/);
		},
	));

test("a daemon restart ends the open turn as failed, and the next message reconnects to the same conversation", { skip: SKIP }, () =>
	withBridge(
		(f) => [f.fauxAssistantMessage("first"), f.fauxAssistantMessage(`slow ${"word ".repeat(400)}`)],
		async (t) => {
			const f = await loadFixture();
			const providerThreadId = await t.start("thr_restart");
			await t.turn("thr_restart", providerThreadId, "one");
			await t.ok("turn/start", { threadId: "thr_restart", providerThreadId, clientRequestId: creq(), input: text("two"), options: OPTIONS });
			await t.until(() => t.events().filter((event) => event.type === "turn/started").length === 2, "the second turn to start");

			await t.restartDaemon([f.fauxAssistantMessage("resumed"), (context: { messages: unknown[] }) => f.fauxAssistantMessage(`history: ${context.messages.length}`)]);
			await t.until(() => t.turnsEnded() === 2, "the cut turn to end");
			assert.equal(turnEnds(t.events())[1]!.status, "failed");

			// No thread/resume from bb: the bridge opens the session again by itself.
			await t.turn("thr_restart", providerThreadId, "three");
			assert.equal(turnEnds(t.events()).at(-1)!.status, "completed");
			assert.match(ofType(completed(t.events()), "agentMessage").at(-1)!.text, /^(resumed|history: \d+)$/);
		},
		{ tokensPerSecond: 40 },
	));

test("health says why the daemon cannot be used", { skip: SKIP }, () =>
	withBridge(
		() => [],
		async (t) => {
			const status = async () => ((await t.ok("provider/health", { providerId: PROVIDER_ID })).health as { status: string; statusMessage: string | null });
			assert.deepEqual(await status(), { ...(await status()), status: "ready", statusMessage: null });

			await closeDaemon();
			process.env.PI_DURABLE_SOCKET = join(t.dir, "nobody.sock");
			assert.equal((await status()).status, "unknown");
			assert.match((await status()).statusMessage!, /not running/);

			process.env.PI_DURABLE_DAEMON_LIB = join(t.dir, "missing");
			assert.equal((await status()).status, "not_installed");
		},
	));

test("the model list is the daemon's, with its default marked", { skip: SKIP }, () =>
	withBridge(
		() => [],
		async (t) => {
			const { models } = (await t.ok("model/list", { providerId: PROVIDER_ID })) as { models: { id: string; isDefault: boolean }[] };
			assert.deepEqual(models.filter((model) => model.isDefault).map((model) => model.id), ["faux/faux-1"]);
		},
	));
