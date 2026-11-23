import { MACHINE_SHARING } from "@relayrunner/activity";
import { AppError } from "@relayrunner/errors";
import { z } from "zod";
import type { Db } from "../../db/index.ts";
import type { Env } from "../../env.ts";
import {
  pausedByName,
  presentMachine,
  setMachinePaused,
  type PauseActor,
} from "../../machines/machines.ts";

// What the machine's own routes and the dashboard's both use.

export const SharingBody = z.object({ sharing: z.enum(MACHINE_SHARING) });

// Pauses or resumes the machine, tells its open connection, and answers with the machine.
export async function pauseResponse(
  env: Env,
  db: Db,
  machineId: string,
  paused: boolean,
  actor: PauseActor,
) {
  const result = await setMachinePaused(db, machineId, paused, actor);
  if (!result) throw new AppError("NOT_FOUND");
  const by = await pausedByName(db, result.machine);
  const link = env.MACHINE_LINK.getByName(machineId);
  if (result.changed) await link.notifyPaused(paused, by);
  return Response.json({
    machine: { ...presentMachine(result.machine, by), status: await link.status() },
  });
}
