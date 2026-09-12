import { ProviderIcon } from "./ProviderIcon";
import { useState } from "react";
import { Check, ChevronDown, Plug, SlidersHorizontal } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { SearchInput } from "./SearchInput";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { useLocale } from "@/lib/locale";
import type {
  Bootstrap,
  Selection,
  Thinking,
} from "../../../../shared/contracts";
const levels: Record<Thinking, [string, string]> = {
  off: ["Off", "关闭"],
  minimal: ["Minimal", "最少"],
  low: ["Low", "低"],
  medium: ["Medium", "中"],
  high: ["High", "高"],
  xhigh: ["Extra high", "极高"],
  max: ["Max", "最高"],
};
export function ModelMenu({
  data,
  value,
  disabled,
  onChange,
  onManage,
}: {
  data: Bootstrap;
  value?: Selection;
  disabled?: boolean;
  onChange: (value: Selection) => void;
  onManage: () => void;
}) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const hasConfiguredProvider = data.providers.some((p) => p.configured);
  const hidden = new Set(data.settings.hiddenModels ?? []);
  const current = data.providers
    .find((p) => p.id === value?.provider)
    ?.models.find((m) => m.id === value?.model);
  const groups = data.providers
    .map((p) => ({
      ...p,
      models: p.models.filter(
        (m) =>
          m.available &&
          (!hidden.has(p.id + "/" + m.id) ||
            (value?.provider === p.id && value.model === m.id)) &&
          (p.name + " " + m.name + " " + m.id)
            .toLowerCase()
            .includes(query.trim().toLowerCase()),
      ),
    }))
    .filter((p) => p.models.length);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setQuery("");
        }}
      >
        <PopoverTrigger
          render={<Button variant="ghost" size="sm" className="chat-model-trigger max-w-72" />}
          disabled={disabled}
          aria-label={t("Choose model", "选择模型")}
        >
          <ProviderIcon provider={value?.provider} />
          <span className="truncate">
            {current?.name ?? t("Choose model", "选择模型")}
          </span>
          {current?.available && value && current.levels.length > 1 && (
            <span className="text-muted-foreground shrink-0">
              · {t(...levels[value.thinking])}
            </span>
          )}
          <ChevronDown />
        </PopoverTrigger>
        <PopoverContent className="chat-model-picker">
          <div className="chat-model-search">
            <SearchInput
              autoFocus
              aria-label={t("Search models", "搜索模型")}
              placeholder={t("Search models…", "搜索模型…")}
              value={query}
              onValueChange={setQuery}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  e.currentTarget
                    .closest('[data-slot="popover-content"]')
                    ?.querySelector<HTMLButtonElement>("[data-model-option]")
                    ?.focus();
                }
              }}
            />
          </div>
          <div
            className="chat-model-results"
            onKeyDown={(e) => {
              if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
              const options = Array.from(
                e.currentTarget.querySelectorAll<HTMLButtonElement>(
                  "[data-model-option]",
                ),
              );
              const i = options.indexOf(
                document.activeElement as HTMLButtonElement,
              );
              e.preventDefault();
              options[
                (i + (e.key === "ArrowDown" ? 1 : -1) + options.length) %
                  options.length
              ]?.focus();
            }}
          >
            {groups.map((p) => (
              <div key={p.id} role="group" aria-label={p.name}>
                <div className="chat-model-group flex items-center gap-2"><ProviderIcon provider={p.id} />{p.name}</div>
                {p.models.map((m) => {
                  const selected =
                    p.id === value?.provider && m.id === value.model;
                  return (
                    <Button
                      key={m.id}
                      data-model-option
                      variant={selected ? "secondary" : "ghost"}
                      className="chat-model-option"
                      aria-pressed={selected}
                      onClick={() => {
                        onChange({
                          provider: p.id,
                          model: m.id,
                          thinking:
                            selected && value
                              ? value.thinking
                              : value && m.levels.includes(value.thinking)
                                ? value.thinking
                                : m.levels.includes("medium")
                                  ? "medium"
                                  : m.levels[0],
                        });
                        // Keep the picker open so the user can choose reasoning next.
                      }}
                    >
                      <span>{m.name}</span>
                      {selected && <Check />}
                    </Button>
                  );
                })}
              </div>
            ))}
            {!groups.length && (
              <p className="chat-model-empty">
                {query.trim()
                  ? t(
                      "No matching models. Try another search.",
                      "没有匹配的模型，请调整搜索条件。",
                    )
                  : hasConfiguredProvider
                    ? t(
                        "No models to show. Check availability and visibility in Models.",
                        "暂无可显示的模型，请在模型管理中检查可用状态与显示设置。",
                      )
                    : t(
                        "Connect a provider to choose a model.",
                        "连接供应商后即可选择模型。",
                      )}
              </p>
            )}
          </div>
          {current?.available && value && current.levels.length > 1 && (
            <div className="chat-model-reasoning">
              <span>{t("Thinking", "思考强度")}</span>
              <NativeSelect
                aria-label={t("Thinking level", "思考强度")}
                value={value.thinking}
                onChange={(e) =>
                  onChange({ ...value, thinking: e.target.value as Thinking })
                }
              >
                {current.levels.map((level) => (
                  <NativeSelectOption key={level} value={level}>
                    {t(...levels[level])}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          )}
          <div className="chat-model-footer flex items-center gap-2">
            <Button
              variant="ghost"
              className="flex-1 justify-start"
              onClick={() => {
                setOpen(false);
                onManage();
              }}
            >
              {hasConfiguredProvider ? <SlidersHorizontal /> : <Plug />}
              {hasConfiguredProvider
                ? t("Manage models", "管理模型")
                : t("Connect a provider", "连接供应商")}
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
