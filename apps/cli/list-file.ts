// A list of strings kept as a JSON file under <RELAYRUNNER_HOME>.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// The list, or an empty one when the file is missing or isn't a list.
export function readList(path: string): string[] {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

export function writeList(path: string, list: string[]) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(list, null, 2)}\n`);
}
