import { Type } from "class-transformer";
import { IsIn, IsOptional, IsString, MinLength, ValidateNested } from "class-validator";
import type { DemoScenario } from "@flowpilot/contracts";

export class LeadInputDto {
  @IsString()
  @MinLength(2)
  name!: string;

  @IsString()
  @MinLength(2)
  company!: string;

  @IsString()
  email!: string;

  @IsString()
  @MinLength(10)
  message!: string;

  @IsIn(["website", "linkedin", "referral", "event"])
  source!: "website" | "linkedin" | "referral" | "event";

  @IsOptional()
  @IsIn(["high", "medium", "low", "duplicate", "invalid", "custom"])
  scenario?: DemoScenario;
}

export class CreateRunDto {
  @ValidateNested()
  @Type(() => LeadInputDto)
  input!: LeadInputDto;
}
