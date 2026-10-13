import { KeaHttpError } from "../http/errors.ts";
import { parseStatName, type StatName } from "./stat-name.ts";
import { currentValue, type SampleValue } from "./stat-sample.ts";

export interface Statistic {
  readonly name: string;
  readonly parsed: StatName | undefined;
  readonly value: SampleValue;
}

// D§3.2.11. Each statistic is parsed independently: one malformed name or
// sample list is that statistic's problem, not the response's.
export function parseStatistics(args: unknown): Statistic[] {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    throw new KeaHttpError("parse", "statistic-get-all: arguments are not an object");
  }
  return Object.entries(args).map(([name, samples]) => ({
    name,
    parsed: parseStatName(name),
    value: currentValue(samples),
  }));
}
