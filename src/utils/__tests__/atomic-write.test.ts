import * as fs from "fs/promises";
import * as path from "path";

import { afterEach, describe, expect, it } from "vitest";

import { cleanupTempDirectories, createTempDirectory } from "../../__tests__/test-utils";
import { atomicWriteFile } from "../atomic-write";

describe("atomicWriteFile", () => {
  afterEach(async () => {
    await cleanupTempDirectories();
  });

  it("lets concurrent writes of one path all resolve, leaving one complete payload and no temp files", async () => {
    const dir = await createTempDirectory();
    const file = path.join(dir, "state.json");
    const payloads = Array.from({ length: 5 }, (_, i) => JSON.stringify({ writer: i }));

    await expect(Promise.all(payloads.map((p) => atomicWriteFile(file, p)))).resolves.toBeDefined();

    expect(payloads).toContain(await fs.readFile(file, "utf-8"));
    expect(await fs.readdir(dir)).toEqual(["state.json"]);
  });
});
