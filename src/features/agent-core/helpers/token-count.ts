export type TokenCounter = (text: string) => number;

export const estimateTokensFromString: TokenCounter = (text) => {
  return Math.max(1, Math.ceil(text.length / 4));
};
