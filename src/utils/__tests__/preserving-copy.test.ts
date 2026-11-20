import * as fs from "fs/promises";
import * as path from "path";

import { afterEach, describe, expect, it } from "vitest";

import { symlinksSupported } from "../../__tests__/helpers/symlink-support";
import { cleanupTempDirectories, createTempDirectory } from "../../__tests__/test-utils";
import { copyTreePreservingSymlinks } from "../preserving-copy";

const RELATIVE_TARGET = path.join("..", "b", "file");

async function makeTree(root: string): Promise<{ source: string; copy: string }> {
  const source = path.join(root, "source");
  await fs.mkdir(path.join(source, "a"), { recursive: true });
  await fs.mkdir(path.join(source, "b"), { recursive: true });
  await fs.mkdir(path.join(source, "empty"), { recursive: true });
  await fs.writeFile(path.join(source, "b", "file"), "linked content");
  await fs.writeFile(path.join(source, "plain.txt"), "plain content");
  await fs.symlink(RELATIVE_TARGET, path.join(source, "a", "link"));
  return { source, copy: path.join(root, "copy") };
}

describe("copyTreePreservingSymlinks", () => {
  afterEach(async () => {
    await cleanupTempDirectories();
  });

  it("leaves a relative link target verbatim, so the copy still resolves once the source is gone", async (ctx) => {
    if (!(await symlinksSupported())) {
      ctx.skip("this host cannot create symlinks");
      return;
    }
    const { source, copy } = await makeTree(await createTempDirectory());

    await copyTreePreservingSymlinks(source, copy);
    await fs.rm(source, { recursive: true, force: true });

    await expect(fs.readlink(path.join(copy, "a", "link"))).resolves.toBe(RELATIVE_TARGET);
    await expect(fs.readFile(path.join(copy, "a", "link"), "utf-8")).resolves.toBe("linked content");
  });

  it("copies ordinary files, permissions and empty directories unchanged", async (ctx) => {
    if (!(await symlinksSupported())) {
      ctx.skip("this host cannot create symlinks");
      return;
    }
    const { source, copy } = await makeTree(await createTempDirectory());
    await fs.writeFile(path.join(source, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });

    await copyTreePreservingSymlinks(source, copy);
    await fs.rm(source, { recursive: true, force: true });

    await expect(fs.readFile(path.join(copy, "plain.txt"), "utf-8")).resolves.toBe("plain content");
    await expect(fs.readFile(path.join(copy, "b", "file"), "utf-8")).resolves.toBe("linked content");
    await expect(fs.stat(path.join(copy, "empty")).then((stats) => stats.isDirectory())).resolves.toBe(true);
    if (process.platform !== "win32") {
      await expect(fs.stat(path.join(copy, "run.sh")).then((stats) => stats.mode & 0o777)).resolves.toBe(0o755);
    }
  });

  it("forwards the caller's filter rather than replacing its options", async (ctx) => {
    if (!(await symlinksSupported())) {
      ctx.skip("this host cannot create symlinks");
      return;
    }
    const { source, copy } = await makeTree(await createTempDirectory());
    await fs.mkdir(copy, { recursive: true });
    await fs.writeFile(path.join(copy, "plain.txt"), "stale content");
    await fs.writeFile(path.join(copy, "keep-me"), "written by the destination");

    await copyTreePreservingSymlinks(source, copy, {
      filter: (entry) => path.basename(entry) !== "plain.txt",
    });

    await expect(fs.readFile(path.join(copy, "plain.txt"), "utf-8")).resolves.toBe("stale content");
    await expect(fs.readFile(path.join(copy, "keep-me"), "utf-8")).resolves.toBe("written by the destination");
    await expect(fs.readlink(path.join(copy, "a", "link"))).resolves.toBe(RELATIVE_TARGET);
  });
});
