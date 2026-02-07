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
  onDisconnect: () => void;
  onShowGroupsModal: () => void;
  debugMode: boolean;
  setDebugMode: (value: boolean) => void;
};

import React from "react";

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
  onDisconnect,
  onShowGroupsModal,
  debugMode,
  setDebugMode,
}: Props) {
  return (
    <div className="w-full">
      <div className="mb-3 p-2 rounded bg-muted/10 border">
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            className="border rounded px-2 py-1 w-[24rem]"
            placeholder="Traccar Base URL (e.g. localhost:8082)"
            value={baseUrlInput}
            onChange={(e) => setBaseUrlInput(e.target.value)}
          />
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={secureInput}
              onChange={(e) => setSecureInput(e.target.checked)}
            />
            Secure (HTTPS/WSS)
          </label>
          <input
            type="password"
            className="border rounded px-2 py-1 w-48"
            placeholder="API Token"
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
          />
          <button className="px-3 py-1 rounded bg-primary text-white" onClick={onApplySettings}>
            Save
          </button>
          <button className="px-3 py-1 rounded border" onClick={onClearSettings}>
            Clear
          </button>
          <button className="px-3 py-1 rounded border" onClick={onReconnect}>
            Reconnect
          </button>
          <button className="px-3 py-1 rounded border" onClick={onDisconnect}>
            Disconnect
          </button>
          <button className="px-3 py-1 rounded border" onClick={onShowGroupsModal}>
            Tracker Groups
          </button>
          <label className="flex items-center gap-1 px-2">
            <input type="checkbox" checked={debugMode} onChange={(e) => setDebugMode(e.target.checked)} />
            <span className="text-xs">Debug</span>
          </label>
        </div>
        <div className="text-xs mt-2">
          <span className="mr-2">Status: <strong>{wsStatus}</strong></span>
          {wsError ? <span className="text-red-500">Error: {wsError}</span> : null}
        </div>
      </div>
    </div>
  );
});