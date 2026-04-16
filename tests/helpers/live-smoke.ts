import {requireSmokeDatabaseUrl, resolveSmokeModelSelector,} from "../../src/app/smoke/config.js";
import {type PandaSmokeInput, type PandaSmokeResult, runPandaSmoke,} from "../../src/app/smoke/harness.js";

export async function runLiveSmokeTest(
  input: Omit<PandaSmokeInput, "dbUrl" | "model"> & {
    dbUrl?: string;
    model?: string;
  },
): Promise<PandaSmokeResult> {
  const dbUrl = input.dbUrl ?? requireSmokeDatabaseUrl();
  const model = resolveSmokeModelSelector(input.model);
  const result = await runPandaSmoke({
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
