export const PLUGIN_ID = "pi-durable-daemon";
export const PROVIDER_ID = "pi-durable-daemon";

/** bb's reasoning levels, in the order the picker shows them, and the pi thinking level each one selects. */
export const REASONING_LEVELS = [
	{ id: "none", label: "Off", thinkingLevel: "off" },
	{ id: "low", label: "Low", thinkingLevel: "low" },
	{ id: "medium", label: "Medium", thinkingLevel: "medium" },
	{ id: "high", label: "High", thinkingLevel: "high" },
	{ id: "xhigh", label: "Extra high", thinkingLevel: "xhigh" },
] as const;

export const DEFAULT_REASONING_LEVEL = "medium";

/** A bb model id is `<provider>/<model id>`; pi model ids may contain slashes, provider ids do not. */
export function parseModel(model: string | undefined): { provider: string; modelId: string } | undefined {
	const slash = model?.indexOf("/") ?? -1;
	if (model === undefined || slash <= 0 || slash === model.length - 1) return undefined;
	return { provider: model.slice(0, slash), modelId: model.slice(slash + 1) };
}

export function thinkingLevel(reasoningLevel: string | undefined): string | undefined {
	return REASONING_LEVELS.find((level) => level.id === reasoningLevel)?.thinkingLevel;
}
