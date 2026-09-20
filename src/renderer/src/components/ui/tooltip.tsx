import { useEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { cn } from "cn";

function TooltipProvider({
  delay = 500,
  timeout = 0,
  ...props
}: TooltipPrimitive.Provider.Props) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delay={delay}
      timeout={timeout}
      {...props}
    />
  );
}

function Tooltip({
  actionsRef,
  onOpenChange,
  ...props
}: TooltipPrimitive.Root.Props) {
  const localActions = useRef<TooltipPrimitive.Root.Actions | null>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!visible) return;
    const close = () => (actionsRef ?? localActions).current?.close();
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Dismiss the hint first without closing the Settings dialog underneath.
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", dismiss, true);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", dismiss, true);
    };
  }, [visible, actionsRef]);
  return (
    <TooltipPrimitive.Root
      data-slot="tooltip"
      {...props}
      actionsRef={actionsRef ?? localActions}
      onOpenChange={(open, details) => {
        onOpenChange?.(open, details);
        setVisible(open);
      }}
    />
  );
}

function TooltipTrigger({ ...props }: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

function TooltipContent({
  className,
  side = "top",
  sideOffset = 4,
  align = "center",
  alignOffset = 0,
  children,
  ...props
}: TooltipPrimitive.Popup.Props &
  Pick<
    TooltipPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset"
  >) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        className="isolate z-50"
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          className={cn(
            "z-50 inline-flex w-fit max-w-xs origin-(--transform-origin) items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-xs text-background has-data-[slot=kbd]:pr-1.5 data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 **:data-[slot=kbd]:relative **:data-[slot=kbd]:isolate **:data-[slot=kbd]:z-50 **:data-[slot=kbd]:rounded-sm data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className,
          )}
          {...props}
        >
          {children}
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };

// Shared hint for existing controls and focusable explanatory text.
function Hint({
  children,
  content,
  disabled = false,
}: {
  children: ReactElement;
  content: ReactNode;
  disabled?: boolean;
}) {
  return (
    <TooltipProvider>
      <Tooltip disabled={disabled}>
        <TooltipTrigger render={children} />
        <TooltipContent>{content}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
export { Hint };

// Dense navigation lists: reveal truncated labels without covering adjacent rows.
function OverflowHint({
  children,
  content,
}: {
  children: ReactElement;
  content: string;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <TooltipProvider>
      <Tooltip
        open={open}
        disableHoverablePopup
        onOpenChange={(next) => {
          const label =
            trigger.current?.querySelector<HTMLElement>(".truncate");
          setOpen(
            next &&
              !!label &&
              (label.scrollWidth > label.clientWidth ||
                label.dataset.truncated === "true" ||
                label.dataset.overflow === "true"),
          );
        }}
      >
        <TooltipTrigger
          ref={trigger}
          render={children}
          onPointerLeave={() => setOpen(false)}
          onBlur={() => setOpen(false)}
        />
        <TooltipContent
          side="right"
          align="center"
          sideOffset={12}
          className="pointer-events-none"
        >
          {content}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
export { OverflowHint };
