import { Button } from "@/components/ui/button";
import { Sun, Moon, Monitor } from "lucide-react";
import { useStore } from "@/store";
import React from 'react';

type Props = {
    className?: string;
};

export const ThemeToggle: React.FC<Props> = ({ className }) => {
  const theme = useStore(state => state.settings.theme);
  const setTheme = useStore(state => state.setTheme);

  const cycleTheme = () => {
    const nextTheme: 'light' | 'dark' | 'system' =
            theme === 'system' ? 'dark' :
              theme === 'dark' ? 'light' : 'dark';
    setTheme(nextTheme);
  };

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
    <Button
      variant="outline"
      size="icon"
      onClick={cycleTheme}
      className={`h-7 w-7 rounded-full ${className}`}
      title={`Theme: ${getThemeLabel()} (click to cycle)`}
    >
      {getThemeIcon()}
    </Button>
  );
};
