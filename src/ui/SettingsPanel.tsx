import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Sun, Moon, Monitor } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import React from "react";

type Props = {
  theme: 'light' | 'dark' | 'system';
  onApplyTheme: (theme: 'light' | 'dark' | 'system') => void;
  debugMode: boolean;
  setDebugMode: (value: boolean) => void;
  onLogout: () => void;
};

export const SettingsPanel = React.memo(function SettingsPanel({
  theme,
  onApplyTheme,
  debugMode,
  setDebugMode,
  onLogout,
}: Props) {
  // Cycle through theme modes: system -> dark -> light -> dark...
  // Applies immediately without needing to click Save
  const cycleTheme = () => {
    const nextTheme: 'light' | 'dark' | 'system' =
      theme === 'system' ? 'dark' :
        theme === 'dark' ? 'light' : 'dark';
    onApplyTheme(nextTheme);
  };

  // Get the appropriate icon and label
  const getThemeIcon = () => {
    switch (theme) {
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
    switch (theme) {
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
      <div className="p-2 rounded-lg bg-muted/90 border border-border transition-colors duration-300">
        <div className="flex items-center justify-between text-xs">
          <div className="flex items-center gap-1">
            <Switch
              id="debug-mode"
              checked={debugMode}
              onCheckedChange={setDebugMode}
            />
            <Label htmlFor="debug-mode" className="cursor-pointer font-medium">
              Debug
            </Label>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon"
              onClick={cycleTheme}
              className="h-7 w-7 rounded-full"
              title={`Theme: ${getThemeLabel()} (click to cycle)`}
            >
              {getThemeIcon()}
            </Button>

            <Button
              variant="destructive"
              size="sm"
              onClick={onLogout}
              className="h-7 px-2 text-[10px] font-medium"
            >
              Logout
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
});
