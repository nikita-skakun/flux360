type Props = {
  baseUrlInput: string;
  setBaseUrlInput: (value: string) => void;
  secureInput: boolean;
  setSecureInput: (value: boolean) => void;
  tokenInput: string;
  setTokenInput: (value: string) => void;
  wsStatus: "unknown" | "connecting" | "connected" | "disconnected" | "error";
  wsError: string | null;
  onApplySettings: () => void;
  onClearSettings: () => void;
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
  wsStatus,
  wsError,
  onApplySettings,
  onClearSettings,
  onReconnect,
  debugMode,
  setDebugMode,
}: Props) {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className="w-full">
      <div className="mb-3 p-2 rounded bg-muted/10 border">
        {/* Header: Spoiler Toggle + Debug + Status */}
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

            <label className="flex items-center gap-1 cursor-pointer border-l pl-3 ml-1">
              <input
                type="checkbox"
                checked={debugMode}
                onChange={(e) => setDebugMode(e.target.checked)}
              />
              <span className="text-xs font-medium">Debug Mode</span>
            </label>
          </div>
        </div>

        {/* Spoiler Body */}
        {isExpanded && (
          <div className="mt-3 pt-3 border-t border-border flex flex-wrap items-center gap-2 animate-in fade-in slide-in-from-top-1 duration-200">
            <input
              type="text"
              className="border rounded px-2 py-1 w-[24rem] text-sm"
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
              className="border rounded px-2 py-1 w-48 text-sm"
              placeholder="API Token"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
            />
            <div className="flex flex-wrap items-center gap-2 ml-auto">
              <button
                className="px-3 py-1 rounded border bg-background text-sm hover:bg-muted transition-colors"
                onClick={onApplySettings}
              >
                Save
              </button>
              <button
                className="px-3 py-1 rounded border bg-background text-sm hover:bg-muted transition-colors"
                onClick={onClearSettings}
              >
                Clear
              </button>
              <button
                className="px-3 py-1 rounded border bg-background text-sm hover:bg-muted transition-colors"
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