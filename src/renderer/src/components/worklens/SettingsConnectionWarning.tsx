import type { ReactNode } from "react";
import { CircleAlert } from "lucide-react";
import { ItemDescription } from "@/components/ui/item";

export function SettingsConnectionWarning({
  children,
  id,
}: {
  children: ReactNode;
  id?: string;
}) {
  return (
    <ItemDescription className="text-[var(--warning)]" role="status" id={id}>
      <span className="inline-flex items-start gap-1.5">
        <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        {children}
      </span>
    </ItemDescription>
  );
}
