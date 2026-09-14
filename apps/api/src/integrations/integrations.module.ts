import { Module } from "@nestjs/common";
import { AiQualificationService } from "./ai-qualification.service.js";
import { IntegrationsController } from "./integrations.controller.js";

@Module({
  controllers: [IntegrationsController],
  providers: [AiQualificationService],
})
export class IntegrationsModule {}
