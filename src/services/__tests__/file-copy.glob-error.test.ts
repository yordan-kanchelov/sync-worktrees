import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FileCopyService } from "../file-copy.service";

import type * as GlobModule from "glob";

// glob 13 answers a missing, unreadable or non-directory `cwd` with an empty
// list rather than a rejection, so the failure path cannot be reached through
// the filesystem -- the expansion is stubbed instead. The point of the test is
// the contract: a pattern that could not be expanded is reported, not dropped.
vi.mock("glob", async (importOriginal) => {
  const actual = await importOriginal<typeof GlobModule>();
  return { ...actual, glob: vi.fn() };
});

const { glob } = await import("glob");
const globMock = vi.mocked(glob);

describe("FileCopyService expansion failures", () => {
  let tempDir: string;
  let sourceDir: string;
  let destDir: string;
  let service: FileCopyService;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-copy-glob-error-"));
    sourceDir = path.join(tempDir, "source");
    destDir = path.join(tempDir, "dest");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.mkdir(destDir, { recursive: true });
    service = new FileCopyService();
    globMock.mockReset();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("surfaces the pattern that could not be expanded in result.errors", async () => {
    globMock.mockRejectedValue(new Error("EACCES: permission denied, scandir"));

    const result = await service.copyFiles(sourceDir, destDir, ["**/.env"]);

    expect(result.errors).toEqual([{ file: "**/.env", error: "EACCES: permission denied, scandir" }]);
    expect(result.copied).toEqual([]);
  });

  it("keeps expanding the remaining patterns after one of them fails", async () => {
    await fs.writeFile(path.join(sourceDir, ".npmrc"), "registry=");
    globMock
      .mockRejectedValueOnce(new Error("ELOOP: too many symbolic links"))
      .mockResolvedValueOnce([".npmrc"] as never);

    const result = await service.copyFiles(sourceDir, destDir, ["**/.env", ".npmrc"]);

    expect(result.errors).toEqual([{ file: "**/.env", error: "ELOOP: too many symbolic links" }]);
    expect(result.copied).toEqual([".npmrc"]);
  });

  it("reports a rejection that is not an Error in its string form", async () => {
    globMock.mockRejectedValue("walk aborted");

    const result = await service.copyFiles(sourceDir, destDir, [".env"]);

    expect(result.errors).toEqual([{ file: ".env", error: "walk aborted" }]);
  });
});
