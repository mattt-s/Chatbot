export const CUSTOMCHAT_PLUGIN_ID = "customchat";
export const CUSTOMCHAT_PLUGIN_NAME = "Custom Chat";
export const CUSTOMCHAT_PLUGIN_DESCRIPTION =
  "Custom Chat messaging channel backed by the ChatBot app.";

export const CUSTOMCHAT_CHANNEL_META = {
  id: CUSTOMCHAT_PLUGIN_ID,
  label: CUSTOMCHAT_PLUGIN_NAME,
  selectionLabel: CUSTOMCHAT_PLUGIN_NAME,
  docsPath: "/channels/customchat",
  docsLabel: "customchat",
  blurb: "Custom Slack-style web channel backed by an external portal app.",
  order: 200,
  aliases: ["custom"],
} as const;

