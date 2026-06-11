import * as fs from "fs/promises";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { fileExists, probePathExists } from "../file-exists";

import type { Mock } from "vitest";

vi.mock("fs/promises");

const errnoError = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: probe failed`), { code });

describe("fileExists", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns true when the path is accessible", async () => {
    (fs.access as Mock<any>).mockResolvedValue(undefined);

    await expect(fileExists("/some/path")).resolves.toBe(true);
  });

  it("returns false on any access error", async () => {
    (fs.access as Mock<any>).mockRejectedValue(errnoError("ENOENT"));

    await expect(fileExists("/some/path")).resolves.toBe(false);
  });
});

describe("probePathExists", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 'exists' when the path is accessible", async () => {
    (fs.access as Mock<any>).mockResolvedValue(undefined);

    await expect(probePathExists("/some/path")).resolves.toBe("exists");
  });

  it("returns 'missing' for ENOENT", async () => {
    (fs.access as Mock<any>).mockRejectedValue(errnoError("ENOENT"));

    await expect(probePathExists("/some/path")).resolves.toBe("missing");
  });

  it("returns 'missing' for ENOTDIR", async () => {
    (fs.access as Mock<any>).mockRejectedValue(errnoError("ENOTDIR"));

    await expect(probePathExists("/some/path")).resolves.toBe("missing");
  });

  it.each(["EMFILE", "ENFILE", "EINTR", "EACCES"])("returns 'unknown' for %s", async (code) => {
    (fs.access as Mock<any>).mockRejectedValue(errnoError(code));

    await expect(probePathExists("/some/path")).resolves.toBe("unknown");
  });

  it("returns 'unknown' for errors without a code", async () => {
    (fs.access as Mock<any>).mockRejectedValue(new Error("mystery failure"));

    await expect(probePathExists("/some/path")).resolves.toBe("unknown");
  });
});
