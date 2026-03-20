import { Button } from "@/components/ui/button";
import { LogOut } from "lucide-react";
import { ThemeToggle } from "./ThemeToggle";
import React from "react";

const ICON_LOGOUT = <LogOut className="h-4 w-4" />;

type Props = {
  onLogout: () => void;
};

export const SettingsPanel = React.memo(function SettingsPanel({
  onLogout,
}: Props) {
  return (
    <div className="w-full flex flex-col gap-2">
      <div className="p-2 rounded-lg bg-muted/90 border border-border transition-colors duration-300">
        <div className="flex items-start justify-between gap-2">
          <div className="flex flex-col gap-2">
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
