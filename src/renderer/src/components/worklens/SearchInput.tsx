import { Hint } from "@/components/ui/tooltip";
import { useRef, type ComponentProps } from "react";
import { X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useLocale } from "@/lib/locale";

type Props = Omit<
  ComponentProps<typeof Input>,
  "value" | "onChange" | "ref" | "type"
> & {
  value: string;
  onValueChange: (value: string) => void;
};
export function SearchInput({ value, onValueChange, ...props }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const { t } = useLocale();
  return (
    <div className="relative min-w-0 flex-1">
      <Input
        {...props}
        ref={input}
        className="pr-9 focus-visible:ring-inset"
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
      />
      {value && (
        <div className="absolute inset-y-0 right-1 flex items-center">
        <Hint content={t("Clear search", "清除搜索")}><Button
          type="button"
          variant="ghost"
          size="icon-xs"
          disabled={props.disabled || props.readOnly}
          aria-label={t("Clear search", "清除搜索")}
          onClick={() => {
            onValueChange("");
            input.current?.focus();
          }}
        >
          <X />
        </Button></Hint>
        </div>
      )}
    </div>
  );
}
