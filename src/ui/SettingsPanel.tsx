import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { LogOut } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { ThemeToggle } from "./ThemeToggle";
import React from "react";

type Props = {
  debugMode: boolean;
  setDebugMode: (value: boolean) => void;
  onLogout: () => void;
};

export const SettingsPanel = React.memo(function SettingsPanel({
  debugMode,
  setDebugMode,
  onLogout,
}: Props) {

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
            <ThemeToggle />

            <Button
              variant="destructive"
              size="icon"
              onClick={onLogout}
              className="h-7 w-7 rounded-full"
              title="Logout"
            >
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
});
