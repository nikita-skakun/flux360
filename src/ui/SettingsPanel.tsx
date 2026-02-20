import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Sun, Moon, Monitor, ChevronDown, ChevronRight } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import React, { useState } from "react";

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
  const getThemeIcon = () => {
    switch (darkModeInput) {
      case 'dark':
        return <Moon className="h-4 w-4" />;
      case 'light':
        return <Sun className="h-4 w-4" />;
      case 'system':
      default:
        return <Monitor className="h-4 w-4" />;
    }
  };

  const getThemeLabel = () => {
    switch (darkModeInput) {
      case 'dark':
        return 'Dark';
      case 'light':
        return 'Light';
      case 'system':
      default:
        return 'Auto';
    }
  };

  return (
    <div className="w-full">
      <div className="p-2 rounded-lg bg-muted/30 border border-border transition-colors duration-300">
        {/* Header: Spoiler Toggle + Debug + Status + Theme */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setIsExpanded(!isExpanded)}
            className="flex items-center gap-1 text-sm font-medium hover:opacity-80 transition-opacity"
          >
            {isExpanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
            Connection Settings
          </Button>

          <div className="flex items-center gap-4">
            <div className="text-xs flex items-center gap-2">
              <span>
                Status: <strong className="text-foreground">{wsStatus}</strong>
              </span>
              {wsError ? <span className="text-destructive font-semibold">Error: {wsError}</span> : null}
            </div>

            <Separator orientation="vertical" className="h-4" />

            <div className="flex items-center gap-2">
              <Switch
                id="debug-mode"
                checked={debugMode}
                onCheckedChange={setDebugMode}
              />
              <Label htmlFor="debug-mode" className="text-xs font-medium cursor-pointer">
                Debug
              </Label>
            </div>

            <Separator orientation="vertical" className="h-4" />

            {/* Theme Toggle Button */}
            <Button
              variant="outline"
              size="icon"
              onClick={cycleTheme}
              className="h-8 w-8 rounded-full"
              title={`Theme: ${getThemeLabel()} (click to cycle)`}
            >
              {getThemeIcon()}
            </Button>
          </div>
        </div>

        {/* Spoiler Body */}
        {isExpanded && (
          <div className="mt-3 flex flex-col gap-3 animate-in fade-in slide-in-from-top-1 duration-200">
            <Input
              type="text"
              placeholder="Traccar Base URL (e.g. localhost:8082)"
              value={baseUrlInput}
              onChange={(e) => setBaseUrlInput(e.target.value)}
            />

            <div className="flex items-center gap-2">
              <Switch
                id="secure-connection"
                checked={secureInput}
                onCheckedChange={setSecureInput}
              />
              <Label htmlFor="secure-connection" className="text-sm cursor-pointer">
                Secure (HTTPS/WSS)
              </Label>
            </div>

            <Input
              type="password"
              placeholder="API Token"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
            />

            <Input
              type="password"
              placeholder="MapTiler API Key"
              value={maptilerApiKeyInput}
              onChange={(e) => setMaptilerApiKeyInput(e.target.value)}
            />

            <div className="flex flex-wrap items-center gap-2 ml-auto">
              <Button
                variant="outline"
                size="sm"
                onClick={onApplySettings}
              >
                Save
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={onReconnect}
              >
                Reconnect
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
});
