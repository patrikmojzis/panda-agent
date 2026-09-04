import type {CredentialResolver} from "../../domain/credentials/resolver.js";
import type {ExecutionCredentialPolicy} from "../../domain/execution-environments/types.js";
import {LlmContext} from "../../kernel/agent/llm-context.js";
import {renderCredentialsContext} from "../../prompts/contexts/credentials.js";

export interface CredentialsContextOptions {
  credentials: Pick<CredentialResolver, "listCredentialNames">;
  agentKey: string;
  credentialPolicy?: ExecutionCredentialPolicy;
}

export class CredentialsContext extends LlmContext {
  override name = "Available Credentials";

  constructor(private readonly options: CredentialsContextOptions) {
    super();
  }

  async getContent(): Promise<string> {
    const policy = this.options.credentialPolicy;
    if (policy?.mode === "none" || (policy?.mode === "allowlist" && policy.envKeys.length === 0)) {
      return renderCredentialsContext([]);
    }

    const names = await this.options.credentials.listCredentialNames({agentKey: this.options.agentKey});
    const allowedNames = policy?.mode === "allowlist"
      ? names.filter((name) => policy.envKeys.includes(name))
      : names;
    return renderCredentialsContext(allowedNames);
  }
}
