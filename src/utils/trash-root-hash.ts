import { createHash } from "crypto";
import * as path from "path";

export function computeTrashRootHash(trashRoot: string): string {
  return createHash("sha256").update(path.resolve(trashRoot)).digest("hex").slice(0, 16);
}
