import { describe, expect, it } from "vitest";
import { AiQualificationService } from "./ai-qualification.service";

describe("AiQualificationService", () => {
  it("uses the deterministic adapter without a provider key", async () => {
    delete process.env.OPENAI_API_KEY;
    const result = await new AiQualificationService().qualify({
      name: "Sarah",
      company: "Northstar",
      email: "sarah@northstar.example",
      message: "We need workflow automation now.",
      source: "website",
      scenario: "high",
    });
    expect(result.adapter.provider).toBe("deterministic");
    expect(result.qualification.route).toBe("high");
  });
});
