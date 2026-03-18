import { Button } from "@/components/ui/button";
import { LogOut } from "lucide-react";
import { ThemeToggle } from "./ThemeToggle";
import React from "react";

const ICON_LOGOUT = <LogOut className="h-4 w-4" />;

type Props = {
  smoothingIterations: number;
  onSmoothingIterationsChange: (value: number) => void;
  simplifyEpsilon: number;
  onSimplifyEpsilonChange: (value: number) => void;
  onLogout: () => void;
};

export const SettingsPanel = React.memo(function SettingsPanel({
  smoothingIterations,
  onSmoothingIterationsChange,
  simplifyEpsilon,
  onSimplifyEpsilonChange,
  onLogout,
}: Props) {
  return (
    <div className="w-full flex flex-col gap-2">
      <div className="p-2 rounded-lg bg-muted/90 border border-border transition-colors duration-300">
        <div className="flex items-start justify-between gap-2">
          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2">
              <span className="text-xs font-medium">Smooth</span>
              <input
                type="range"
                min={0}
                max={5}
                value={smoothingIterations}
                onChange={(e) => onSmoothingIterationsChange(Number(e.target.value))}
                className="h-6 w-24"
              />
              <span className="w-6 text-right text-xs font-semibold">
                {smoothingIterations}
              </span>
            </label>
            <label className="flex items-center gap-2">
              <span className="text-xs font-medium">Simplify (m)</span>
              <input
                type="range"
                min={0}
                max={10}
                value={simplifyEpsilon}
                onChange={(e) => onSimplifyEpsilonChange(Number(e.target.value))}
                className="h-6 w-24"
              />
              <span className="w-12 text-right text-xs font-semibold">
                {simplifyEpsilon}m
              </span>
            </label>
          </div>

          <div className="flex items-center gap-2">
            <ThemeToggle />

            <Button
              variant="destructive"
              size="icon"
              onClick={onLogout}
              className="h-7 w-7 rounded-full"
              title={"Logout"}
            >
              {ICON_LOGOUT}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
});
