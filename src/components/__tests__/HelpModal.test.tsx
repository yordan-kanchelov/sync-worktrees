import React from "react";
import { render } from "ink-testing-library";
import { describe, it, expect, vi, beforeEach } from "vitest";

import HelpModal, { HelpModalProps } from "../HelpModal";

describe("HelpModal", () => {
  let defaultProps: HelpModalProps;

  beforeEach(() => {
    defaultProps = {
      onClose: vi.fn(),
    };
  });

  describe("rendering", () => {
    it("should render help modal title", () => {
      const { lastFrame } = render(<HelpModal {...defaultProps} />);

      expect(lastFrame()).toContain("sync-worktrees");
      expect(lastFrame()).toContain("Keyboard Shortcuts");
    });

    it("should render close instruction", () => {
      const { lastFrame } = render(<HelpModal {...defaultProps} />);

      expect(lastFrame()).toContain("Press ? / h / ESC to close");
    });
  });

  describe("keyboard input", () => {
    it("should call onClose when ? is pressed", () => {
      const onClose = vi.fn();
      const { stdin } = render(<HelpModal onClose={onClose} />);

      stdin.write("?");

      expect(onClose).toHaveBeenCalled();
    });

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
      await new Promise((resolve) => setImmediate(resolve));

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
