import React from "react";
import { Box, Text, useInput } from "ink";

export interface HelpModalProps {
  onClose: () => void;
}

const HelpModal: React.FC<HelpModalProps> = ({ onClose }) => {
  useInput(() => {
    onClose();
  });
  return (
    <Box justifyContent="center" alignItems="center" flexDirection="column" marginTop={2} marginBottom={2}>
      <Box borderStyle="double" borderColor="cyan" paddingX={2} paddingY={1} flexDirection="column" width={60}>
        <Box justifyContent="center" marginBottom={1}>
          <Text bold color="cyan">
            🌳 sync-worktrees - Keyboard Shortcuts
          </Text>
        </Box>

        <Box flexDirection="column" gap={0}>
          <Box>
            <Box width={15}>
              <Text bold color="yellow">
                ?
              </Text>
              <Text> or </Text>
              <Text bold color="yellow">
                h
              </Text>
            </Box>
            <Text>Toggle this help screen</Text>
          </Box>

          <Box>
            <Box width={15}>
              <Text bold color="yellow">
                s
              </Text>
            </Box>
            <Text>Manually trigger sync for all repositories</Text>
          </Box>

          <Box>
            <Box width={15}>
              <Text bold color="yellow">
                c
              </Text>
            </Box>
            <Text>Create a new branch</Text>
          </Box>

          <Box>
            <Box width={15}>
              <Text bold color="yellow">
                o
              </Text>
            </Box>
            <Text>Open editor in worktree</Text>
          </Box>

          <Box>
            <Box width={15}>
              <Text bold color="yellow">
                r
              </Text>
            </Box>
            <Text>Reload configuration and re-sync all repos</Text>
          </Box>

          <Box>
            <Box width={15}>
              <Text bold color="yellow">
                q
              </Text>
              <Text> or </Text>
              <Text bold color="yellow">
                Esc
              </Text>
            </Box>
            <Text>Gracefully quit</Text>
          </Box>
        </Box>

        <Box justifyContent="center" marginTop={1}>
          <Text dimColor>Press any key to close</Text>
        </Box>
      </Box>
    </Box>
  );
};

export default HelpModal;
