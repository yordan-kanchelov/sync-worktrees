import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { isMouseSequence } from "../utils/mouse";
import { MIN_LIST_ROWS, isListDown, isListUp, useModalLayout } from "./layout";

export interface HelpModalProps {
  onClose: () => void;
  /** Rows the help screen may use; defaults to the terminal height. */
  availableRows?: number;
}

interface HelpRow {
  keys: string[];
  description: string;
}

interface HelpSection {
  title: string;
  rows: HelpRow[];
}

const SECTIONS: HelpSection[] = [
  {
    title: "Navigation",
    rows: [
      { keys: ["j", "↓"], description: "Scroll down one line" },
      { keys: ["k", "↑"], description: "Scroll up one line" },
      { keys: ["PgUp", "PgDn"], description: "Scroll the log one page" },
      { keys: ["wheel"], description: "Scroll the log (hold Shift to select text)" },
      { keys: ["gg"], description: "Jump to top" },
      { keys: ["G"], description: "Jump to bottom (re-enables auto-scroll)" },
    ],
  },
  {
    title: "Actions",
    rows: [
      { keys: ["s"], description: "Manually trigger sync for all repositories" },
      { keys: ["c"], description: "Create a new branch" },
      { keys: ["o"], description: "Open worktree in terminal or editor" },
      { keys: ["w"], description: "View worktree status" },
      { keys: ["x"], description: "Force clean trash, recovery refs, and Git objects" },
      { keys: ["r"], description: "Reload configuration and re-sync all repos" },
      { keys: ["?", "h"], description: "Toggle this help screen" },
      // `q` alone. Esc is this interface's "back out of what is open" key --
      // it closes this screen, cancels a wizard and steps a wizard back -- so
      // binding it to an exit as well would make one Esc too many, or a key
      // repeat, tear down the daemon and the hooks it still has running.
      { keys: ["q"], description: "Gracefully quit; asks if busy" },
      { keys: ["l", "+", "-"], description: "Collapse / grow / shrink the log under the table" },
    ],
  },
  {
    title: "In wizards and the status view",
    rows: [
      { keys: ["Ctrl-P", "Ctrl-N"], description: "Move up / down a list (as well as ↑/↓)" },
      { keys: ["Ctrl-D"], description: "Delete the selected .diverged directory" },
    ],
  },
];

type HelpLine = { kind: "blank" } | { kind: "heading"; title: string } | { kind: "row"; row: HelpRow };

const helpLines = (withBlanks: boolean): HelpLine[] =>
  SECTIONS.flatMap((section, index) => [
    ...(withBlanks && index > 0 ? [{ kind: "blank" as const }] : []),
    { kind: "heading" as const, title: section.title },
    ...section.rows.map((row) => ({ kind: "row" as const, row })),
  ]);

const ROOMY_LINES = helpLines(true);
const COMPACT_LINES = helpLines(false);

// Rows spent outside the lines: the border (2), the title and its margin (2)
// and the footer and its margin (2); the roomy layout adds its outer margins
// (4) and `paddingY` (2).
const COMPACT_CHROME_ROWS = 6;
const ROOMY_CHROME_ROWS = 12;

const KEY_COLUMN_WIDTH = 17;

const HelpModal: React.FC<HelpModalProps> = ({ onClose, availableRows }) => {
  const layout = useModalLayout(72, availableRows);
  const [scrollOffset, setScrollOffset] = useState(0);

  // The whole sheet with room to breathe when the terminal has the rows;
  // otherwise without the spacing, and scrolled when even that does not fit.
  const roomy = layout.rows >= ROOMY_CHROME_ROWS + ROOMY_LINES.length;
  const lines = roomy ? ROOMY_LINES : COMPACT_LINES;
  const room = layout.rows - (roomy ? ROOMY_CHROME_ROWS : COMPACT_CHROME_ROWS);
  const scrollable = lines.length > room;
  // The `↑ more` / `↓ more` rows are reserved as soon as the sheet scrolls, so
  // the window does not change size under the reader.
  const visibleCount = scrollable ? Math.max(MIN_LIST_ROWS, room - 2) : lines.length;
  const maxOffset = Math.max(0, lines.length - visibleCount);
  const offset = Math.min(scrollOffset, maxOffset);

  useInput((input, key) => {
    // Mouse reports arrive as a single `input` string; ignore them here so a
    // scroll never registers as a keystroke.
    if (isMouseSequence(input)) return;

    if (input === "?" || input === "h" || key.escape) {
      onClose();
    } else if (scrollable && (isListUp(input, key) || input === "k")) {
      setScrollOffset((prev) => Math.max(0, Math.min(prev, maxOffset) - 1));
    } else if (scrollable && (isListDown(input, key) || input === "j")) {
      setScrollOffset((prev) => Math.min(maxOffset, prev + 1));
    }
  });

  const renderLine = (line: HelpLine, index: number) => {
    switch (line.kind) {
      case "blank":
        return <Text key={`blank-${index}`}> </Text>;
      case "heading":
        return (
          <Text key={`heading-${line.title}`} bold color="green" dimColor wrap="truncate-end">
            {line.title}
          </Text>
        );
      case "row":
        return (
          <Box key={`row-${line.row.keys.join("/")}`}>
            <Box width={KEY_COLUMN_WIDTH} flexShrink={0}>
              <Text wrap="truncate-end">
                {line.row.keys.map((keyName, keyIndex) => (
                  <React.Fragment key={keyName}>
                    {keyIndex > 0 && <Text> / </Text>}
                    <Text bold color="yellow">
                      {keyName}
                    </Text>
                  </React.Fragment>
                ))}
              </Text>
            </Box>
            <Text wrap="truncate-end">{line.row.description}</Text>
          </Box>
        );
    }
  };

  const visibleLines = lines.slice(offset, offset + visibleCount);
  const hiddenAbove = offset;
  const hiddenBelow = lines.length - offset - visibleLines.length;

  return (
    <Box
      justifyContent="center"
      alignItems="center"
      flexDirection="column"
      marginTop={roomy ? 2 : 0}
      marginBottom={roomy ? 2 : 0}
    >
      <Box
        borderStyle="double"
        borderColor="cyan"
        paddingX={2}
        paddingY={roomy ? 1 : 0}
        flexDirection="column"
        width={layout.width}
      >
        <Box justifyContent="center" marginBottom={1}>
          <Text bold color="cyan" wrap="truncate-end">
            🌳 sync-worktrees - Keyboard Shortcuts
          </Text>
        </Box>

        <Box flexDirection="column" gap={0}>
          {scrollable && <Text dimColor>{hiddenAbove > 0 ? `↑ ${hiddenAbove} more` : " "}</Text>}
          {visibleLines.map((line, index) => renderLine(line, offset + index))}
          {scrollable && <Text dimColor>{hiddenBelow > 0 ? `↓ ${hiddenBelow} more` : " "}</Text>}
        </Box>

        <Box justifyContent="center" marginTop={1}>
          <Text dimColor wrap="truncate-end">
            Press ? / h / ESC to close{scrollable ? " • ↑/↓ scroll" : ""}
          </Text>
        </Box>
      </Box>
    </Box>
  );
};

export default HelpModal;
