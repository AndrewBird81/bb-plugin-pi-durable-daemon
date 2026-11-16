import { experimental_defineProviderBridge } from "@get-bb/plugin-sdk/provider-bridge";
import { handleLine } from "./src/bridge.ts";

export const experimental_providerBridge = experimental_defineProviderBridge({ handleLine });
