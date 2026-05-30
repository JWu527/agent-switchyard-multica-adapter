export class UserError extends Error {
  constructor(message: string, public readonly exitCode = 1) {
    super(message);
    this.name = "UserError";
  }
}

export function formatUnknownError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
