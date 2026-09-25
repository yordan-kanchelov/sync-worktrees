import * as fs from "fs/promises";
import * as path from "path";

import { TRASH_CONSTANTS } from "../constants";

import { filenameTimestamp } from "./filename-timestamp";
import { getErrorMessage } from "./errors";

// Deleting a trash container is a multi-step, non-atomic operation on a user's
// only remaining copy of their files, so the order is chosen for what each
// interruption leaves behind — a process killed between any two steps, not
// merely an `fs.rm` that rejects.
//
// The invariant: at every instant a container either still has a valid
// manifest — so it stays listed, reapable and (until its payload is set aside)
// restorable — or is fully gone. A single `fs.rm(container, {recursive:true})`
// breaks it, because recursive rm walks the container in readdir order and
// unlinks `manifest.json` before it reaches whatever deep in `payload/` it
// cannot unlink. What is left is neither: an unrecognized container that is
// never listed, never retried and never reaped, holding its disk and (through
// the pin ref the reaper then never releases) its objects forever.
//
// So the payload is retired first, and by rename rather than by rm: rename is
// atomic, so `payload/` never exists in a half-deleted state. Past that point
// the entry is payload-less, which is a shape the pipeline already understands
// — restore refuses it and the reaper finishes it on the next run — and every
// byte the rm does manage to remove stays removed across retries.
const DELETING_PREFIX = TRASH_CONSTANTS.DELETING_PREFIX;

/** Actionable next step for a container whose contents resist deletion. */
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

/**
 * Sets the payload aside under `payload.deleting-<ts>` and deletes it, leaving
 * `manifest.json` untouched. Rejects with the failing path when anything in the
 * payload resists deletion; the container is then still a valid trash entry.
 */
export async function removeTrashPayload(containerPath: string): Promise<void> {
  const payloadPath = path.join(containerPath, TRASH_CONSTANTS.PAYLOAD_DIRNAME);
  try {
    await fs.rename(payloadPath, path.join(containerPath, `${DELETING_PREFIX}${filenameTimestamp()}`));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ENOENT only: the payload was already set aside by an interrupted run, or
    // never moved in because trashing itself was interrupted before the rename.
    // ENOTDIR is deliberately NOT tolerated — it means the destination name is
    // a regular file while `payload/` is a directory, so the payload stayed put
    // (verified on Linux). Swallowing it would let the sweep remove that file,
    // report the payload gone, and hand a container that still holds `payload/`
    // to the recursive delete below — the manifest-first delete this whole
    // ordering exists to prevent.
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

  // Every set-aside payload, not only the one this call renamed: a run that
  // was interrupted or refused after its rename left one behind, and nothing
  // else would ever come back for it.
  for (const name of names) {
    if (!name.startsWith(DELETING_PREFIX)) continue;
    try {
      await fs.rm(path.join(containerPath, name), { recursive: true, force: true });
    } catch (error) {
      throw deleteError(`cannot delete the payload of '${containerPath}': ${getErrorMessage(error)}`, error);
    }
  }
}

/**
 * Removes the manifest and the container directory itself. Only ever called
 * once {@link removeTrashPayload} has reported the payload gone, so an
 * interruption here can strand nothing but an empty directory.
 */
export async function removeEmptiedTrashContainer(containerPath: string): Promise<void> {
  try {
    await fs.rm(containerPath, { recursive: true, force: true });
  } catch (error) {
    throw deleteError(`cannot delete trash container '${containerPath}': ${getErrorMessage(error)}`, error);
  }
}

/** Payload first, then manifest and container. */
export async function removeTrashContainer(containerPath: string): Promise<void> {
  await removeTrashPayload(containerPath);
  await removeEmptiedTrashContainer(containerPath);
}

/** Whether a set-aside payload is waiting to be finished off. */
export async function hasPayloadPendingDeletion(containerPath: string): Promise<boolean> {
  try {
    return (await fs.readdir(containerPath)).some((name) => name.startsWith(DELETING_PREFIX));
  } catch {
    return false;
  }
}
