import * as fs from "fs/promises";
import * as path from "path";

import { TRASH_CONSTANTS } from "../constants";

import { filenameTimestamp } from "./filename-timestamp";
import { getErrorMessage } from "./errors";

const DELETING_PREFIX = TRASH_CONSTANTS.DELETING_PREFIX;

export function trashDeleteHint(containerPath: string): string {
  return (
    `The path named above cannot be deleted by this user — typically output owned by another uid ` +
    `(a root-written Docker bind mount) or a file carrying the immutable attribute. ` +
    `Take ownership of it ('sudo chown -R "$(id -un)" ${containerPath}'), clear the attribute ` +
    `('sudo chattr -i <path>'), or remove '${containerPath}' by hand; until then the entry stays listed and every run retries it.`
  );
}

function deleteError(message: string, cause: unknown): Error {
  return new Error(message, { cause });
}

export async function removeTrashPayload(containerPath: string): Promise<void> {
  const payloadPath = path.join(containerPath, TRASH_CONSTANTS.PAYLOAD_DIRNAME);
  try {
    await fs.rename(payloadPath, path.join(containerPath, `${DELETING_PREFIX}${filenameTimestamp()}`));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw deleteError(`cannot set the payload of '${containerPath}' aside: ${getErrorMessage(error)}`, error);
    }
  }

  let names: string[];
  try {
    names = await fs.readdir(containerPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw deleteError(`cannot read trash container '${containerPath}': ${getErrorMessage(error)}`, error);
  }

  for (const name of names) {
    if (!name.startsWith(DELETING_PREFIX)) continue;
    try {
      await fs.rm(path.join(containerPath, name), { recursive: true, force: true });
    } catch (error) {
      throw deleteError(`cannot delete the payload of '${containerPath}': ${getErrorMessage(error)}`, error);
    }
  }
}

export async function removeEmptiedTrashContainer(containerPath: string): Promise<void> {
  try {
    await fs.rm(containerPath, { recursive: true, force: true });
  } catch (error) {
    throw deleteError(`cannot delete trash container '${containerPath}': ${getErrorMessage(error)}`, error);
  }
}

export async function removeTrashContainer(containerPath: string): Promise<void> {
  await removeTrashPayload(containerPath);
  await removeEmptiedTrashContainer(containerPath);
}

export async function hasPayloadPendingDeletion(containerPath: string): Promise<boolean> {
  try {
    return (await fs.readdir(containerPath)).some((name) => name.startsWith(DELETING_PREFIX));
  } catch {
    return false;
  }
}
