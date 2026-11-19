import { execFileSync } from "node:child_process";

export function listeners(port: number): number[] {
  try {
    return execFileSync("lsof", ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
      .trim().split(/\s+/).filter(Boolean).map(Number);
  } catch (error) {
    if ((error as { status?: number }).status === 1) return [];
    throw error;
  }
}
