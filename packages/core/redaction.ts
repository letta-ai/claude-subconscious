import type { HarnessEvent } from "./types.js";

export interface ObservationRedactor {
  redact(event: HarnessEvent): Promise<HarnessEvent> | HarnessEvent;
}

export const identityRedactor: ObservationRedactor = {
  redact: (event) => event,
};
