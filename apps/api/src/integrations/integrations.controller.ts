import { BadRequestException, Body, Controller, Get, Post } from "@nestjs/common";
import type { LeadInput } from "@flowpilot/contracts";
import { AiQualificationService } from "./ai-qualification.service";

@Controller("integrations")
export class IntegrationsController {
  private readonly crmLeads: Record<string, unknown>[] = [];
  private readonly slackMessages: Record<string, unknown>[] = [];
  private readonly emails: Record<string, unknown>[] = [];

  constructor(private readonly aiQualification: AiQualificationService) {}

  @Post("ai/qualify")
  async qualifyLead(@Body() body: Record<string, unknown>) {
    const context = this.context(body);
    const input = (body.input ?? context.input) as LeadInput | undefined;
    if (!input || typeof input !== "object") throw new BadRequestException("Lead input is required");
    const result = await this.aiQualification.qualify(input);
    return { ...context, qualification: result.qualification, aiResult: result.adapter };
  }

  @Post("crm/leads")
  createLead(@Body() body: Record<string, unknown>) {
    const context = this.context(body);
    const record = {
      id: `crm_lead_${String(this.crmLeads.length + 1).padStart(4, "0")}`,
      lead: body.lead ?? context.input,
    };
    this.crmLeads.push(record);
    return { ...context, crmResult: { ok: true, provider: "mock-crm", record } };
  }

  @Post("slack/messages")
  sendSlack(@Body() body: Record<string, unknown>) {
    const context = this.context(body);
    const message = {
      id: `slack_${this.slackMessages.length + 1}`,
      channel: body.channel ?? "#sales-hot-leads",
    };
    this.slackMessages.push(message);
    return { ...context, slackResult: { ok: true, provider: "mock-slack", message } };
  }

  @Post("email/send")
  sendEmail(@Body() body: Record<string, unknown>) {
    const context = this.context(body);
    const email = {
      id: `email_${this.emails.length + 1}`,
      to: body.to ?? (context.input as Record<string, unknown> | undefined)?.email,
    };
    this.emails.push(email);
    return { ...context, emailResult: { ok: true, provider: "mock-email", email } };
  }

  @Get("snapshot")
  snapshot() {
    return {
      crmLeads: this.crmLeads,
      slackMessages: this.slackMessages,
      emails: this.emails,
    };
  }

  private context(body: Record<string, unknown>): Record<string, unknown> {
    return typeof body.context === "object" && body.context !== null
      ? (body.context as Record<string, unknown>)
      : body;
  }
}
