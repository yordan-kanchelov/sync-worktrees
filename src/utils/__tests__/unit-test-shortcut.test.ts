import { afterEach, describe, expect, it, vi } from "vitest";

import { setEnvVar } from "../../__tests__/test-utils";
import { ENV_CONSTANTS } from "../../constants";
import { isUnitTestShortcutEnabled, warnIfUnitTestShortcutEnabled } from "../unit-test-shortcut";

const SHORTCUT = ENV_CONSTANTS.UNIT_TEST_SHORTCUT;

describe("unit-test shortcut", () => {
  const originalShortcut = process.env[SHORTCUT];
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    setEnvVar(SHORTCUT, originalShortcut);
    setEnvVar("NODE_ENV", originalNodeEnv);
  });

  it("is enabled for the vitest worker, which setup.ts opted in with its own pid", () => {
    expect(process.env[SHORTCUT]).toBe(String(process.pid));
    expect(isUnitTestShortcutEnabled()).toBe(true);
  });

  it("is disabled when the variable is unset, whatever NODE_ENV says", () => {
    delete process.env[SHORTCUT];
    for (const nodeEnv of ["test", "development", "production", undefined]) {
      setEnvVar("NODE_ENV", nodeEnv);
      expect(isUnitTestShortcutEnabled()).toBe(false);
    }
  });

  it("ignores values that do not name this process, including one inherited from a parent", () => {
    for (const value of ["1", "true", String(process.pid + 1), ` ${process.pid}`]) {
      process.env[SHORTCUT] = value;
      expect(isUnitTestShortcutEnabled()).toBe(false);
    }
  });

  describe("warnIfUnitTestShortcutEnabled", () => {
    it("names the variable and the disabled safety features when the shortcut is active", () => {
      process.env[SHORTCUT] = String(process.pid);
      const write = vi.fn();

      warnIfUnitTestShortcutEnabled(write);

      expect(write).toHaveBeenCalledTimes(1);
      const message: string = write.mock.calls[0][0];
      expect(message).toContain(`${SHORTCUT} is active for this process (pid ${process.pid})`);
      expect(message).toContain("DISABLED");
      for (const feature of ["locking", "inactivity timeouts", "trash reaping", "git gc"]) {
        expect(message).toContain(feature);
      }
    });

    it("stays silent when the shortcut is not active for this process", () => {
      const write = vi.fn();

      delete process.env[SHORTCUT];
      warnIfUnitTestShortcutEnabled(write);
      process.env[SHORTCUT] = "1";
      warnIfUnitTestShortcutEnabled(write);

      expect(write).not.toHaveBeenCalled();
    });
  });
});
