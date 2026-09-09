import { Module } from "@nestjs/common";
import { WorkflowsController } from "./workflows.controller";
import { WorkflowRunsService } from "./workflow-runs.service";

@Module({
  controllers: [WorkflowsController],
  providers: [WorkflowRunsService],
  exports: [WorkflowRunsService],
})
export class WorkflowsModule {}
