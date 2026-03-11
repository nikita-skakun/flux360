import { Button } from "@/components/ui/button";
import { LogOut } from "lucide-react";
import { ThemeToggle } from "./ThemeToggle";
import React from "react";

type Props = {
  onLogout: () => void;
};

export const SettingsPanel = React.memo(function SettingsPanel({
  onLogout,
}: Props) {
  return (
    <div className="w-full flex flex-col gap-2">
      <div className="p-2 rounded-lg bg-muted/90 border border-border transition-colors duration-300">
        <div className="flex items-center justify-end gap-2">
          <ThemeToggle />

          <Button
            variant="destructive"
            size="icon"
            onClick={onLogout}
            className="h-7 w-7 rounded-full"
            title={"Logout"}
          >
            <LogOut className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
});
