import { execFile } from "node:child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { promisify } from "node:util";

import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import packageJson from "../../../package.json" with { type: "json" };
import { TEST_URLS } from "../../__tests__/test-utils";

const execFileAsync = promisify(execFile);

// Under vitest, `import()` inside the loader is served by Vite's module
// runner, which resolves and caches differently from Node. A reload assertion
// that only runs in-process can therefore pass while a real `node` process
// keeps handing the daemon its first-loaded values — which is exactly the bug
// this file is about. So the loader is bundled once with esbuild (the same
// bundler `pnpm build` uses) and driven from a child `node` process, where the
// module registry is Node's own.
//
// The bundle and every fixture live under os.tmpdir(): a fixture written
// inside this repository would silently inherit its `"type": "module"`, which
// decides whether a `.js` config is ESM or CommonJS and so decides what is
// being tested. node_modules is symlinked in so the bundle's `packages:
// "external"` imports still resolve.
let bundleDir: string;
let bundlePath: string;
const fixtureDirs: string[] = [];

async function makeFixtureDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-esm-reload-"));
  fixtureDirs.push(dir);
  return dir;
}

/**
 * Loads `configPath` twice through the real loader in one child `node`
 * process, running `mutate` between the two loads, and reports the repository
 * name each load saw. One process, one loader instance: the shape of an MCP
 * server handling a second `load_config`, which holds a single
 * `ConfigLoaderService` for the life of the process. The interactive UI's `r`
 * is the *other* shape — a second, freshly constructed loader — and has its
 * own test below.
 */
async function reloadUnderRealNode(
  configPath: string,
  mutate: { file: string; contents: string },
): Promise<{ first: string; second: string }> {
  const script = `
    import { writeFile } from "node:fs/promises";
    import { ConfigLoaderService } from ${JSON.stringify(bundlePath)};
    const loader = new ConfigLoaderService();
    const first = await loader.loadConfigFile(${JSON.stringify(configPath)});
    await writeFile(${JSON.stringify(mutate.file)}, ${JSON.stringify(mutate.contents)});
    const second = await loader.loadConfigFile(${JSON.stringify(configPath)});
    console.log(JSON.stringify({ first: first.repositories[0].name, second: second.repositories[0].name }));
  `;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script]);
  return JSON.parse(stdout.trim().split("\n").at(-1) as string) as { first: string; second: string };
}

function configSource(nameExpression: string, preamble = ""): string {
  return `${preamble}export default { repositories: [{ name: ${nameExpression}, repoUrl: "${TEST_URLS.github}", worktreeDir: "./worktrees" }] };`;
}

function commonJsConfigSource(nameExpression: string, preamble = ""): string {
  return `${preamble}module.exports = { repositories: [{ name: ${nameExpression}, repoUrl: "${TEST_URLS.github}", worktreeDir: "./worktrees" }] };`;
}

describe("config reload under real Node", () => {
  beforeAll(async () => {
    bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-esm-reload-bundle-"));
    bundlePath = path.join(bundleDir, "config-loader.mjs");
    await fs.symlink(path.join(process.cwd(), "node_modules"), path.join(bundleDir, "node_modules"), "dir");
    await build({
      entryPoints: [path.join(process.cwd(), "src/services/config-loader.service.ts")],
      outfile: bundlePath,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      packages: "external",
      define: { __SYNC_WORKTREES_VERSION__: JSON.stringify(packageJson.version) },
    });
  }, 60_000);

  afterAll(async () => {
    await fs.rm(bundleDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await Promise.all(fixtureDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("re-reads a sibling module a .mjs config imports", async () => {
    const dir = await makeFixtureDir();
    const child = path.join(dir, "repos.mjs");
    const configPath = path.join(dir, "sync-worktrees.config.mjs");
    await fs.writeFile(child, `export const name = "first";`);
    await fs.writeFile(configPath, configSource("name", `import { name } from "./repos.mjs";\n`));

    await expect(
      reloadUnderRealNode(configPath, { file: child, contents: `export const name = "second";` }),
    ).resolves.toEqual({
      first: "first",
      second: "second",
    });
  }, 60_000);

  // Same graph, but the config is a `.js` file in a `"type": "module"`
  // package — the shape `sync-worktrees init` writes there.
  it('re-reads a sibling module a .js config in a "type": "module" package imports', async () => {
    const dir = await makeFixtureDir();
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "fixture", type: "module" }));
    const child = path.join(dir, "repos.js");
    const configPath = path.join(dir, "sync-worktrees.config.js");
    await fs.writeFile(child, `export const name = "first";`);
    await fs.writeFile(configPath, configSource("name", `import { name } from "./repos.js";\n`));

    await expect(
      reloadUnderRealNode(configPath, { file: child, contents: `export const name = "second";` }),
    ).resolves.toEqual({
      first: "first",
      second: "second",
    });
  }, 60_000);

  // A `.js` config in a CommonJS package is loaded through `import()` too,
  // and Node's ESM→CommonJS bridge ignores the `?t=` query the loader used to
  // rely on. These configs did not reload even at the top level: editing the
  // config file itself changed nothing until the process restarted.
  it("re-reads a .js config that resolves as CommonJS, not just its children", async () => {
    const dir = await makeFixtureDir();
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "fixture", type: "commonjs" }));
    const configPath = path.join(dir, "sync-worktrees.config.js");
    await fs.writeFile(configPath, commonJsConfigSource(`"first"`));

    await expect(
      reloadUnderRealNode(configPath, { file: configPath, contents: commonJsConfigSource(`"second"`) }),
    ).resolves.toEqual({ first: "first", second: "second" });
  }, 60_000);

  // A config is user-supplied JavaScript and may leave a handle open — an
  // interval, a socket, a watcher. Evaluating it on a thread that is then left
  // running means the daemon can never exit: a one-shot `sync-worktrees` run
  // would hang after its work was done, and `q` in the interactive UI would
  // stop responding. The child here must exit on its own, without a signal.
  it("does not keep the process alive when a reloaded config leaves a handle open", async () => {
    const dir = await makeFixtureDir();
    const configPath = path.join(dir, "sync-worktrees.config.mjs");
    await fs.writeFile(configPath, configSource(`"first"`));

    const script = `
      import { writeFile } from "node:fs/promises";
      import { ConfigLoaderService } from ${JSON.stringify(bundlePath)};
      const loader = new ConfigLoaderService();
      await loader.loadConfigFile(${JSON.stringify(configPath)});
      await writeFile(${JSON.stringify(configPath)}, ${JSON.stringify(configSource(`"second"`, "setInterval(() => {}, 1000);\n"))});
      const second = await loader.loadConfigFile(${JSON.stringify(configPath)});
      console.log(second.repositories[0].name);
    `;
    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
      timeout: 20_000,
      killSignal: "SIGKILL",
    });

    expect(stdout.trim()).toBe("second");
  }, 60_000);

  // The `.cjs` path is fixed separately, by clearing the require-cache
  // subtree. Pinned here so that the two mechanisms cannot drift.
  it("re-reads a sibling module a .cjs config requires", async () => {
    const dir = await makeFixtureDir();
    const child = path.join(dir, "repos.cjs");
    const configPath = path.join(dir, "sync-worktrees.config.cjs");
    await fs.writeFile(child, `module.exports = { name: "first" };`);
    await fs.writeFile(configPath, commonJsConfigSource("child.name", `const child = require("./repos.cjs");\n`));

    await expect(
      reloadUnderRealNode(configPath, { file: child, contents: `module.exports = { name: "second" };` }),
    ).resolves.toEqual({ first: "first", second: "second" });
  }, 60_000);

  // The shape the interactive UI actually has: `handleReload` constructs a
  // brand new ConfigLoaderService on every `r`, and so does every CLI command.
  // What makes the second load a *reload* is Node's module registry, which is
  // per process, not per object — so the set of already-evaluated paths has to
  // be module-level. Move it onto the instance and every entry point sees a
  // first load forever, reloads in-process, and the staleness is back; every
  // other test here reuses one loader and would not notice.
  it("re-reads an imported module when the reload goes through a second ConfigLoaderService", async () => {
    const dir = await makeFixtureDir();
    const child = path.join(dir, "repos.mjs");
    const configPath = path.join(dir, "sync-worktrees.config.mjs");
    await fs.writeFile(child, `export const name = "first";`);
    await fs.writeFile(configPath, configSource("name", `import { name } from "./repos.mjs";\n`));

    const script = `
      import { writeFile } from "node:fs/promises";
      import { ConfigLoaderService } from ${JSON.stringify(bundlePath)};
      const startup = new ConfigLoaderService();
      const first = await startup.buildRepositories(${JSON.stringify(configPath)});
      await writeFile(${JSON.stringify(child)}, ${JSON.stringify(`export const name = "second";`)});
      const reload = new ConfigLoaderService();
      const second = await reload.buildRepositories(${JSON.stringify(configPath)});
      console.log(JSON.stringify({
        first: first.repositories[0].name,
        second: second.repositories[0].name,
      }));
    `;
    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script]);

    expect(JSON.parse(stdout.trim().split("\n").at(-1) as string)).toEqual({ first: "first", second: "second" });
  }, 60_000);

  // A config may branch on CLI flags, and `process.argv.slice(2)` is how it
  // would read them. The reload thread has to present the same array: the
  // Worker `argv` option only *appends*, and a `data:` URL worker has no
  // script-path slot to append after, so handing it `process.argv.slice(2)`
  // silently shifts every flag down one.
  it("gives a reloaded config the same process.argv the first load saw", async () => {
    const dir = await makeFixtureDir();
    const configPath = path.join(dir, "sync-worktrees.config.mjs");
    await fs.writeFile(configPath, configSource("JSON.stringify(process.argv.slice(2))"));

    // Run from a real script file rather than `-e`, because `node -e` has no
    // script-path slot in `process.argv` either and would hide the very
    // off-by-one this pins.
    const runnerPath = path.join(dir, "runner.mjs");
    await fs.writeFile(
      runnerPath,
      `
      import { ConfigLoaderService } from ${JSON.stringify(bundlePath)};
      const loader = new ConfigLoaderService();
      const first = await loader.loadConfigFile(${JSON.stringify(configPath)});
      const second = await loader.loadConfigFile(${JSON.stringify(configPath)});
      console.log(JSON.stringify({ first: first.repositories[0].name, second: second.repositories[0].name }));
    `,
    );
    const { stdout } = await execFileAsync(process.execPath, [runnerPath, "--filter", "alpha"]);

    const seen = JSON.parse(stdout.trim().split("\n").at(-1) as string) as { first: string; second: string };
    expect(JSON.parse(seen.first)).toEqual(["--filter", "alpha"]);
    expect(seen.second).toBe(seen.first);
  }, 60_000);

  // A config is user-supplied JavaScript: it can call `process.exit()`, which
  // on a worker thread kills the thread and nothing else. Without an `exit`
  // handler the reload promise is never settled and `r` wedges the UI for
  // good, so the exit has to come back as a rejection the caller can report.
  it("rejects rather than hangs when a reloaded config exits the thread", async () => {
    const dir = await makeFixtureDir();
    const configPath = path.join(dir, "sync-worktrees.config.mjs");
    await fs.writeFile(configPath, configSource(`"first"`));

    const script = `
      import { writeFile } from "node:fs/promises";
      import { ConfigLoaderService } from ${JSON.stringify(bundlePath)};
      const loader = new ConfigLoaderService();
      await loader.loadConfigFile(${JSON.stringify(configPath)});
      await writeFile(${JSON.stringify(configPath)}, ${JSON.stringify(configSource(`"second"`, "process.exit(3);\n"))});
      try {
        await loader.loadConfigFile(${JSON.stringify(configPath)});
        console.log(JSON.stringify({ outcome: "resolved" }));
      } catch (error) {
        console.log(JSON.stringify({ outcome: "rejected", message: error.message }));
      }
    `;
    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
      timeout: 20_000,
      killSignal: "SIGKILL",
    });

    const result = JSON.parse(stdout.trim().split("\n").at(-1) as string) as { outcome: string; message?: string };
    expect(result.outcome).toBe("rejected");
    expect(result.message).toMatch(/worker exited with code 3/);
  }, 60_000);
});
