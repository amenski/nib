// Hand-owned provider facts the Models.dev feed cannot supply, merged over it
// at generation time (scripts/generate-models.ts, capture-models-fixture.ts).
// Build-time only, never imported at runtime: the generated
// src/providers/models.json carries everything nib needs.
//
// Each entry here is a featured provider: listed first in `nib auth`, always
// shown in the model picker, and generated even when its Models.dev record is
// not on the openai-compatible contract (openai, groq and openrouter use their
// own SDK packages upstream; ollama is local and absent from Models.dev, so its
// models come from the hand-maintained block in the fixture). Every base URL
// here is a host nib sends an API key to.
import type { ProviderOverlay } from "./catalog-generator.js";

export const PROVIDER_OVERLAY: Record<string, ProviderOverlay> = {
  deepseek: { featured: true, label: "DeepSeek", api: "openai-compatible", baseUrl: "https://api.deepseek.com", keyEnv: "DEEPSEEK_API_KEY", defaultModel: "deepseek-v4-pro" },
  openai: { featured: true, label: "OpenAI", api: "openai-compatible", baseUrl: "https://api.openai.com/v1", keyEnv: "OPENAI_API_KEY", defaultModel: "gpt-5.6-sol" },
  openrouter: { featured: true, label: "OpenRouter", api: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1", keyEnv: "OPENROUTER_API_KEY", defaultModel: "anthropic/claude-sonnet-4.6" },
  groq: { featured: true, label: "Groq", api: "openai-compatible", baseUrl: "https://api.groq.com/openai/v1", keyEnv: "GROQ_API_KEY", defaultModel: "llama-3.3-70b-versatile" },
  ollama: { featured: true, label: "Ollama", api: "openai-compatible", baseUrl: "http://localhost:11434/v1", keyEnv: "", defaultModel: "llama3.2" },
};
