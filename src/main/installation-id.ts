import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function installationId(path: string) {
  let cached: string | undefined;
  const read = () => {
    const value = readFileSync(path, "utf8").trim();
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value))
      throw new Error("Invalid installation ID");
    return value;
  };
  return () => {
    if (cached) return cached;
    try {
      return (cached = read());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mkdirSync(dirname(path), { recursive: true });
      const value = randomUUID();
      try {
        writeFileSync(path, value, { flag: "wx", mode: 0o600 });
        return (cached = value);
      } catch (writeError) {
        if ((writeError as NodeJS.ErrnoException).code !== "EEXIST")
          throw writeError;
        return (cached = read());
      }
    }
  };
}
