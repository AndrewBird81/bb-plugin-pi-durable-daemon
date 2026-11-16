// A conversation's watched view → bb's thread deltas. The view is the daemon's committed state: finished messages
// and tool results are entries, and what is still running is in the `pi.live` document (the partial answer, tool
// slots with their output so far). This turns each new view into the item deltas bb has not seen yet. Turns are
// the bridge's business (src/bridge.ts); nothing here opens or settles one.
import {
	type DeltaPresentation,
	type DynamicTool,
	type ThreadDelta,
	type ThreadEventTokenUsageBreakdown,
	ZERO_TOKEN_USAGE,
	experimental_fileReadPresentation as fileReadPresentation,
	experimental_toolPresentation as toolPresentation,
} from "@get-bb/plugin-sdk/provider-bridge";
import type { AssistantMessage, ContentBlock, ConversationView, Entry, ToolResultMessage, Usage } from "./daemon-types.ts";

type Key = { providerItemId: string };
type TextChannel = "agentMessage" | "reasoningText";
type ToolItem = Extract<ThreadDelta, { kind: "item.open" }>["item"];
type OpenTool = { key: Key; item: ToolItem; presentation?: DeltaPresentation; snapshot: string };
type Stream = { key: Key; channel: TextChannel; sent: string };

const textOf = (content: readonly ContentBlock[]): string =>
	content.map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : "")).join("");

const newestEntryId = (view: ConversationView): number => view.entries.at(-1)?.id ?? 0;

export function usageBreakdown(usage: Usage | undefined): ThreadEventTokenUsageBreakdown {
	if (!usage) return ZERO_TOKEN_USAGE;
	return {
		inputTokens: usage.input,
		cachedInputTokens: usage.cacheRead + usage.cacheWrite,
		cacheReadInputTokens: usage.cacheRead,
		cacheWriteInputTokens: usage.cacheWrite,
		outputTokens: usage.output,
		reasoningOutputTokens: 0,
		totalTokens: usage.totalTokens,
	};
}

/** The conversation's spend so far: the `pi.usage` document sums it per model. */
export function totalUsage(view: ConversationView): Usage {
	const total: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
	for (const usage of Object.values(view.docs["pi.usage"]?.models ?? {})) {
		for (const field of Object.keys(total) as (keyof Usage)[]) total[field] += usage[field] ?? 0;
	}
	return total;
}

export class Translator {
	readonly #cwd: string;
	readonly #bbTools: ReadonlyMap<string, DynamicTool>;
	readonly #prefix: string;
	#lastEntryId: number;
	#generations = 0;
	#generation: { attempt: number; streams: Map<number, Stream> } | null = null;
	readonly #tools = new Map<string, OpenTool>();
	/** Tokens the newest answer's request held: what the context meter shows. */
	contextTokens: number | null = null;

	/** Starts after the entries `view` already holds: bb showed those, or never will. */
	constructor(options: { cwd: string; idPrefix: string; bbTools: ReadonlyMap<string, DynamicTool> }, view: ConversationView) {
		this.#cwd = options.cwd;
		this.#prefix = options.idPrefix;
		this.#bbTools = options.bbTools;
		this.#lastEntryId = newestEntryId(view);
	}

	apply(view: ConversationView): ThreadDelta[] {
		const deltas: ThreadDelta[] = [];
		for (const entry of view.entries) {
			if (entry.id <= this.#lastEntryId) continue;
			this.#lastEntryId = entry.id;
			this.#entry(entry, deltas);
		}
		const generation = view.docs["pi.live"]?.generation;
		if (generation?.message) this.#partial(generation.attempt, generation.message, deltas);
		for (const slot of view.docs["pi.live"]?.tools ?? []) {
			const tool = this.#tools.get(slot.callId);
			if (!tool || tool.item.type !== "command" || slot.output === undefined || slot.output === tool.snapshot) continue;
			tool.snapshot = slot.output;
			deltas.push({ kind: "command.outputSnapshot", key: tool.key, text: slot.output });
		}
		return deltas;
	}

	/** Whether the item of this tool call has been opened: bb should see it before it is asked to run the tool. */
	hasOpened(callId: string): boolean {
		return this.#tools.has(callId);
	}

	/** Settles what is still open, for a turn that ends without the daemon saying how each item ended. */
	closeAll(status: "interrupted" | "failed"): ThreadDelta[] {
		const deltas: ThreadDelta[] = [];
		this.#endGeneration(deltas);
		for (const tool of this.#tools.values()) deltas.push(this.#close(tool, status, {}));
		this.#tools.clear();
		return deltas;
	}

	#entry(entry: Entry, deltas: ThreadDelta[]): void {
		const message = entry.model?.[0];
		if (entry.kind === "pi.assistant" && message?.role === "assistant") this.#answer(message as AssistantMessage, deltas);
		else if (entry.kind === "pi.tool-result" && message?.role === "toolResult") this.#result(message as ToolResultMessage, deltas);
	}

	#partial(attempt: number, message: AssistantMessage, deltas: ThreadDelta[]): void {
		// A retry starts the answer over: what the failed attempt streamed stays as it was.
		if (this.#generation && this.#generation.attempt !== attempt) this.#endGeneration(deltas);
		this.#generation ??= { attempt, streams: new Map() };
		message.content.forEach((block, index) => this.#text(index, block, false, deltas));
	}

	#answer(message: AssistantMessage, deltas: ThreadDelta[]): void {
		this.#generation ??= { attempt: 0, streams: new Map() };
		message.content.forEach((block, index) => {
			this.#text(index, block, true, deltas);
			if (block.type === "toolCall" && block.id && block.name) this.#open({ id: block.id, name: block.name, arguments: block.arguments ?? {} }, deltas);
		});
		this.#endGeneration(deltas);
		if (message.usage) this.contextTokens = message.usage.totalTokens;
	}

	#text(index: number, block: ContentBlock, final: boolean, deltas: ThreadDelta[]): void {
		const channel: TextChannel | undefined = block.type === "text" ? "agentMessage" : block.type === "thinking" ? "reasoningText" : undefined;
		if (!channel) return;
		const text = String((block.type === "text" ? block.text : block.thinking) ?? "");
		const streams = this.#generation!.streams;
		let stream = streams.get(index);
		if (!stream) {
			if (text.trim() === "") return;
			stream = { key: { providerItemId: `${this.#prefix}-g${this.#generations}-b${index}` }, channel, sent: "" };
			streams.set(index, stream);
		}
		if (text.length > stream.sent.length && text.startsWith(stream.sent)) {
			deltas.push({ kind: "item.textDelta", key: stream.key, channel, text: text.slice(stream.sent.length) });
			stream.sent = text;
		}
		if (final) {
			deltas.push({ kind: "item.textClose", key: stream.key, channel, text });
			streams.delete(index);
		}
	}

	#endGeneration(deltas: ThreadDelta[]): void {
		if (!this.#generation) return;
		for (const stream of this.#generation.streams.values())
			deltas.push({ kind: "item.textClose", key: stream.key, channel: stream.channel });
		this.#generation = null;
		this.#generations += 1;
	}

	#open(call: { id: string; name: string; arguments: Record<string, unknown> }, deltas: ThreadDelta[]): void {
		const args = call.arguments;
		const path = typeof args.path === "string" ? args.path : "";
		const bbTool = this.#bbTools.get(call.name);
		let item: ToolItem;
		let presentation: DeltaPresentation | undefined;
		if (bbTool) {
			item = { type: "tool", tool: call.name, server: "bb", args };
			presentation = bbTool.presentation;
		} else if (call.name === "bash" && typeof args.command === "string") {
			item = { type: "command", command: args.command, cwd: this.#cwd };
		} else if (call.name === "read" && path) {
			item = { type: "fileRead", path };
			presentation = fileReadPresentation(path);
		} else if (call.name === "write" && path) {
			item = { type: "fileChange", changes: [{ path, kind: "add", newText: String(args.content ?? "") }] };
		} else if (call.name === "edit" && path && Array.isArray(args.edits)) {
			item = {
				type: "fileChange",
				changes: (args.edits as { oldText?: unknown; newText?: unknown }[]).map((edit) => ({
					path,
					kind: "update" as const,
					oldText: String(edit.oldText ?? ""),
					newText: String(edit.newText ?? ""),
				})),
			};
		} else {
			item = { type: "tool", tool: call.name, args };
			presentation = toolPresentation(call.name);
		}
		const tool: OpenTool = { key: { providerItemId: call.id }, item, presentation, snapshot: "" };
		this.#tools.set(call.id, tool);
		deltas.push({ kind: "item.open", key: tool.key, item, ...(presentation ? { presentation } : {}) });
	}

	#result(message: ToolResultMessage, deltas: ThreadDelta[]): void {
		// A result with no open item is one whose call this bridge never saw; bb builds the item from the close alone.
		const tool = this.#tools.get(message.toolCallId) ?? {
			key: { providerItemId: message.toolCallId },
			item: { type: "tool", tool: message.toolName } as ToolItem,
			presentation: toolPresentation(message.toolName),
			snapshot: "",
		};
		this.#tools.delete(message.toolCallId);
		deltas.push(
			this.#close(tool, message.isError ? "failed" : "completed", { text: textOf(message.content), durationMs: message.durationMs }),
		);
	}

	#close(tool: OpenTool, status: "completed" | "failed" | "interrupted", result: { text?: string; durationMs?: number }): ThreadDelta {
		const failed = status !== "completed";
		const text = result.text ?? tool.snapshot;
		const duration = result.durationMs === undefined ? {} : { durationMs: Math.round(result.durationMs) };
		const base = { kind: "item.close" as const, key: tool.key, status, ...(tool.presentation ? { presentation: tool.presentation } : {}) };
		switch (tool.item.type) {
			case "command": {
				const exitCode = failed ? 1 : 0;
				return { ...base, exitCode, aggregatedOutput: text, item: { ...tool.item, aggregatedOutput: text, exitCode, ...duration } };
			}
			case "tool":
				return { ...base, item: { ...tool.item, ...(failed ? { error: text || status } : { result: text }), ...duration } };
			default:
				// bb shows a failed file item's resultText as its error.
				return { ...base, item: tool.item, ...(failed && text.trim() !== "" ? { resultText: text } : {}) };
		}
	}
}
