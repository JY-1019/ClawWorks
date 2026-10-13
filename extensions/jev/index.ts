import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth";
import { classify } from "./classification.js";

export default definePluginEntry({
  id: "jev",
  name: "Jev",
  description: "TypeSafe structured classification for workflow routing",
  register(api) {
    api.registerProvider({
      id: "jev",
      label: "Jev (TypeSafe)",
      docsPath: "/providers/jev",
      envVars: ["TYPESAFE_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: "jev",
          methodId: "api-key",
          label: "TypeSafe API key",
          optionKey: "typesafeApiKey",
          flagName: "--typesafe-api-key",
          envVar: "TYPESAFE_API_KEY",
          promptMessage: "Enter TypeSafe API key",
          // A classifier credential must not replace the conversation's primary model.
        }),
      ],
      classify,
    });
  },
});
