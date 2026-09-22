import type { Page } from "@playwright/test";

export function mockWorklens(
  page: Page,
  options?: {
    modelState?: "unconfigured" | "unavailable" | "hidden";
    unavailableSelection?: boolean;
    largeModelCatalog?: boolean;
    initialSettings?: Partial<import("../../src/shared/contracts").Settings>;
  },
): Promise<void>;
