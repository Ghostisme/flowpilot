import { IsIn, IsOptional, IsString, MaxLength } from "class-validator";

export class ApprovalDto {
  @IsIn(["approved", "rejected"])
  decision!: "approved" | "rejected";

  @IsOptional()
  @IsString()
  @MaxLength(240)
  note?: string;
}
