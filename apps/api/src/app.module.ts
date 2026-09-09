import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { resolve } from "node:path";
import { HealthController } from "./health.controller";
import { DatabaseModule } from "./database/database.module";
import { IntegrationsModule } from "./integrations/integrations.module";
import { WorkflowsModule } from "./workflows/workflows.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")],
    }),
    DatabaseModule,
    WorkflowsModule,
    IntegrationsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
