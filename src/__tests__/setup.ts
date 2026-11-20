import { afterEach, vi } from "vitest";

import { ENV_CONSTANTS } from "../constants";

process.env.NODE_ENV = "test";

process.env[ENV_CONSTANTS.UNIT_TEST_SHORTCUT] = String(process.pid);

process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

process.env.COLUMNS = process.env.COLUMNS || "80";
process.env.LINES = process.env.LINES || "24";

global.console = {
  ...console,
  log: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
};

afterEach(() => {
  vi.clearAllMocks();
});
