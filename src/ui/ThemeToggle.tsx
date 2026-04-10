import { Button } from "@/components/ui/button";
import { Sun, Moon, Monitor } from "lucide-react";
import { useStore } from "@/store";
import React from 'react';
import type { ThemeOptions } from "@/store/types";

const ICON_SUN = <Sun className="h-4 w-4" />;
const ICON_MOON = <Moon className="h-4 w-4" />;
const ICON_MONITOR = <Monitor className="h-4 w-4" />;

export const ThemeToggle: React.FC<{ className?: string }> = ({ className }) => {
  const theme = useStore(state => state.settings.theme);
  const setTheme = useStore(state => state.setTheme);

  const cycleTheme = () => {
    const nextTheme: ThemeOptions =
      theme === 'Auto' ? 'Dark' :
        theme === 'Dark' ? 'Light' : 'Dark';
    setTheme(nextTheme);
  };

  const getThemeIcon = () => {
    switch (theme) {
      case 'Dark':
        return ICON_MOON;
      case 'Light':
        return ICON_SUN;
      case 'Auto':
      default:
        return ICON_MONITOR;
    }
  };

  return (
    <Button
      variant="outline"
      size="icon"
      onClick={cycleTheme}
      className={`h-7 w-7 rounded-full ${className}`}
      title={`Theme: ${theme} (click to cycle)`}
    >
      {getThemeIcon()}
    </Button>
  );
};
