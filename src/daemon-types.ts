// The parts of the pi-durable daemon's client API this plugin uses. The client itself is loaded at run time from
// the daemon's own install (src/daemon.ts), so client and daemon always match; these are its shapes, not its code.

export type Context = object;

/** A block of a pi-ai message: `text`, `thinking`, or `toolCall` (id, name, arguments); others are ignored here. */
export type ContentBlock = {
	type: string;
	text?: string;
	thinking?: string;
	id?: string;
	name?: string;
	arguments?: Record<string, unknown>;
};

export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number };

export type AssistantMessage = {
	role: "assistant";
	content: ContentBlock[];
	usage?: Usage;
	stopReason?: string;
	errorMessage?: string;
};

export type ToolResultMessage = {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: ContentBlock[];
	isError: boolean;
	durationMs?: number;
};

export type Entry = { id: number; kind: string; model?: (AssistantMessage | ToolResultMessage | { role: string })[] };

export type ToolSlot = { callId: string; name: string; status: "pending" | "running" | "done"; output?: string };

export type LiveDoc = {
	run?: { taskId: number; inputs: number[]; turns: number; first?: number };
	generation?: { attempt: number; message?: AssistantMessage };
	tools?: ToolSlot[];
	runFailure?: { taskId: number; inputs: number[]; reason: string; detail?: string };
};

export type ConversationView = {
	entries: Entry[];
	docs: {
		"pi.live"?: LiveDoc;
		"pi.inbox"?: { items: unknown[] };
		"pi.usage"?: { models: Record<string, Usage> };
	};
};

export type AgentChange = {
	model?: { provider: string; modelId: string };
	thinkingLevel?: string;
	instructions?: string;
	cwd?: string;
	modelTools?: null;
};

export type Settlement = { id: number; status: "done" | "unanswered"; reason?: string };
export type Submission = { id: number; wait(context: Context): Promise<Settlement> };

export type WatchCall = { kind: "value"; value: ConversationView } | { kind: string };
export type Watch = {
	value: ConversationView;
	start(listener: (call: WatchCall) => Promise<void>): void;
	stop(): Promise<unknown>;
};

export type Conversation = {
	id: number;
	submit(
		input: { type: "input"; content: string; requestId?: string; whenBusy?: "steer" },
		context: Context,
	): Promise<Submission>;
	configure(change: AgentChange, context: Context): Promise<void>;
	abort(context: Context): Promise<void>;
	watch(context: Context): Promise<Watch>;
};

export type Harness = {
	closed: Promise<{ kind: string; error?: unknown }>;
	close(context: Context): Promise<void>;
	conversation(id: number, context: Context): Promise<Conversation | undefined>;
	createConversation(options: { ownership: { kind: "ownerless" }; agent: AgentChange }, context: Context): Promise<Conversation>;
	commit<T>(run: (tx: { doc<D>(token: unknown): Promise<D> }) => Promise<T>, context: Context): Promise<T>;
};

export type ModelInfo = {
	provider: string;
	id: string;
	name: string;
	reasoning: boolean;
	contextWindow: number;
	isDefault: boolean;
};

export type RemoteToolCall = { conversationId: number; callId: string; name: string; args: unknown };
export type RemoteToolResult = { text: string; isError?: boolean };

export type Services = {
	models: { list(): Promise<ModelInfo[]> };
	tools: {
		subscribe(
			conversationId: number,
			definitions: readonly { name: string; description: string; parameters: object }[],
			handler: (call: RemoteToolCall) => Promise<RemoteToolResult>,
		): Promise<{ detach(): Promise<void> }>;
	};
};

export type ClientModule = {
	BACKGROUND_CONTEXT?: Context;
	defineDoc?: (definition: { kind: string; version: number; scope: "session"; initial: () => unknown }) => unknown;
	connectWithServices?: (
		path: string,
		options: { onError?: (error: unknown) => void },
	) => Promise<{ harness: Harness; services: Partial<Services> }>;
};
