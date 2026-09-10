import { Cpu } from "lucide-react";
import antgroup from "@lobehub/icons-static-svg/icons/antgroup.svg?url";
import anthropic from "@lobehub/icons-static-svg/icons/anthropic.svg?url";
import azure from "@lobehub/icons-static-svg/icons/azure.svg?url";
import baseten from "@lobehub/icons-static-svg/icons/baseten.svg?url";
import bedrock from "@lobehub/icons-static-svg/icons/bedrock.svg?url";
import cerebras from "@lobehub/icons-static-svg/icons/cerebras.svg?url";
import cloudflare from "@lobehub/icons-static-svg/icons/cloudflare.svg?url";
import githubcopilot from "@lobehub/icons-static-svg/icons/githubcopilot.svg?url";
import deepseek from "@lobehub/icons-static-svg/icons/deepseek.svg?url";
import fireworks from "@lobehub/icons-static-svg/icons/fireworks.svg?url";
import google from "@lobehub/icons-static-svg/icons/google.svg?url";
import groq from "@lobehub/icons-static-svg/icons/groq.svg?url";
import huggingface from "@lobehub/icons-static-svg/icons/huggingface.svg?url";
import kimi from "@lobehub/icons-static-svg/icons/kimi.svg?url";
import minimax from "@lobehub/icons-static-svg/icons/minimax.svg?url";
import mistral from "@lobehub/icons-static-svg/icons/mistral.svg?url";
import moonshot from "@lobehub/icons-static-svg/icons/moonshot.svg?url";
import nvidia from "@lobehub/icons-static-svg/icons/nvidia.svg?url";
import ollama from "@lobehub/icons-static-svg/icons/ollama.svg?url";
import openai from "@lobehub/icons-static-svg/icons/openai.svg?url";
import opencode from "@lobehub/icons-static-svg/icons/opencode.svg?url";
import openrouter from "@lobehub/icons-static-svg/icons/openrouter.svg?url";
import qwen from "@lobehub/icons-static-svg/icons/qwen.svg?url";
import together from "@lobehub/icons-static-svg/icons/together.svg?url";
import vercel from "@lobehub/icons-static-svg/icons/vercel.svg?url";
import xai from "@lobehub/icons-static-svg/icons/xai.svg?url";
import zhipu from "@lobehub/icons-static-svg/icons/zhipu.svg?url";

const icons: Record<string, string> = {
  "anthropic": anthropic,
  "baseten": baseten,
  "cerebras": cerebras,
  "deepseek": deepseek,
  "groq": groq,
  "huggingface": huggingface,
  "minimax": minimax,
  "mistral": mistral,
  "nvidia": nvidia,
  "openai": openai,
  "opencode": opencode,
  "openrouter": openrouter,
  "xai": xai,
  "ollama": ollama,
  "google": google,
  "amazon-bedrock": bedrock,
  "bedrock": bedrock,
  "ant-ling": antgroup,
  "azure-openai-responses": azure,
  "cloudflare-ai-gateway": cloudflare,
  "cloudflare-workers-ai": cloudflare,
  "fireworks": fireworks,
  "github-copilot": githubcopilot,
  "google-vertex": google,
  "kimi-coding": kimi,
  "minimax-cn": minimax,
  "moonshotai": moonshot,
  "moonshotai-cn": moonshot,
  "openai-codex": openai,
  "opencode-go": opencode,
  "qwen-token-plan": qwen,
  "qwen-token-plan-cn": qwen,
  "qwen-token-plan-individual": qwen,
  "together": together,
  "vercel-ai-gateway": vercel,
  "zai": zhipu,
  "zai-coding-cn": zhipu,
};

export function ProviderIcon({ provider }: { provider?: string }) {
  const source = provider ? icons[provider] : undefined;
  if (!source) return <Cpu aria-hidden="true" className="size-4 shrink-0" />;
  return (
    <span
      aria-hidden="true"
      data-slot="provider-icon"
      className="inline-block size-4 shrink-0 bg-current"
      style={{
        maskImage: `url("${source}")`,
        maskSize: "contain",
        maskRepeat: "no-repeat",
        maskPosition: "center",
      }}
    />
  );
}
