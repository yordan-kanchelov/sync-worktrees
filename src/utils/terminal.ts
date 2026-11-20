interface TtyLike {
  isTTY?: boolean;
}

export function hasInteractiveTerminal(stdin: TtyLike = process.stdin, stdout: TtyLike = process.stdout): boolean {
  return stdin.isTTY === true && stdout.isTTY === true;
}

export function colorsEnabled(env: NodeJS.ProcessEnv = process.env, stream: TtyLike = process.stdout): boolean {
  const force = env.FORCE_COLOR;
  if (force !== undefined) return force !== "0" && force !== "false";
  if (env.NO_COLOR) return false;
  return stream.isTTY === true;
}
