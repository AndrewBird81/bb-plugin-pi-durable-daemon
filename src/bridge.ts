// The provider bridge: bb's JSON-RPC on stdio ↔ conversations of the pi-durable daemon. A bb thread is one daemon
// conversation; its durable handle (providerThreadId) is `<store id>:<conversation id>`. The model, tools and
// transcript live in the daemon, so a thread survives this process: thread/resume finds the conversation again.
import {
	type AvailableModel,
	type DynamicTool,
	type PromptInput,
	type ProviderHealthResult,
	type ThreadDelta,
	BRIDGE_INBOUND_REQUEST_METHODS,
	BRIDGE_JSON_RPC_ERRORS,
	BRIDGE_NOTIFICATION_METHODS,
	BRIDGE_REQUEST_METHODS,
	PROVIDER_BRIDGE_PROTOCOL_VERSION,
	THREAD_DELTA_GRAMMAR_V3,
	THREAD_DELTA_NOTIFICATION_METHOD,
	createBridgeIo,
	decodeToolCallResponsePayload,
	initializeParamsSchema,
	modelListParamsSchema,
	providerMaintenanceParamsSchema,
	runBridgeRequest,
	threadResumeParamsSchema,
	threadStartParamsSchema,
	threadStopParamsSchema,
	turnStartParamsSchema,
	turnSteerParamsSchema,
} from "@get-bb/plugin-sdk/provider-bridge";
import type { z } from "zod";
import { type Daemon, DaemonUnavailable, getDaemon, onDaemonClosed } from "./daemon.ts";
import type { AgentChange, Conversation, ConversationView, ModelInfo, Settlement, Usage, Watch } from "./daemon-types.ts";
import { Translator, totalUsage, usageBreakdown } from "./translate.ts";
import { DEFAULT_REASONING_LEVEL, REASONING_LEVELS, parseModel, thinkingLevel } from "./vocabulary.ts";

type JsonRpcId = string | number;
type ExecutionOptions = z.infer<typeof turnStartParamsSchema>["options"];
/** What it takes to open a thread's session again, kept so a daemon restart costs the thread nothing. */
type ThreadParams = {
	threadId: string;
	providerThreadId: string;
	cwd: string;
	dynamicTools: readonly DynamicTool[];
	options: ExecutionOptions;
};
type Turn = { open: boolean; runSeen: boolean; stopping: boolean; submissions: Map<number, Settlement | null> };
type Session = {
	params: ThreadParams;
	daemon: Daemon;
	conversation: Conversation;
	watch: Watch;
	view: ConversationView;
	translator: Translator;
	tools?: { detach(): Promise<void> };
	agent: string;
	contextWindow: number | null;
	turn: Turn;
	usage: Usage;
	tail: Promise<void>;
};

const ABORT_TIMEOUT_MS = 10_000;
const sessions = new Map<string, Session>();
const known = new Map<string, ThreadParams>();
const pendingToolCalls = new Map<string, (response: { result?: unknown; error?: unknown }) => void>();
let outboundRequests = 0;

const io = createBridgeIo<{ jsonrpc: "2.0" } & Record<string, unknown>>();
const notify = (method: string, params: Record<string, unknown>) => io.send({ jsonrpc: "2.0", method, params });
const emit = (threadId: string, deltas: ThreadDelta[]) => {
	if (deltas.length > 0) notify(THREAD_DELTA_NOTIFICATION_METHOD, { threadId, deltas });
};
const newTurn = (): Turn => ({ open: false, runSeen: false, stopping: false, submissions: new Map() });
// Unref'd: a timeout that lost its race must not keep the process alive.
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

/** Runs `step` after everything already queued for the session, so deltas leave in the order they happened. */
function enqueue(session: Session, step: () => void | Promise<void>): Promise<void> {
	session.tail = session.tail.then(step).catch((error) => console.error("pi-durable bridge:", error));
	return session.tail;
}

const promptText = (input: readonly PromptInput[]): string =>
	input
		.map((item) => (item.type === "text" ? item.text : "path" in item ? `[${item.type}: ${item.path}]` : ""))
		.join("")
		.trim();

function agentChange(cwd: string, options: ExecutionOptions): AgentChange {
	const change: AgentChange = { cwd };
	const model = parseModel(options.model);
	const thinking = thinkingLevel(options.reasoningLevel);
	if (model) change.model = model;
	if (thinking) change.thinkingLevel = thinking;
	if (options.instructions) change.instructions = options.instructions;
	return change;
}

async function contextWindowOf(daemon: Daemon, change: AgentChange): Promise<number | null> {
	if (!change.model) return null;
	const models = await daemon.services.models.list().catch((): ModelInfo[] => []);
	return models.find((model) => model.provider === change.model!.provider && model.id === change.model!.modelId)?.contextWindow ?? null;
}

/** Brings the conversation's agent in line with the options a command carries; they ride every command. */
async function applyOptions(session: Session, options: ExecutionOptions): Promise<void> {
	const change = agentChange(session.params.cwd, options);
	const key = JSON.stringify(change);
	if (key === session.agent) return;
	await session.conversation.configure(change, session.daemon.context);
	session.agent = key;
	session.params.options = options;
	session.contextWindow = await contextWindowOf(session.daemon, change);
}

function onView(session: Session, view: ConversationView): void {
	session.view = view;
	const deltas = session.translator.apply(view);
	// A run nobody here started is still a turn: one resumed after this bridge restarted, or begun by a steer.
	if (view.docs["pi.live"]?.run) {
		if (!session.turn.open) deltas.unshift({ kind: "turn.open" });
		session.turn.open = true;
		session.turn.runSeen = true;
	}
	emit(session.params.threadId, deltas);
	settle(session);
}

/** Ends the turn once the daemon has nothing left running or queued for it. */
function settle(session: Session): void {
	const { turn, view } = session;
	if (!turn.open || view.docs["pi.live"]?.run || (view.docs["pi.inbox"]?.items.length ?? 0) > 0) return;
	const settled = turn.submissions.size > 0 && [...turn.submissions.values()].every((settlement) => settlement !== null);
	if (turn.runSeen || settled) finishTurn(session);
}

function finishTurn(session: Session, message?: string): void {
	const { turn, view, translator } = session;
	const failure = view.docs["pi.live"]?.runFailure;
	const ours = failure && (turn.submissions.size === 0 || failure.inputs.some((id) => turn.submissions.has(id)));
	const unanswered = [...turn.submissions.values()].find((settlement) => settlement?.status === "unanswered");
	let status: "completed" | "failed" | "interrupted" = "completed";
	let error = message;
	if (message !== undefined) status = "failed";
	else if (turn.stopping || (ours && failure.reason === "aborted") || unanswered?.reason === "aborted") status = "interrupted";
	else if (ours) [status, error] = ["failed", failure.detail ? `${failure.reason}: ${failure.detail}` : failure.reason];
	else if (unanswered) [status, error] = ["failed", unanswered.reason ?? "unanswered"];

	const deltas = translator.closeAll(status === "failed" ? "failed" : "interrupted");
	const total = totalUsage(view);
	const last = Object.fromEntries(Object.entries(total).map(([field, value]) => [field, value - session.usage[field as keyof Usage]])) as Usage;
	session.usage = total;
	deltas.push({ kind: "usage", total: usageBreakdown(total), last: usageBreakdown(last), modelContextWindow: session.contextWindow });
	if (translator.contextTokens !== null)
		deltas.push({ kind: "contextWindow", used: translator.contextTokens, size: session.contextWindow, estimated: false, attach: "open" });
	deltas.push({ kind: "turn.boundary", status, ...(error === undefined ? {} : { error: { message: error } }) });
	session.turn = newTurn();
	emit(session.params.threadId, deltas);
}

/** A bb tool the model called in the daemon: bb runs it and the result goes back as the tool's result. */
async function callBbTool(session: Session, call: { callId: string; name: string; args: unknown }): Promise<{ text: string; isError: boolean }> {
	// The daemon can ask before the view that holds the call has arrived; bb should see the item first.
	for (let waited = 0; !session.translator.hasOpened(call.callId) && waited < 2_000; waited += 10) await sleep(10);
	return new Promise((resolve) => {
		void enqueue(session, () => {
			const id = `pdd-${++outboundRequests}`;
			pendingToolCalls.set(id, (response) => {
				if (response.error !== undefined) {
					const message = (response.error as { message?: unknown }).message;
					return resolve({ text: typeof message === "string" ? message : "bb tool call failed", isError: true });
				}
				const decoded = decodeToolCallResponsePayload(response.result);
				resolve({ text: decoded.content, isError: decoded.isError });
			});
			io.send({
				jsonrpc: "2.0",
				id,
				method: BRIDGE_INBOUND_REQUEST_METHODS.toolCall,
				params: {
					providerThreadId: session.params.providerThreadId,
					threadId: session.params.threadId,
					turnId: null,
					callId: call.callId,
					tool: call.name,
					arguments: (call.args ?? {}) as Record<string, unknown>,
				},
			});
		});
	});
}

async function openSession(daemon: Daemon, conversation: Conversation, params: ThreadParams, agent: AgentChange): Promise<Session> {
	notify(BRIDGE_NOTIFICATION_METHODS.threadIdentity, { threadId: params.threadId, providerThreadId: params.providerThreadId });
	emit(params.threadId, [{ kind: "session.reset" }]);
	const watch = await conversation.watch(daemon.context);
	const bbTools = new Map(params.dynamicTools.map((tool) => [tool.name, tool]));
	const session: Session = {
		params,
		daemon,
		conversation,
		watch,
		view: watch.value,
		translator: new Translator({ cwd: params.cwd, idPrefix: `c${conversation.id}`, bbTools }, watch.value),
		agent: JSON.stringify(agent),
		contextWindow: await contextWindowOf(daemon, agent),
		turn: newTurn(),
		usage: totalUsage(watch.value),
		tail: Promise.resolve(),
	};
	sessions.set(params.threadId, session);
	known.set(params.threadId, params);
	watch.start(async (call) => {
		if (call.kind === "value") void enqueue(session, () => onView(session, (call as { value: ConversationView }).value));
	});
	if (params.dynamicTools.length > 0) {
		session.tools = await daemon.services.tools.subscribe(
			conversation.id,
			params.dynamicTools.map((tool) => ({ name: tool.name, description: tool.description, parameters: (tool.inputSchema ?? { type: "object" }) as object })),
			(call) => callBbTool(session, call),
		);
	}
	await enqueue(session, () => onView(session, session.view));
	return session;
}

async function resumeSession(params: ThreadParams): Promise<Session> {
	const daemon = await getDaemon();
	const separator = params.providerThreadId.lastIndexOf(":");
	const id = Number(params.providerThreadId.slice(separator + 1));
	if (params.providerThreadId.slice(0, separator) !== daemon.storeId || !Number.isInteger(id))
		throw new Error(`thread ${params.threadId} belongs to another pi-durable store than the one this daemon serves`);
	const conversation = await daemon.harness.conversation(id, daemon.context);
	if (!conversation) throw new Error(`the pi-durable daemon has no conversation ${id} for thread ${params.threadId}`);
	const agent = agentChange(params.cwd, params.options);
	await conversation.configure(agent, daemon.context);
	return openSession(daemon, conversation, params, agent);
}

/** The thread's session, opened again if a daemon restart closed it. */
async function sessionFor(threadId: string): Promise<Session | undefined> {
	const params = known.get(threadId);
	return sessions.get(threadId) ?? (params ? resumeSession(params) : undefined);
}

async function closeSession(session: Session): Promise<void> {
	sessions.delete(session.params.threadId);
	known.delete(session.params.threadId);
	await Promise.race([Promise.allSettled([session.watch.stop(), session.tools?.detach()]), sleep(2_000)]);
}

// The daemon went away: its runs are no longer visible here. Open turns end failed; the next command reconnects.
onDaemonClosed(() => {
	for (const session of [...sessions.values()]) {
		sessions.delete(session.params.threadId);
		void enqueue(session, () => {
			if (session.turn.open)
				finishTurn(session, "The pi-durable daemon disconnected. A run it had already started continues when it restarts; send a message to pick the thread up again.");
		});
	}
});

async function submit(session: Session, input: readonly PromptInput[], clientRequestId: string | undefined, steer: boolean): Promise<void> {
	let failure: unknown;
	// The queue is held across the call, so the views of the run it starts are read after the acceptance is out.
	await enqueue(session, async () => {
		const submission = await session.conversation
			.submit(
				{ type: "input", content: promptText(input), ...(clientRequestId ? { requestId: clientRequestId } : {}), ...(steer ? { whenBusy: "steer" as const } : {}) },
				session.daemon.context,
			)
			.catch((error: unknown) => void (failure = error ?? new Error("submit failed")));
		if (!submission) return;
		const deltas: ThreadDelta[] = clientRequestId ? [{ kind: "input.accepted", clientRequestId }] : [];
		if (!session.turn.open) deltas.push({ kind: "turn.open" });
		session.turn.open = true;
		session.turn.submissions.set(submission.id, null);
		emit(session.params.threadId, deltas);
		void submission.wait(session.daemon.context).then(
			(settlement) =>
				enqueue(session, () => {
					if (!session.turn.submissions.has(submission.id)) return;
					session.turn.submissions.set(submission.id, settlement);
					settle(session);
				}),
			() => {}, // the daemon went away; onDaemonClosed ends the turn
		);
	});
	if (failure !== undefined) throw failure;
}

async function health(): Promise<ProviderHealthResult> {
	const base = { accountEmail: null, planLabel: null, installedVersion: null, minimumSupportedVersion: null, canInstall: false, canUpdate: false, loginCommand: null };
	try {
		await getDaemon();
		return { supported: true, health: { ...base, status: "ready", statusMessage: null } };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const status = /not installed/.test(message) ? "not_installed" : /too old/.test(message) ? "unsupported_version" : "unknown";
		return { supported: true, health: { ...base, status, statusMessage: message } };
	}
}

function availableModel(model: ModelInfo): AvailableModel {
	const levels = model.reasoning ? REASONING_LEVELS : REASONING_LEVELS.slice(0, 1);
	return {
		id: `${model.provider}/${model.id}`,
		model: `${model.provider}/${model.id}`,
		displayName: model.name,
		description: `${model.provider} through the pi-durable daemon`,
		isDefault: model.isDefault,
		defaultReasoningEffort: model.reasoning ? DEFAULT_REASONING_LEVEL : levels[0]!.id,
		supportedReasoningEfforts: levels.map((level) => ({ reasoningEffort: level.id, label: level.label, description: level.label })),
		reasoningDiscovery: "known",
	};
}

type Handler = (id: JsonRpcId, params: unknown) => Promise<void>;

/** Parses `params`, or answers INVALID_PARAMS and returns undefined. */
function parse<S extends z.ZodType>(id: JsonRpcId, method: string, schema: S, params: unknown): z.infer<S> | undefined {
	const parsed = schema.safeParse(params);
	if (parsed.success) return parsed.data;
	io.send({ jsonrpc: "2.0", id, error: { code: BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS, message: `Invalid params for ${method}`, data: parsed.error.issues } });
	return undefined;
}

const handlers: Record<string, Handler> = {
	[BRIDGE_REQUEST_METHODS.initialize]: async (id, params) => {
		if (!parse(id, BRIDGE_REQUEST_METHODS.initialize, initializeParamsSchema, params)) return;
		io.sendResult(id, {
			protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
			capabilities: {
				grammarVersions: [THREAD_DELTA_GRAMMAR_V3, THREAD_DELTA_GRAMMAR_V3],
				sessionRestore: true,
				threadArchive: false,
				threadRename: false,
				threadGoalClear: false,
				fork: "none",
				approvalEnforcedBy: "runtime",
				steerMode: "inject",
			},
		});
	},

	[BRIDGE_REQUEST_METHODS.modelList]: async (id, params) => {
		if (!parse(id, BRIDGE_REQUEST_METHODS.modelList, modelListParamsSchema, params)) return;
		const models = (await (await getDaemon()).services.models.list()).map(availableModel);
		io.sendResult(id, { models, selectedOnlyModels: [] });
	},

	[BRIDGE_REQUEST_METHODS.providerHealth]: async (id, params) => {
		if (!parse(id, BRIDGE_REQUEST_METHODS.providerHealth, providerMaintenanceParamsSchema, params)) return;
		io.sendResult(id, await health());
	},

	[BRIDGE_REQUEST_METHODS.threadStart]: async (id, params) => {
		const start = parse(id, BRIDGE_REQUEST_METHODS.threadStart, threadStartParamsSchema, params);
		if (!start) return;
		const daemon = await getDaemon();
		const agent = agentChange(start.cwd, start.options);
		const conversation = await daemon.harness.createConversation({ ownership: { kind: "ownerless" }, agent }, daemon.context);
		const providerThreadId = `${daemon.storeId}:${conversation.id}`;
		const session = await openSession(
			daemon,
			conversation,
			{ threadId: start.threadId, providerThreadId, cwd: start.cwd, dynamicTools: start.dynamicTools ?? [], options: start.options },
			agent,
		);
		io.sendResult(id, { providerThreadId, sessionRestorable: true });
		if (start.input !== undefined && start.input.length > 0) await submit(session, start.input, undefined, false);
	},

	[BRIDGE_REQUEST_METHODS.threadResume]: async (id, params) => {
		const resume = parse(id, BRIDGE_REQUEST_METHODS.threadResume, threadResumeParamsSchema, params);
		if (!resume) return;
		const open = sessions.get(resume.threadId);
		if (open) await closeSession(open);
		await resumeSession({
			threadId: resume.threadId,
			providerThreadId: resume.providerThreadId,
			cwd: resume.cwd,
			dynamicTools: resume.dynamicTools ?? [],
			options: resume.options,
		});
		io.sendResult(id, { providerThreadId: resume.providerThreadId, sessionRestorable: true });
	},

	[BRIDGE_REQUEST_METHODS.turnStart]: async (id, params) => {
		const turn = parse(id, BRIDGE_REQUEST_METHODS.turnStart, turnStartParamsSchema, params);
		if (!turn) return;
		const session = await sessionFor(turn.threadId);
		if (!session) {
			io.sendError(id, BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS, `No session for thread ${turn.threadId}; send thread/start or thread/resume first`);
			return;
		}
		await applyOptions(session, turn.options);
		await submit(session, turn.input, turn.clientRequestId, false);
		io.sendResult(id, {});
	},

	[BRIDGE_REQUEST_METHODS.turnSteer]: async (id, params) => {
		const steer = parse(id, BRIDGE_REQUEST_METHODS.turnSteer, turnSteerParamsSchema, params);
		if (!steer) return;
		const session = sessions.get(steer.threadId);
		if (!session?.turn.open) {
			io.sendError(id, BRIDGE_JSON_RPC_ERRORS.NO_ACTIVE_TURN, `No active turn to steer (expected ${steer.expectedTurnId})`);
			return;
		}
		await submit(session, steer.input, steer.clientRequestId, true);
		io.sendResult(id, {});
	},

	[BRIDGE_REQUEST_METHODS.threadStop]: async (id, params) => {
		const stop = parse(id, BRIDGE_REQUEST_METHODS.threadStop, threadStopParamsSchema, params);
		if (!stop) return;
		const session = sessions.get(stop.threadId);
		if (session) {
			if (stop.intent === "interrupt" && session.turn.open) {
				session.turn.stopping = true;
				// abort() waits for the model call to give up; a provider that ignores cancellation must not hold bb.
				await Promise.race([session.conversation.abort(session.daemon.context).catch(() => {}), sleep(ABORT_TIMEOUT_MS)]);
				// The views of the abort may still be on their way; give them a moment, then settle whatever is open.
				for (let waited = 0; session.turn.open && waited < 2_000; waited += 25) {
					await enqueue(session, () => {});
					if (session.turn.open) await sleep(25);
				}
				await enqueue(session, () => {
					if (session.turn.open) finishTurn(session);
				});
			}
			await closeSession(session);
		}
		known.delete(stop.threadId);
		io.sendResult(id, {});
	},
};

function handleResponse(message: { id?: unknown; result?: unknown; error?: unknown }): void {
	if (typeof message.id !== "string") return;
	const pending = pendingToolCalls.get(message.id);
	pendingToolCalls.delete(message.id);
	pending?.(message);
}

export function handleLine(line: string): void {
	let message: unknown;
	try {
		message = JSON.parse(line);
	} catch {
		return;
	}
	if (typeof message !== "object" || message === null || Array.isArray(message)) return;
	const { id, method, params } = message as { id?: unknown; method?: unknown; params?: unknown };
	if (typeof method !== "string") return handleResponse(message as { id?: unknown });
	if (typeof id !== "string" && typeof id !== "number") return;
	const handler = handlers[method];
	if (handler === undefined) {
		io.sendError(id, BRIDGE_JSON_RPC_ERRORS.METHOD_NOT_FOUND, `Method not found: ${method}`);
		return;
	}
	runBridgeRequest({ request: { id, method, params }, sendError: io.sendError, handleRequest: (request) => handler(request.id, request.params) });
}

export { DaemonUnavailable };
