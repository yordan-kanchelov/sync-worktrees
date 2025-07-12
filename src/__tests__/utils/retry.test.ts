import { retry } from "../../utils/retry";

import type { RetryOptions } from "../../utils/retry";

describe("retry", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("successful operations", () => {
    it("should return result on first successful attempt", async () => {
      const mockFn = jest.fn().mockResolvedValue("success");

      const result = await retry(mockFn);

      expect(result).toBe("success");
      expect(mockFn).toHaveBeenCalledTimes(1);
    });

    it("should return result after retries", async () => {
      const error1 = new Error("Connection failed");
      (error1 as any).code = "ECONNREFUSED";
      const error2 = new Error("Timeout");
      (error2 as any).code = "ETIMEDOUT";

      const mockFn = jest.fn().mockRejectedValueOnce(error1).mockRejectedValueOnce(error2).mockResolvedValue("success");

      const result = await retry(mockFn, { initialDelayMs: 10 });

      expect(result).toBe("success");
      expect(mockFn).toHaveBeenCalledTimes(3);
    });
  });

  describe("retry attempts", () => {
    it("should retry unlimited times by default", async () => {
      let attempts = 0;
      const mockFn = jest.fn().mockImplementation(() => {
        attempts++;
        if (attempts < 10) {
          const error = new Error("Network error");
          (error as any).code = "ECONNREFUSED";
          throw error;
        }
        return Promise.resolve("success");
      });

      const result = await retry(mockFn, { initialDelayMs: 1, maxDelayMs: 5 });

      expect(result).toBe("success");
      expect(mockFn).toHaveBeenCalledTimes(10);
    });

    it("should respect maxAttempts when set to a number", async () => {
      const error = new Error("Always fails");
      (error as any).code = "ECONNREFUSED";
      const mockFn = jest.fn().mockRejectedValue(error);

      await expect(retry(mockFn, { maxAttempts: 3, initialDelayMs: 1 })).rejects.toThrow("Always fails");

      expect(mockFn).toHaveBeenCalledTimes(3);
    });

    it("should retry unlimited times when maxAttempts is 'unlimited'", async () => {
      let attempts = 0;
      const mockFn = jest.fn().mockImplementation(() => {
        attempts++;
        if (attempts < 5) {
          const error = new Error("Network error");
          (error as any).code = "ETIMEDOUT";
          throw error;
        }
        return Promise.resolve("success");
      });

      const result = await retry(mockFn, { maxAttempts: "unlimited", initialDelayMs: 1 });

      expect(result).toBe("success");
      expect(mockFn).toHaveBeenCalledTimes(5);
    });
  });

  describe("retry delays", () => {
    it("should use exponential backoff", async () => {
      const delays: number[] = [];
      const mockSetTimeout = jest.spyOn(global, "setTimeout");
      mockSetTimeout.mockImplementation((fn: any, delay?: number) => {
        delays.push(delay || 0);
        fn();
        return {} as NodeJS.Timeout;
      });

      const error1 = new Error("fail 1");
      (error1 as any).code = "ECONNREFUSED";
      const error2 = new Error("fail 2");
      (error2 as any).code = "ETIMEDOUT";
      const error3 = new Error("fail 3");
      (error3 as any).code = "ENOTFOUND";

      const mockFn = jest
        .fn()
        .mockRejectedValueOnce(error1)
        .mockRejectedValueOnce(error2)
        .mockRejectedValueOnce(error3)
        .mockResolvedValue("success");

      await retry(mockFn, {
        initialDelayMs: 100,
        backoffMultiplier: 2,
        maxDelayMs: 1000,
      });

      expect(delays).toEqual([100, 200, 400]);
      mockSetTimeout.mockRestore();
    });

    it("should respect maxDelayMs", async () => {
      const delays: number[] = [];
      const mockSetTimeout = jest.spyOn(global, "setTimeout");
      mockSetTimeout.mockImplementation((fn: any, delay?: number) => {
        delays.push(delay || 0);
        fn();
        return {} as NodeJS.Timeout;
      });

      const createError = (msg: string) => {
        const error = new Error(msg);
        (error as any).code = "EBUSY";
        return error;
      };

      const mockFn = jest
        .fn()
        .mockRejectedValueOnce(createError("fail 1"))
        .mockRejectedValueOnce(createError("fail 2"))
        .mockRejectedValueOnce(createError("fail 3"))
        .mockRejectedValueOnce(createError("fail 4"))
        .mockResolvedValue("success");

      await retry(mockFn, {
        initialDelayMs: 100,
        backoffMultiplier: 3,
        maxDelayMs: 500,
      });

      expect(delays).toEqual([100, 300, 500, 500]); // Capped at maxDelayMs
      mockSetTimeout.mockRestore();
    });
  });

  describe("shouldRetry", () => {
    it("should retry on default retryable errors", async () => {
      const networkError = new Error("Network failed");
      (networkError as any).code = "ECONNREFUSED";

      const mockFn = jest.fn().mockRejectedValueOnce(networkError).mockResolvedValue("success");

      const result = await retry(mockFn, { initialDelayMs: 1 });

      expect(result).toBe("success");
      expect(mockFn).toHaveBeenCalledTimes(2);
    });

    it("should not retry on non-retryable errors by default", async () => {
      const error = new Error("Validation error");
      const mockFn = jest.fn().mockRejectedValue(error);

      await expect(retry(mockFn)).rejects.toThrow("Validation error");
      expect(mockFn).toHaveBeenCalledTimes(1);
    });

    it("should use custom shouldRetry function", async () => {
      const customError = new Error("Custom error");
      (customError as any).retryable = true;

      const mockFn = jest.fn().mockRejectedValueOnce(customError).mockResolvedValue("success");

      const options: RetryOptions = {
        initialDelayMs: 1,
        shouldRetry: (error) => (error as { retryable?: boolean }).retryable === true,
      };

      const result = await retry(mockFn, options);

      expect(result).toBe("success");
      expect(mockFn).toHaveBeenCalledTimes(2);
    });

    it("should retry on Git remote repository errors", async () => {
      const gitError = new Error("Could not read from remote repository");
      const mockFn = jest.fn().mockRejectedValueOnce(gitError).mockResolvedValue("success");

      const result = await retry(mockFn, { initialDelayMs: 1 });

      expect(result).toBe("success");
      expect(mockFn).toHaveBeenCalledTimes(2);
    });

    it("should retry on file system errors", async () => {
      const fsError = new Error("File busy");
      (fsError as any).code = "EBUSY";

      const mockFn = jest.fn().mockRejectedValueOnce(fsError).mockResolvedValue("success");

      const result = await retry(mockFn, { initialDelayMs: 1 });

      expect(result).toBe("success");
      expect(mockFn).toHaveBeenCalledTimes(2);
    });
  });

  describe("onRetry callback", () => {
    it("should call onRetry with error and attempt number", async () => {
      const onRetry = jest.fn();
      const error1 = new Error("Attempt 1");
      (error1 as any).code = "ECONNREFUSED";
      const error2 = new Error("Attempt 2");
      (error2 as any).code = "ETIMEDOUT";

      const mockFn = jest.fn().mockRejectedValueOnce(error1).mockRejectedValueOnce(error2).mockResolvedValue("success");

      await retry(mockFn, {
        initialDelayMs: 1,
        onRetry,
      });

      expect(onRetry).toHaveBeenCalledTimes(2);
      expect(onRetry).toHaveBeenNthCalledWith(1, error1, 1, expect.objectContaining({ isLfsError: false }));
      expect(onRetry).toHaveBeenNthCalledWith(2, error2, 2, expect.objectContaining({ isLfsError: false }));
    });
  });

  describe("default retry configuration", () => {
    it("should have correct default values", async () => {
      const mockFn = jest.fn().mockResolvedValue("success");

      await retry(mockFn);

      // Verify function was called (default behavior doesn't affect successful calls)
      expect(mockFn).toHaveBeenCalledTimes(1);
    });

    it("should default to 10 minute max delay", async () => {
      const delays: number[] = [];
      const mockSetTimeout = jest.spyOn(global, "setTimeout");
      mockSetTimeout.mockImplementation((fn: any, delay?: number) => {
        delays.push(delay || 0);
        fn();
        return {} as NodeJS.Timeout;
      });

      // Create enough failures to exceed 10 minutes with exponential backoff
      const mockFn = jest.fn();
      for (let i = 0; i < 15; i++) {
        const error = new Error(`Fail ${i}`);
        (error as any).code = "ECONNREFUSED";
        mockFn.mockRejectedValueOnce(error);
      }
      mockFn.mockResolvedValue("success");

      await retry(mockFn);

      // With backoff multiplier of 2 and initial delay of 1000ms:
      // 1s, 2s, 4s, 8s, 16s, 32s, 64s, 128s, 256s, 512s, then capped at 600s (10 min)
      const expectedDelays = [
        1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000, 512000, 600000, 600000, 600000, 600000, 600000,
      ];

      expect(delays).toEqual(expectedDelays);
      mockSetTimeout.mockRestore();
    });
  });

  describe("LFS error detection", () => {
    it("should detect LFS errors and mark context", async () => {
      const lfsError = new Error("smudge filter lfs failed");
      let capturedContext: any;

      const mockFn = jest.fn().mockRejectedValueOnce(lfsError).mockResolvedValue("success");

      await retry(mockFn, {
        initialDelayMs: 1,
        onRetry: (_error, _attempt, context) => {
          capturedContext = context;
        },
      });

      expect(capturedContext?.isLfsError).toBe(true);
    });

    it("should detect various LFS error messages", async () => {
      const lfsErrors = [
        "smudge filter lfs failed",
        "Object does not exist on the server",
        "external filter 'git-lfs filter-process' failed",
      ];

      for (const errorMessage of lfsErrors) {
        let capturedContext: any;
        const error = new Error(errorMessage);

        const mockFn = jest.fn().mockRejectedValueOnce(error).mockResolvedValue("success");

        await retry(mockFn, {
          initialDelayMs: 1,
          onRetry: (_error, _attempt, context) => {
            capturedContext = context;
          },
        });

        expect(capturedContext?.isLfsError).toBe(true);
      }
    });

    it("should call lfsRetryHandler when LFS error is detected", async () => {
      const lfsError = new Error("smudge filter lfs failed");
      const lfsRetryHandler = jest.fn();

      const mockFn = jest.fn().mockRejectedValueOnce(lfsError).mockResolvedValue("success");

      await retry(mockFn, {
        initialDelayMs: 1,
        lfsRetryHandler,
      });

      expect(lfsRetryHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          isLfsError: true,
        }),
      );
    });
  });
});
