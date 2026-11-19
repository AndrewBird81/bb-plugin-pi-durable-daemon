import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PI_DURABLE_PATHS } from "../src/icon-paths.ts";

test("the inline icon's paths are assets/pi-durable.svg's", () => {
	const asset = readFileSync(new URL("../assets/pi-durable.svg", import.meta.url), "utf8");
	const paths = [...asset.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]);
	assert.deepEqual(paths, PI_DURABLE_PATHS);
});
