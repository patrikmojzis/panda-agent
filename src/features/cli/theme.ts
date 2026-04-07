const RESET = "\u001b[0m";

function wrap(code: string, value: string): string {
  return `${code}${value}${RESET}`;
}

export const theme = {
  cyan: (value: string) => wrap("\u001b[38;5;44m", value),
  mint: (value: string) => wrap("\u001b[38;5;79m", value),
  coral: (value: string) => wrap("\u001b[38;5;209m", value),
  gold: (value: string) => wrap("\u001b[38;5;221m", value),
  slate: (value: string) => wrap("\u001b[38;5;244m", value),
  white: (value: string) => wrap("\u001b[38;5;255m", value),
  dim: (value: string) => wrap("\u001b[2m", value),
  bold: (value: string) => wrap("\u001b[1m", value),
};

export function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}
