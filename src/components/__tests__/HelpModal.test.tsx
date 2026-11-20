import React from "react";
import { render, cleanup } from "ink-testing-library";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { HelpModalProps } from "../HelpModal";
import HelpModal from "../HelpModal";

describe("HelpModal", () => {
  let defaultProps: HelpModalProps;

  beforeEach(() => {
    defaultProps = {
      onClose: vi.fn(),
    };
  });

  afterEach(() => {
    cleanup();
  });

  describe("rendering", () => {
    it("should render help modal title", () => {
      const { lastFrame } = render(<HelpModal {...defaultProps} />);

      expect(lastFrame()).toContain("sync-worktrees");
      expect(lastFrame()).toContain("Keyboard Shortcuts");
    });

    it("names q as the only way to quit, and does not offer Esc", () => {
      const { lastFrame } = render(<HelpModal {...defaultProps} availableRows={40} />);

      const quitRow = (lastFrame() ?? "").split("\n").find((line) => line.includes("Gracefully quit"));

      expect(quitRow).toBeDefined();
      expect(quitRow).toMatch(/\bq\b/);
      expect(quitRow).not.toMatch(/esc/i);
    });

    it("lists the page keys the log panel answers to", () => {
      const { lastFrame } = render(<HelpModal {...defaultProps} />);

      const pageRow = (lastFrame() ?? "").split("\n").find((line) => line.includes("PgUp"));

      expect(pageRow).toContain("PgDn");
      expect(pageRow).toContain("one page");
    });

    it("should render close instruction", () => {
      const { lastFrame } = render(<HelpModal {...defaultProps} />);

      expect(lastFrame()).toContain("Press ? / h / ESC to close");
    });
  });

  describe("keyboard input", () => {
    it("should call onClose when h is pressed", () => {
      const onClose = vi.fn();
      const { stdin } = render(<HelpModal onClose={onClose} />);

      stdin.write("h");

      expect(onClose).toHaveBeenCalled();
    });

    it("should not call onClose when arbitrary keys are pressed", () => {
      const onClose = vi.fn();
      const { stdin } = render(<HelpModal onClose={onClose} />);

      stdin.write("x");

      expect(onClose).not.toHaveBeenCalled();
    });

    it("should call onClose when escape is pressed", async () => {
      const onClose = vi.fn();
      const { stdin } = render(<HelpModal onClose={onClose} />);

      stdin.write("\x1b");
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(onClose).toHaveBeenCalled();
    });

    it("should call onClose only once per keypress", () => {
      const onClose = vi.fn();
      const { stdin } = render(<HelpModal onClose={onClose} />);

      stdin.write("?");

      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });
});
