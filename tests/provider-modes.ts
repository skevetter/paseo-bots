/** The modes Paseo lists for these providers on a real host. */
export const LIVE_PROVIDERS = [
  {
    provider: "claude",
    label: "Claude",
    enabled: true,
    status: "ready",
    defaultModeId: "auto",
    models: [{ id: "opus", label: "Opus", isDefault: true }],
    modes: [
      { id: "plan", label: "Plan Mode", colorTier: "planning" },
      { id: "default", label: "Always Ask", colorTier: "safe" },
      { id: "acceptEdits", label: "Accept File Edits", colorTier: "moderate" },
      { id: "auto", label: "Auto mode", colorTier: "moderate" },
      { id: "bypassPermissions", label: "Bypass", colorTier: "dangerous" },
    ],
  },
  {
    provider: "omp",
    label: "Oh My Pi",
    enabled: true,
    status: "ready",
    defaultModeId: "full",
    models: [{ id: "pi", label: "Pi", isDefault: true }],
    modes: [
      { id: "full", label: "Full Access", colorTier: "dangerous" },
      { id: "write", label: "Write Approval", colorTier: "moderate" },
      { id: "ask", label: "Always Ask", colorTier: "safe" },
    ],
  },
  {
    provider: "hermes",
    label: "Hermes",
    enabled: true,
    status: "ready",
    defaultModeId: "default",
    models: [{ id: "hermes-4", label: "Hermes 4", isDefault: true }],
    modes: [
      { id: "default", label: "Default" },
      { id: "accept_edits", label: "Accept Edits" },
      { id: "dont_ask", label: "Don't Ask" },
    ],
  },
];

export const LIVE_MODES = Object.fromEntries(LIVE_PROVIDERS.map((entry) => [entry.provider, entry]));
