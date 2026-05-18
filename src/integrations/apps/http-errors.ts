export class AgentAppRequestError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "AgentAppRequestError";
  }
}
