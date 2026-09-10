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
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="absolute right-1 top-1/2 -translate-y-1/2"
          disabled={props.disabled || props.readOnly}
          aria-label={t("Clear search", "清除搜索")}
          title={t("Clear search", "清除搜索")}
          onClick={() => {
            onValueChange("");
            input.current?.focus();
          }}
        >
          <X />
        </Button>
      )}
    </div>
  );
}
