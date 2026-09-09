import { Controller, Get } from "@nestjs/common";
import { PersistenceService } from "./database/persistence.service";

@Controller("health")
export class HealthController {
  constructor(private readonly database: PersistenceService) {}

  @Get()
  getHealth(): Record<string, unknown> {
    return {
      status: "ok",
      service: "flowpilot-api",
      driver: process.env.WORKFLOW_DRIVER ?? "simulator",
      persistence: this.database.getDriver(),
      tablePrefix: this.database.isEnabled() ? this.database.getTablePrefix() : undefined,
      timestamp: new Date().toISOString(),
    };
  }
}
