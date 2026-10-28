import { writeSync } from "node:fs";
import { networkErrorCode } from "./network-health";

let installed = false;

/** Observe fatal errors without overriding Electron's failure handling. */
export function monitorProcessErrors() {
  if (installed) return;
  installed = true;
  process.on("uncaughtExceptionMonitor", (error, origin) => {
    try {
      writeSync(
        2,
        `WorkLens: uncaught main-process error; origin=${origin}; code=${networkErrorCode(error) ?? "unknown"}\n`,
      );
    } catch {
      /* Never throw from an exception monitor. */
    }
  });
}
