import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMockLogger } from "../../__tests__/test-utils";
import { GitService } from "../git.service";
import { PathResolutionService } from "../path-resolution.service";
import { WorktreeMetadataService } from "../worktree-metadata.service";

import type { GitServiceOptions } from "../git.service";
import type { Logger } from "../logger.service";

// Real git, no mocks. A release tag named after the default branch resolves
// before refs/heads/<default> — git resolves a bare name through refs/tags/
// first and only warns on stderr — so the commit recorded as a new worktree's
// parent came from the tag, freezing `createdFrom.commit` at whatever the tag
// points at instead of the branch tip.
describe("GitService worktree metadata with a tag shadowing the default branch", () => {
  let tempDir: string;
  let remote: string;
  let worktreeDir: string;
  let bareRepoDir: string;
  let featurePath: string;
  let logger: Logger;
  let gitService: GitService;
  let taggedCommit: string;
  let mainTipCommit: string;

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-ambiguous-default-")));
    remote = path.join(tempDir, "remote", "app.git");
    worktreeDir = path.join(tempDir, "worktrees");
    bareRepoDir = path.join(tempDir, ".bare", "app");
    featurePath = new PathResolutionService().getBranchWorktreePath(worktreeDir, "feature");

    await fs.mkdir(path.dirname(remote), { recursive: true });
    await simpleGit().init(["--bare", remote]);

    const seedDir = path.join(tempDir, "seed");
    await fs.mkdir(seedDir);
    const seed = simpleGit(seedDir);
    await seed.init();
    await seed.addConfig("user.name", "Test User");
    await seed.addConfig("user.email", "test@example.com");
    await fs.writeFile(path.join(seedDir, "README.md"), "# app");
    await seed.add(".");
    await seed.commit("Initial commit");
    await seed.branch(["-M", "main"]);
    await seed.addRemote("origin", remote);
    await seed.push("origin", "main");
    // A release tag named after the default branch, left behind at an older commit.
    await seed.addTag("main");
    await seed.pushTags("origin");
    taggedCommit = (await seed.revparse(["refs/tags/main^{commit}"])).trim();

    await fs.writeFile(path.join(seedDir, "README.md"), "# app v2");
    await seed.add(".");
    await seed.commit("Second commit");
    await seed.push(["origin", "refs/heads/main:refs/heads/main"]);
    mainTipCommit = (await seed.revparse(["refs/heads/main"])).trim();

    await seed.checkoutLocalBranch("feature");
    await fs.writeFile(path.join(seedDir, "feature.txt"), "v1");
    await seed.add(".");
    await seed.commit("Add feature");
    await seed.push(["origin", "refs/heads/feature:refs/heads/feature"]);
    await simpleGit(remote).raw(["symbolic-ref", "HEAD", "refs/heads/main"]);

    logger = createMockLogger();
    const options: GitServiceOptions = { repoUrl: `file://${remote}`, worktreeDir, bareRepoDir };
    gitService = new GitService(options, logger);
    await gitService.initialize();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("records the default branch tip as the parent commit, not the same-named tag", async () => {
    expect(taggedCommit).not.toBe(mainTipCommit);

    await gitService.addWorktree("feature", featurePath);

    const metadata = await new WorktreeMetadataService(logger).loadMetadataFromPath(bareRepoDir, featurePath);
    expect(metadata?.createdFrom.branch).toBe("main");
    expect(metadata?.createdFrom.commit).toBe(mainTipCommit);
    expect(metadata?.createdFrom.commit).not.toBe(taggedCommit);
  });
});
