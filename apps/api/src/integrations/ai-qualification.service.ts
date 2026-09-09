import { Injectable, Logger } from "@nestjs/common";
import type { LeadInput } from "@flowpilot/contracts";

export interface LeadQualification {
  score: number;
  route: "high" | "medium" | "low";
  intent: string;
  confidence: number;
  signals: string[];
}

export interface QualificationResult {
  qualification: LeadQualification;
  adapter: {
    provider: "deterministic" | "openai-compatible";
    model: string;
    fallbackReason?: string;
  };
}

@Injectable()
export class AiQualificationService {
  private readonly logger = new Logger(AiQualificationService.name);

  async qualify(input: LeadInput): Promise<QualificationResult> {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    const model = process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini";
    if (!apiKey) {
      return {
        qualification: this.deterministic(input),
        adapter: { provider: "deterministic", model: "flowpilot-rules-v1" },
      };
    }

    try {
      const baseUrl = (process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/$/, "");
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: "Return JSON only. Qualify a B2B automation lead with score 0-100, intent, confidence 0-1, and 1-5 short evidence signals. Do not invent facts.",
            },
            { role: "user", content: JSON.stringify(input) },
          ],
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`completion endpoint returned ${response.status}`);
      const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = payload.choices?.[0]?.message?.content;
      if (!content) throw new Error("completion response did not contain message content");
      return {
        qualification: this.normalize(JSON.parse(content) as Record<string, unknown>),
        adapter: { provider: "openai-compatible", model },
      };
    } catch (error: unknown) {
      const fallbackReason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`AI qualification fell back to deterministic rules: ${fallbackReason}`);
      return {
        qualification: this.deterministic(input),
        adapter: { provider: "deterministic", model: "flowpilot-rules-v1", fallbackReason },
      };
    }
  }

  private normalize(value: Record<string, unknown>): LeadQualification {
    const score = this.clamp(Number(value.score), 0, 100, 42);
    const confidence = this.clamp(Number(value.confidence), 0, 1, 0.7);
    const signals = Array.isArray(value.signals)
      ? value.signals.filter((item): item is string => typeof item === "string").slice(0, 5)
      : [];
    return {
      score,
      route: score >= 75 ? "high" : score >= 50 ? "medium" : "low",
      intent: typeof value.intent === "string" && value.intent.trim() ? value.intent.trim() : "general_inquiry",
      confidence,
      signals: signals.length > 0 ? signals : ["model returned no evidence signals"],
    };
  }

  private deterministic(input: LeadInput): LeadQualification {
    const presets: Partial<Record<NonNullable<LeadInput["scenario"]>, LeadQualification>> = {
      high: { score: 87, route: "high", intent: "buying_workflow_automation", confidence: 0.96, signals: ["clear business problem", "integration request", "near-term language"] },
      medium: { score: 62, route: "medium", intent: "exploring_workflow_options", confidence: 0.82, signals: ["specific use case", "unclear timeline"] },
      low: { score: 28, route: "low", intent: "early_research", confidence: 0.77, signals: ["general inquiry", "low urgency"] },
    };
    const preset = input.scenario ? presets[input.scenario] : undefined;
    if (preset) return preset;
    const hasBuyingSignal = /budget|integration|automate|workflow|urgent/i.test(`${input.company} ${input.message}`);
    return hasBuyingSignal
      ? { score: 76, route: "high", intent: "workflow_automation", confidence: 0.74, signals: ["action-oriented request"] }
      : { score: 42, route: "low", intent: "general_inquiry", confidence: 0.7, signals: ["needs discovery"] };
  }

  private clamp(value: number, min: number, max: number, fallback: number): number {
    return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  }
}
