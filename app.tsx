// bb.app entry. The provider shows only where the daemon's client is installed, so on other hosts
// (e.g. the bb server) bb has no provider icon for thread rows; this inline mark fills that gap.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { PI_DURABLE_PATHS, PI_DURABLE_TINT } from "./src/icon-paths.ts";
import { PROVIDER_ID } from "./src/vocabulary.ts";

export function PiDurableIcon({ className }: { className?: string }) {
	return (
		<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill={PI_DURABLE_TINT} fillRule="evenodd" className={className} aria-hidden="true">
			{PI_DURABLE_PATHS.map((d) => (
				<path key={d} d={d} />
			))}
		</svg>
	);
}

export default definePluginApp((app) => {
	app.slots.experimental_providerIcon({ providerKind: "agent", providerId: PROVIDER_ID, icon: PiDurableIcon });
});
