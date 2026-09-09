import { Module } from "@nestjs/common";
import { AiQualificationService } from "./ai-qualification.service";
import { IntegrationsController } from "./integrations.controller";

@Module({
  controllers: [IntegrationsController],
  providers: [AiQualificationService],
})
export class IntegrationsModule {}
