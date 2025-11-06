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

    it("should render help modal with tree emoji", () => {
      const { lastFrame } = render(<HelpModal {...defaultProps} />);

      expect(lastFrame()).toContain("🌳");
    });

    it("should render close instruction", () => {
      const { lastFrame } = render(<HelpModal {...defaultProps} />);

      expect(lastFrame()).toContain("Press any key to close");
    });
  });

  describe("keyboard shortcuts", () => {
    it("should show help toggle shortcut", () => {
      const { lastFrame } = render(<HelpModal {...defaultProps} />);

      expect(lastFrame()).toContain("?");
      expect(lastFrame()).toContain("h");
      expect(lastFrame()).toContain("Toggle this help screen");
    });

    it("should show manual sync shortcut", () => {
      const { lastFrame } = render(<HelpModal {...defaultProps} />);

      expect(lastFrame()).toContain("s");
      expect(lastFrame()).toContain("Manually trigger sync");
    });

    it("should show reload shortcut", () => {
      const { lastFrame } = render(<HelpModal {...defaultProps} />);

      expect(lastFrame()).toContain("r");
      expect(lastFrame()).toContain("Reload configuration");
    });

    it("should show quit shortcut", () => {
      const { lastFrame } = render(<HelpModal {...defaultProps} />);

      expect(lastFrame()).toContain("q");
      expect(lastFrame()).toContain("Esc");
      expect(lastFrame()).toContain("Gracefully quit");
    });

    it("should display all four main shortcuts", () => {
      const { lastFrame } = render(<HelpModal {...defaultProps} />);

      const frame = lastFrame();
      expect(frame).toContain("?");
      expect(frame).toContain("s");
      expect(frame).toContain("r");
      expect(frame).toContain("q");
    });
  });

  describe("keyboard input", () => {
    it("should call onClose when any key is pressed", () => {
      const onClose = vi.fn();
      const { stdin } = render(<HelpModal onClose={onClose} />);

      stdin.write("x");

      expect(onClose).toHaveBeenCalled();
    });

    it("should call onClose when space is pressed", () => {
      const onClose = vi.fn();
      const { stdin } = render(<HelpModal onClose={onClose} />);

      stdin.write(" ");

      expect(onClose).toHaveBeenCalled();
    });

    it("should call onClose when enter is pressed", () => {
      const onClose = vi.fn();
      const { stdin } = render(<HelpModal onClose={onClose} />);

      stdin.write("\r");

      expect(onClose).toHaveBeenCalled();
    });

    it("should call onClose when escape is pressed", () => {
      const onClose = vi.fn();
      const { stdin } = render(<HelpModal onClose={onClose} />);

      stdin.write("\x1b");

      expect(onClose).toHaveBeenCalled();
    });

    it("should call onClose only once per keypress", () => {
      const onClose = vi.fn();
      const { stdin } = render(<HelpModal onClose={onClose} />);

      stdin.write("a");

      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe("visual styling", () => {
    it("should have border decoration", () => {
      const { lastFrame } = render(<HelpModal {...defaultProps} />);

      const frame = lastFrame();
      // Ink may use different border styles, check for any border characters
      expect(frame).toMatch(/[┌┐└┘╔╗╚╝═║─│]/);
    });

    it("should display shortcuts in organized format", () => {
      const { lastFrame } = render(<HelpModal {...defaultProps} />);

      const frame = lastFrame();
      expect(frame!.split("\n").length).toBeGreaterThan(5);
    });
  });

  describe("accessibility", () => {
    it("should provide clear keyboard shortcut labels", () => {
      const { lastFrame } = render(<HelpModal {...defaultProps} />);

      const frame = lastFrame();
      expect(frame).toContain("?");
      expect(frame).toContain("s");
      expect(frame).toContain("r");
      expect(frame).toContain("q");
    });

    it("should provide clear action descriptions", () => {
      const { lastFrame } = render(<HelpModal {...defaultProps} />);

      const frame = lastFrame();
      expect(frame).toContain("Toggle");
      expect(frame).toContain("sync");
      expect(frame).toContain("Reload");
      expect(frame).toContain("quit");
    });
  });
});
