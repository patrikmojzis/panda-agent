import {requireSmokeDatabaseUrl, resolveSmokeModelSelector,} from "../../src/app/smoke/config.js";
import {runSmoke, type SmokeInput, type SmokeResult,} from "../../src/app/smoke/harness.js";

export async function runLiveSmokeTest(
  input: Omit<SmokeInput, "dbUrl" | "model"> & {
    dbUrl?: string;
    model?: string;
  },
): Promise<SmokeResult> {
  const dbUrl = input.dbUrl ?? requireSmokeDatabaseUrl();
  const model = resolveSmokeModelSelector(input.model);
  const result = await runSmoke({
    ...input,
    dbUrl,
    ...(model ? {model} : {}),
    forbidToolError: input.forbidToolError ?? true,
  });

  if (!result.success) {
    throw new Error(`Live smoke failed: ${result.error?.message ?? "unknown"}\nArtifacts: ${result.artifactDir}`);
  }

  return result;
}
