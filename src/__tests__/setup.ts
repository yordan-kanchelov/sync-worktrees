// Vitest setup file for global test configuration
import { afterEach, vi } from "vitest";

// Ensure NODE_ENV is set to test
process.env.NODE_ENV = "test";

// Mock console methods to reduce noise in test output
global.console = {
  ...console,
  log: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
};

// Reset mocks after each test
afterEach(() => {
  vi.clearAllMocks();
});
