// One connection to the pi-durable daemon on this host, shared by every thread of this bridge. The client code is
// the daemon's own, loaded from its install, so the wire protocol cannot drift from the daemon that serves it.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ClientModule, Context, Harness, Services } from "./daemon-types.ts";

export const daemonLib = (): string => process.env.PI_DURABLE_DAEMON_LIB ?? join(homedir(), ".nix-profile/lib/pi-durable");
export const daemonSocket = (): string =>
	process.env.PI_DURABLE_SOCKET ??
	join(process.env.PI_DURABLE_STATE_DIR ?? join(homedir(), ".local/state/pi-durable"), "daemon.sock");

export type Daemon = {
	harness: Harness;
	services: Services;
	context: Context;
	/** Names this daemon's storage; part of every providerThreadId, so a wiped store cannot answer for an old thread. */
	storeId: string;
};

/** Why the daemon cannot be used, in words for bb's provider health and for a failed request. */
export class DaemonUnavailable extends Error {}

let current: Promise<Daemon> | null = null;
const closeListeners = new Set<() => void>();

/** Called once each time a connection that was up goes away. */
export function onDaemonClosed(listener: () => void): void {
	closeListeners.add(listener);
}

async function open(): Promise<Daemon> {
	const client = join(daemonLib(), "src/remote/client.ts");
	if (!existsSync(client)) throw new DaemonUnavailable(`pi-durable daemon is not installed on this host (no ${client})`);
	const module = (await import(pathToFileURL(client).href)) as ClientModule;
	const { connectWithServices, BACKGROUND_CONTEXT: context, defineDoc } = module;
	if (!connectWithServices || !context || !defineDoc)
		throw new DaemonUnavailable("this host's pi-durable daemon is too old for bb: it has no client services");
	const socket = daemonSocket();
	const connected = await connectWithServices(socket, { onError: () => {} }).catch((error: NodeJS.ErrnoException) => {
		throw new DaemonUnavailable(`pi-durable daemon is not running at ${socket} (${error.code ?? error.message})`);
	});
	const { harness, services } = connected;
	if (!services.models || !services.tools) {
		await harness.close(context).catch(() => {});
		throw new DaemonUnavailable("the running pi-durable daemon is too old for bb: restart it on the current version");
	}
	const State = defineDoc({ kind: "bb.bridge", version: 1, scope: "session", initial: () => ({ storeId: "" }) });
	const storeId = await harness.commit(async (tx) => {
		const state = await tx.doc<{ storeId: string }>(State);
		if (state.storeId === "") state.storeId = randomUUID();
		return state.storeId;
	}, context);
	void harness.closed.then(() => {
		current = null;
		for (const listener of closeListeners) listener();
	});
	return { harness, services: services as Services, context, storeId };
}

export function getDaemon(): Promise<Daemon> {
	current ??= open().catch((error) => {
		current = null;
		throw error;
	});
	return current;
}

/** For tests: disconnect and forget the connection. */
export async function closeDaemon(): Promise<void> {
	const daemon = await current?.catch(() => undefined);
	current = null;
	await daemon?.harness.close(daemon.context).catch(() => {});
}
