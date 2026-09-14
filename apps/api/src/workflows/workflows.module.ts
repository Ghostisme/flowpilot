import { Module } from "@nestjs/common";
import { WorkflowsController } from "./workflows.controller.js";
import { WorkflowRunsService } from "./workflow-runs.service.js";

@Module({
  controllers: [WorkflowsController],
  providers: [WorkflowRunsService],
  exports: [WorkflowRunsService],
})
export class WorkflowsModule {}
