# bb-plugin-pi-durable-daemon

A bb provider that runs threads as conversations of a
[pi-durable](https://github.com/earendil-works/pi) daemon on the host: the one
in `nix-config/pkgs/pi-durable`, which also serves Slack and the
`pi-durable-local` CLI. bb is another client of that daemon. The model, the
tools and the transcript live in the daemon, so a thread survives a restart of
bb, of this bridge, and of the daemon.

## How it works

- The plugin ships one file to each host, the provider bridge. It loads the
  daemon's own client (`~/.nix-profile/lib/pi-durable/src/remote/client.ts`)
  at run time and connects to its socket
  (`~/.local/state/pi-durable/daemon.sock`). Nothing else is installed on a
  host, and client and daemon cannot drift apart.
- A bb thread is one daemon conversation. Its handle is
  `<store id>:<conversation id>`; `thread/resume` finds it again.
- The bridge watches the conversation and turns each committed view into bb's
  timeline: streamed text and thinking, `bash` as a command with live output,
  `read`, `write` and `edit` as file items, anything else as a tool call.
- bb's own tools (spawn a thread, ask the user, plugin tools) are offered to
  that conversation only, through the daemon's `services.tools`. bb runs them;
  the result goes back to the model.
- The provider shows only on hosts where the daemon's client is installed.

`PI_DURABLE_DAEMON_LIB`, `PI_DURABLE_SOCKET` and `PI_DURABLE_STATE_DIR`
override the paths, for tests.

## Limits

- A conversation started in Slack or the CLI cannot be opened as a bb thread;
  bb threads create their own conversations in the same store.
- Text input only. No fork, no images, no subagent threads, permission mode
  `full` only.
- If the daemon restarts during a turn, bb shows the turn as failed. The
  daemon resumes the run itself; what it answers while bb is not watching is
  in the conversation but not in bb's timeline.
- A bb tool call that is in flight when the bridge or daemon goes away ends as
  an error result; it is not resumed.

## Develop

```sh
npm install
npm run typecheck
PI_DURABLE_DAEMON_LIB=<a pi-durable package with src/services.ts> npm test
bb plugin build
```

The tests run the real daemon code with pi-ai's faux model over a real socket,
and read the bridge's output through bb's own delta assembler. Without a
daemon package that has client services they skip.
