// Jest setup file for global test configuration
import { jest } from "@jest/globals";

// Ensure NODE_ENV is set to test
process.env.NODE_ENV = "test";

// Mock console methods to reduce noise in test output
global.console = {
  ...console,
  log: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
};

// Reset mocks after each test
afterEach(() => {
  jest.clearAllMocks();
});
