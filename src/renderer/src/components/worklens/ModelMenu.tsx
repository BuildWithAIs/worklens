import { Check, ChevronDown, ChevronRight, Cpu } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { Bootstrap, Selection, Thinking } from "../../../../shared/contracts";

const thinkingLabels: Record<Thinking, string> = {
  off: "关闭",
  minimal: "最少",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最高",
};

function availableModels(data: Bootstrap, value?: Selection) {
  const hidden = new Set(data.settings.hiddenModels ?? []);
  return data.providers.flatMap((provider) =>
    provider.models
      .filter(
        (model) =>
          model.available &&
          (!hidden.has(`${provider.id}/${model.id}`) ||
            (value?.provider === provider.id && value?.model === model.id)),
      )
      .map((model) => ({ ...model, providerId: provider.id, providerName: provider.name })),
  );
}

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
  const models = availableModels(data, value);
  const current = models.find(
    (m) => m.id === value?.model && m.providerId === value?.provider,
  );

  if (!models.length) {
    return (
      <button className="model-menu-trigger empty" onClick={onManage}>
        <Cpu size={14} />
        还没有可用模型 · 去配置
        <ChevronRight size={14} />
      </button>
    );
  }

  return (
    <Popover>
      <PopoverTrigger className="model-menu-trigger" disabled={disabled}>
        <Cpu size={14} />
        <span>{current?.name ?? "选择模型"}</span>
        {current && value?.thinking && value.thinking !== "off" && (
          <span className="model-menu-level">
            {thinkingLabels[value.thinking]}
          </span>
        )}
        <ChevronDown size={14} />
      </PopoverTrigger>
      <PopoverContent className="model-menu-content">
        <div className="model-menu-list">
          {models.map((model) => {
            const selected =
              current?.id === model.id && current.providerId === model.providerId;
            return (
              <button
                key={`${model.providerId}/${model.id}`}
                className={selected ? "model-menu-item selected" : "model-menu-item"}
                onClick={() =>
                  onChange({
                    provider: model.providerId,
                    model: model.id,
                    thinking:
                      selected && value
                        ? value.thinking
                        : model.levels.includes("medium")
                          ? "medium"
                          : model.levels[0],
                  })
                }
              >
                <div className="model-menu-item-text">
                  <span className="model-menu-item-name">{model.name}</span>
                  <span className="model-menu-item-provider">{model.providerName}</span>
                </div>
                {selected && <Check size={14} />}
              </button>
            );
          })}
        </div>
        {current && current.levels.length > 1 && (
          <div className="model-menu-levels">
            <span className="model-menu-levels-label">推理强度</span>
            <div className="model-menu-levels-options">
              {current.levels.map((level) => (
                <button
                  key={level}
                  className={value?.thinking === level ? "selected" : ""}
                  onClick={() => value && onChange({ ...value, thinking: level })}
                >
                  {thinkingLabels[level]}
                </button>
              ))}
            </div>
          </div>
        )}
        <button className="model-menu-manage" onClick={onManage}>
          管理模型
          <ChevronRight size={13} />
        </button>
      </PopoverContent>
    </Popover>
  );
}
