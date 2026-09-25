interface TtyLike {
  isTTY?: boolean;
}

/**
 * True when both ends are a terminal: the dashboard reads keys in raw mode
 * from stdin and draws on stdout, and the `init` wizard prompts on the pair.
 * Under systemd, docker, CI or `< /dev/null` one of them is not a TTY, and Ink
 * answers that with a stack trace ("Raw mode is not supported") rather than an
 * explanation.
 */
export function hasInteractiveTerminal(stdin: TtyLike = process.stdin, stdout: TtyLike = process.stdout): boolean {
  return stdin.isTTY === true && stdout.isTTY === true;
}

/**
 * Whether output may carry ANSI colour: `FORCE_COLOR` wins either way (as it
 * does for Node and chalk), then a non-empty `NO_COLOR` (https://no-color.org)
 * turns colour off, and otherwise only a terminal gets it.
 */
export function colorsEnabled(env: NodeJS.ProcessEnv = process.env, stream: TtyLike = process.stdout): boolean {
  const force = env.FORCE_COLOR;
  if (force !== undefined) return force !== "0" && force !== "false";
  if (env.NO_COLOR) return false;
  return stream.isTTY === true;
}
