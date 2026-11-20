import { execFile } from "node:child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { promisify } from "node:util";

import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import packageJson from "../../../package.json" with { type: "json" };
import { TEST_URLS } from "../../__tests__/test-utils";
import { findConfigUpTree } from "../../utils/config-discovery";

const execFileAsync = promisify(execFile);

let bundleDir: string;
let bundlePath: string;
const fixtureDirs: string[] = [];

async function makeFixtureDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-esm-reload-"));
  fixtureDirs.push(dir);
  return dir;
}

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

describe("config reload under real Node", () => {
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

  it("re-reads a .js config that resolves as CommonJS, not just its children", async () => {
    const dir = await makeFixtureDir();
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "fixture", type: "commonjs" }));
    const configPath = path.join(dir, "sync-worktrees.config.js");
    await fs.writeFile(configPath, commonJsConfigSource(`"first"`));

    await expect(
      reloadUnderRealNode(configPath, { file: configPath, contents: commonJsConfigSource(`"second"`) }),
    ).resolves.toEqual({ first: "first", second: "second" });
  }, 60_000);

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

  it("gives a reloaded config the same process.argv the first load saw", async () => {
    const dir = await makeFixtureDir();
    const configPath = path.join(dir, "sync-worktrees.config.mjs");
    await fs.writeFile(configPath, configSource("JSON.stringify(process.argv.slice(2))"));

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

  it.each([
    ["awaits a timer that outlives the reload", "await new Promise((resolve) => setTimeout(resolve, 600_000));\n"],
    ["spins in a loop that never ends", "while (true) {}\n"],
  ])(
    "rejects rather than hangs when a reloaded config %s",
    async (_label, preamble) => {
      const dir = await makeFixtureDir();
      const configPath = path.join(dir, "sync-worktrees.config.mjs");
      await fs.writeFile(configPath, configSource(`"first"`));

      const script = `
      import { writeFile } from "node:fs/promises";
      import { ConfigLoaderService } from ${JSON.stringify(bundlePath)};
      const loader = new ConfigLoaderService({ reloadTimeoutMs: 1_000 });
      await loader.loadConfigFile(${JSON.stringify(configPath)});
      await writeFile(${JSON.stringify(configPath)}, ${JSON.stringify(configSource(`"second"`, preamble))});
      const started = Date.now();
      try {
        await loader.loadConfigFile(${JSON.stringify(configPath)});
        console.log(JSON.stringify({ outcome: "resolved" }));
      } catch (error) {
        console.log(JSON.stringify({ outcome: "rejected", message: error.message, elapsedMs: Date.now() - started }));
      }
    `;
      const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
        timeout: 20_000,
        killSignal: "SIGKILL",
      });

      const result = JSON.parse(stdout.trim().split("\n").at(-1) as string) as {
        outcome: string;
        message?: string;
        elapsedMs?: number;
      };
      expect(result.outcome).toBe("rejected");
      expect(result.message).toContain(
        "reloading 'sync-worktrees.config.mjs' did not finish within 1s, so it was stopped and the configuration " +
          "already loaded stays in effect",
      );
      expect(result.message).toContain(`(${configPath})`);
      expect(result.elapsedMs).toBeLessThan(10_000);
    },
    60_000,
  );
});

describe("TypeScript configs under real Node", () => {
  async function loadThroughRealNode(startDir: string): Promise<{ found: string | null; name?: string }> {
    const found = await findConfigUpTree(startDir);
    const script = `
      import { ConfigLoaderService } from ${JSON.stringify(bundlePath)};
      const loader = new ConfigLoaderService();
      const found = ${JSON.stringify(found)};
      const out = { found };
      if (found) out.name = (await loader.loadConfigFile(found)).repositories[0].name;
      console.log(JSON.stringify(out));
    `;
    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script]);
    return JSON.parse(stdout.trim().split("\n").at(-1) as string) as { found: string | null; name?: string };
  }

  async function loadErrorFromRealNode(configPath: string): Promise<string> {
    const script = `
      import { ConfigLoaderService } from ${JSON.stringify(bundlePath)};
      const loader = new ConfigLoaderService();
      try {
        await loader.loadConfigFile(${JSON.stringify(configPath)});
        console.log(JSON.stringify({ message: "loaded without error" }));
      } catch (error) {
        console.log(JSON.stringify({ message: error.message }));
      }
    `;
    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script]);
    return (JSON.parse(stdout.trim().split("\n").at(-1) as string) as { message: string }).message;
  }

  it("finds and loads a sync-worktrees.config.ts with type annotations", async () => {
    const dir = await makeFixtureDir();
    const configPath = path.join(dir, "sync-worktrees.config.ts");
    await fs.writeFile(
      configPath,
      `interface Repo { name: string; repoUrl: string; worktreeDir: string }\n` +
        `const repos: Repo[] = [{ name: "typed", repoUrl: "${TEST_URLS.github}", worktreeDir: "./worktrees" }];\n` +
        `export default { repositories: repos } satisfies { repositories: Repo[] };`,
    );

    await expect(loadThroughRealNode(dir)).resolves.toEqual({ found: configPath, name: "typed" });
  }, 60_000);

  it("finds a .ts config from a nested directory", async () => {
    const dir = await makeFixtureDir();
    const configPath = path.join(dir, "sync-worktrees.config.ts");
    const nested = path.join(dir, "packages", "web");
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(
      configPath,
      `type Name = "nested";\nconst name: Name = "nested";\n` +
        `export default { repositories: [{ name, repoUrl: "${TEST_URLS.github}", worktreeDir: "./worktrees" }] };`,
    );

    await expect(loadThroughRealNode(nested)).resolves.toEqual({ found: configPath, name: "nested" });
  }, 60_000);

  it("explains non-erasable syntax instead of surfacing 'strip-only mode' alone", async () => {
    const dir = await makeFixtureDir();
    const configPath = path.join(dir, "sync-worktrees.config.ts");
    await fs.writeFile(
      configPath,
      `enum Mode { Worktree = "worktree" }\n` +
        `export default { repositories: [{ name: "e", repoUrl: "${TEST_URLS.github}", worktreeDir: "./w", mode: Mode.Worktree }] };`,
    );

    const message = await loadErrorFromRealNode(configPath);
    expect(message).toContain("enum");
    expect(message).toContain(configPath);
    expect(message).toContain("erasing type annotations");
    expect(message).toContain(".js/.mjs config");
  }, 60_000);

  it('names the fix for a .ts config under a "type": "commonjs" package', async () => {
    const dir = await makeFixtureDir();
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "fixture", type: "commonjs" }));
    const configPath = path.join(dir, "sync-worktrees.config.ts");
    await fs.writeFile(
      configPath,
      `const name: string = "cjs-pkg";\n` +
        `export default { repositories: [{ name, repoUrl: "${TEST_URLS.github}", worktreeDir: "./w" }] };`,
    );

    const message = await loadErrorFromRealNode(configPath);
    expect(message).toContain("Unexpected token 'export'");
    expect(message).toContain('add "type": "module" to the nearest package.json');
  }, 60_000);

  it("re-reads a .ts config, and still explains non-erasable syntax, on reload", async () => {
    const dir = await makeFixtureDir();
    const configPath = path.join(dir, "sync-worktrees.config.ts");
    const source = (name: string, preamble = "") =>
      `${preamble}const n: string = ${JSON.stringify(name)};\n` +
      `export default { repositories: [{ name: n, repoUrl: "${TEST_URLS.github}", worktreeDir: "./w" }] };`;
    await fs.writeFile(configPath, source("first"));

    const script = `
      import { writeFile } from "node:fs/promises";
      import { ConfigLoaderService } from ${JSON.stringify(bundlePath)};
      const loader = new ConfigLoaderService();
      const first = (await loader.loadConfigFile(${JSON.stringify(configPath)})).repositories[0].name;
      await writeFile(${JSON.stringify(configPath)}, ${JSON.stringify(source("second"))});
      const second = (await loader.loadConfigFile(${JSON.stringify(configPath)})).repositories[0].name;
      await writeFile(${JSON.stringify(configPath)}, ${JSON.stringify(source("third", "namespace N { export const x = 1; }\n"))});
      let third;
      try {
        await loader.loadConfigFile(${JSON.stringify(configPath)});
        third = "loaded without error";
      } catch (error) {
        third = error.message;
      }
      console.log(JSON.stringify({ first, second, third }));
    `;
    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script]);
    const result = JSON.parse(stdout.trim().split("\n").at(-1) as string) as Record<string, string>;

    expect(result.first).toBe("first");
    expect(result.second).toBe("second");
    expect(result.third).toContain("namespace");
    expect(result.third).toContain("erasing type annotations");
  }, 60_000);
});

describe("hooks.timeoutMs under real Node", () => {
  async function loadHooksThroughRealNode(configBody: string): Promise<{ hooks?: unknown; message?: string }> {
    const dir = await makeFixtureDir();
    const configPath = path.join(dir, "sync-worktrees.config.js");
    await fs.writeFile(configPath, configBody);
    const script = `
      import { ConfigLoaderService } from ${JSON.stringify(bundlePath)};
      const loader = new ConfigLoaderService();
      try {
        const config = await loader.loadConfigFile(${JSON.stringify(configPath)});
        console.log(JSON.stringify({ hooks: config.repositories[0].hooks }));
      } catch (error) {
        console.log(JSON.stringify({ message: error.message }));
      }
    `;
    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script]);
    return JSON.parse(stdout.trim().split("\n").at(-1) as string) as { hooks?: unknown; message?: string };
  }

  const repo = (extra: string): string =>
    `export default { repositories: [{ name: "r", repoUrl: "${TEST_URLS.github}", worktreeDir: "./w"${extra} }] };`;

  it("resolves a configured timeout on a repository entry", async () => {
    const result = await loadHooksThroughRealNode(repo(`, hooks: { onBranchCreated: ["echo hi"], timeoutMs: 600000 }`));

    expect(result.hooks).toEqual({ onBranchCreated: ["echo hi"], timeoutMs: 600000 });
  });

  it("keeps a configured 0 as 0 rather than dropping it as falsy", async () => {
    const result = await loadHooksThroughRealNode(repo(`, hooks: { onBranchCreated: ["echo hi"], timeoutMs: 0 }`));

    expect(result.hooks).toEqual({ onBranchCreated: ["echo hi"], timeoutMs: 0 });
  });

  it("refuses a non-integer, a negative, a non-number and an over-32-bit delay", async () => {
    for (const value of ["1.5", "-1", '"600000"', "NaN", "2147483648", "31536000000"]) {
      const result = await loadHooksThroughRealNode(repo(`, hooks: { timeoutMs: ${value} }`));

      expect(result.hooks).toBeUndefined();
      expect(result.message).toBe(
        "Invalid configuration for 'repositories[0].hooks.timeoutMs' (repository 'r'): must be a whole number of " +
          `milliseconds from 0 to 2147483647 (0 disables the timeout), got ${value}`,
      );
    }
  }, 60_000);

  it("accepts the ceiling itself, so the bound is off by nothing", async () => {
    const result = await loadHooksThroughRealNode(repo(`, hooks: { timeoutMs: 2147483647 }`));

    expect(result.hooks).toEqual({ timeoutMs: 2147483647 });
  });

  it("refuses it under defaults too, naming defaults", async () => {
    const result = await loadHooksThroughRealNode(
      `export default { defaults: { hooks: { timeoutMs: -5 } }, ` +
        `repositories: [{ name: "r", repoUrl: "${TEST_URLS.github}", worktreeDir: "./w" }] };`,
    );

    expect(result.message).toBe(
      "Invalid configuration for 'defaults.hooks.timeoutMs': must be a whole number of milliseconds " +
        "from 0 to 2147483647 (0 disables the timeout), got -5",
    );
  });
});
