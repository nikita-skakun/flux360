import { cn } from "@/lib/utils"
import { Root } from "@radix-ui/react-separator"
import React from "react"

function Separator({
  className,
  orientation = "horizontal",
  decorative = true,
  ...props
}: React.ComponentProps<typeof Root>) {
  const isVertical = orientation === "vertical";
  return (
    <Root
      data-slot="separator"
      decorative={decorative}
      orientation={orientation}
      className={cn(
        "bg-border shrink-0",
        isVertical ? "self-stretch w-px" : "w-full h-px",
        className
      )}
      {...props}
    />
  )
}

export { Separator }
