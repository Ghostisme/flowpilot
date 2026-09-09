import { Global, Module } from "@nestjs/common";
import { PersistenceService } from "./persistence.service";

@Global()
@Module({
  providers: [PersistenceService],
  exports: [PersistenceService],
})
export class DatabaseModule {}
