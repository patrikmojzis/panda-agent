export function fieldErrors(errors: unknown[]) {
  return errors.map((error) => {
    if (error instanceof Error) return { message: error.message }
    if (
      error &&
      typeof error === "object" &&
      "message" in error &&
      typeof error.message === "string"
    ) {
      return { message: error.message }
    }
    return { message: String(error) }
  })
}
