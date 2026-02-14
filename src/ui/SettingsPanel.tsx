type Props = {
  baseUrlInput: string;
  setBaseUrlInput: (value: string) => void;
  secureInput: boolean;
  setSecureInput: (value: boolean) => void;
  tokenInput: string;
  setTokenInput: (value: string) => void;
  maptilerApiKeyInput: string;
  setMaptilerApiKeyInput: (value: string) => void;
  darkModeInput: 'light' | 'dark' | 'system';
  setDarkModeInput: (value: 'light' | 'dark' | 'system') => void;
  wsStatus: "unknown" | "connecting" | "connected" | "disconnected" | "error";
  wsError: string | null;
  onApplySettings: () => void;
  onApplyTheme: (theme: 'light' | 'dark' | 'system') => void;
  onReconnect: () => void;
  debugMode: boolean;
  setDebugMode: (value: boolean) => void;
};

import React, { useState } from "react";

export const SettingsPanel = React.memo(function SettingsPanel({
  baseUrlInput,
  setBaseUrlInput,
  secureInput,
  setSecureInput,
  tokenInput,
  setTokenInput,
  maptilerApiKeyInput,
  setMaptilerApiKeyInput,
  darkModeInput,
  setDarkModeInput,
  wsStatus,
  wsError,
  onApplySettings,
  onApplyTheme,
  onReconnect,
  debugMode,
  setDebugMode,
}: Props) {
  const [isExpanded, setIsExpanded] = useState(false);

  // Cycle through theme modes: system -> dark -> light -> dark...
  // Applies immediately without needing to click Save
  const cycleTheme = () => {
    const nextTheme: 'light' | 'dark' | 'system' =
      darkModeInput === 'system' ? 'dark' :
      darkModeInput === 'dark' ? 'light' : 'dark';
    setDarkModeInput(nextTheme);
    onApplyTheme(nextTheme);
  };

  // Get the appropriate icon and label
  const getThemeInfo = () => {
    switch (darkModeInput) {
      case 'system':
        return { icon: 'brightness_auto', label: 'Auto' };
      case 'dark':
        return { icon: 'dark_mode', label: 'Dark' };
      case 'light':
        return { icon: 'light_mode', label: 'Light' };
    }
  };

  const themeInfo = getThemeInfo();

  return (
    <div className="w-full">
      <div className="p-2 rounded bg-muted/30">
        {/* Header: Spoiler Toggle + Debug + Status + Theme */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="flex items-center gap-1 text-sm font-medium hover:opacity-80 transition-opacity"
          >
            <span className="w-4 text-center text-muted-foreground">{isExpanded ? "▼" : "▶"}</span>
            Connection Settings
          </button>

          <div className="flex items-center gap-4">
            <div className="text-xs flex items-center gap-2">
              <span>
                Status: <strong>{wsStatus}</strong>
              </span>
              {wsError ? <span className="text-red-500 font-semibold">Error: {wsError}</span> : null}
            </div>

            {/* Theme Toggle Button */}
            <button
              onClick={cycleTheme}
              className="flex items-center gap-1 px-2 py-1 rounded border bg-background text-sm hover:bg-muted transition-colors border-border dark:border-white/10"
              title={`Theme: ${themeInfo.label} (click to cycle)`}
            >
              <span className="material-icons text-lg">{themeInfo.icon}</span>
              <span className="text-xs">{themeInfo.label}</span>
            </button>

            <label className="flex items-center gap-1 cursor-pointer border-l border-border dark:border-white/10 pl-3 ml-1">
              <input
                type="checkbox"
                checked={debugMode}
                onChange={(e) => setDebugMode(e.target.checked)}
              />
              <span className="text-xs font-medium">Debug</span>
            </label>
          </div>
        </div>

        {/* Spoiler Body */}
        {isExpanded && (
          <div className="mt-3 border-border flex flex-col gap-2 animate-in fade-in slide-in-from-top-1 duration-200">
            <input
              type="text"
              className="border rounded px-2 py-1 w-full text-sm bg-background text-foreground border-border dark:border-white/10"
              placeholder="Traccar Base URL (e.g. localhost:8082)"
              value={baseUrlInput}
              onChange={(e) => setBaseUrlInput(e.target.value)}
            />
            <label className="flex items-center gap-1 text-sm cursor-pointer select-none">
              <input
                type="checkbox"
                checked={secureInput}
                onChange={(e) => setSecureInput(e.target.checked)}
              />
              Secure (HTTPS/WSS)
            </label>
            <input
              type="password"
              className="border rounded px-2 py-1 w-full text-sm bg-background text-foreground border-border dark:border-white/10"
              placeholder="API Token"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
            />
            <input
              type="password"
              className="border rounded px-2 py-1 w-full text-sm bg-background text-foreground border-border dark:border-white/10"
              placeholder="MapTiler API Key"
              value={maptilerApiKeyInput}
              onChange={(e) => setMaptilerApiKeyInput(e.target.value)}
            />
            <div className="flex flex-wrap items-center gap-2 ml-auto">
              <button
                className="px-3 py-1 rounded border bg-background text-sm hover:bg-muted transition-colors border-border dark:border-white/10"
                onClick={onApplySettings}
              >
                Save
              </button>
              <button
                className="px-3 py-1 rounded border bg-background text-sm hover:bg-muted transition-colors border-border dark:border-white/10"
                onClick={onReconnect}
              >
                Reconnect
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
});
