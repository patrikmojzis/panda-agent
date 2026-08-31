import {describe, expect, it, vi} from "vitest";

import {createWhatsAppActorAuthorizer, parseWhatsAppAuthorizationSnapshot} from "../src/integrations/channels/whatsapp/authorization.js";

function authorizedRow(overrides: Record<string, unknown> = {}) {
  return {
    account_id: "account-1",
    account_version: "2026-08-25T10:00:00.000001",
    binding_id: "binding-1",
    binding_version: "2026-08-25T10:00:00.000002",
    identity_id: "identity-1",
    identity_handle: "alice",
    identity_version: "2026-08-25T10:00:00.000003",
    agent_key: "panda",
    pairing_version: "2026-08-25T10:00:00.000004",
    agent_version: "2026-08-25T10:00:00.000005",
    ...overrides,
  };
}

describe("WhatsApp actor authorization", () => {
  it("returns an immutable grant from one joined authorization query", async () => {
    const query = vi.fn(async () => ({rows: [authorizedRow()]}));
    const authorizer = createWhatsAppActorAuthorizer({pool: {query}});

    const grant = await authorizer.authorizeActor({
      connectorKey: "connector-1",
      externalActorId: "421900000000@s.whatsapp.net",
    });

    expect(grant).toMatchObject({
      authorized: true,
      identityId: "identity-1",
      identityHandle: "alice",
      agentKey: "panda",
      actorBindingId: "binding-1",
      authorizationVersion: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).toContain("account.status = 'enabled'");
    expect(query.mock.calls[0]?.[0]).toContain("identity.status = 'active'");
    expect(query.mock.calls[0]?.[0]).toContain("agent.status = 'active'");
    expect(query.mock.calls[0]?.[1]).toEqual([
      "whatsapp",
      "421900000000@s.whatsapp.net",
      "connector-1",
    ]);
  });

  it("fails closed when any joined authority row is absent", async () => {
    const authorizer = createWhatsAppActorAuthorizer({
      pool: {query: vi.fn(async () => ({rows: []}))},
    });

    await expect(authorizer.authorizeActor({
      connectorKey: "connector-1",
      externalActorId: "unpaired@s.whatsapp.net",
    })).resolves.toEqual({authorized: false, reason: "actor_not_authorized"});
  });

  it("changes the grant version when a pairing is revoked and recreated", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({rows: [authorizedRow()]})
      .mockResolvedValueOnce({rows: [authorizedRow({pairing_version: "2026-08-25T10:01:00.000001"})]});
    const authorizer = createWhatsAppActorAuthorizer({pool: {query}});

    const first = await authorizer.authorizeActor({connectorKey: "connector-1", externalActorId: "actor-1"});
    const second = await authorizer.authorizeActor({connectorKey: "connector-1", externalActorId: "actor-1"});

    expect(first.authorized && first.authorizationVersion)
      .not.toBe(second.authorized && second.authorizationVersion);
  });

  it("reauthorizes a call by non-PII binding snapshot and durable session", async () => {
    const bindingId = "11111111-1111-4111-8111-111111111111";
    const row = authorizedRow({binding_id: bindingId});
    const query = vi.fn(async () => ({rows: [row]}));
    const authorizer = createWhatsAppActorAuthorizer({pool: {query}});
    const authorizationVersion = parseWhatsAppAuthorizationSnapshot({
      identityId: "identity-1", agentKey: "panda", actorBindingId: bindingId,
      authorizationVersion: "a".repeat(64),
    })?.authorizationVersion;
    const current = await authorizer.authorizeActor({connectorKey: "connector-1", externalActorId: "actor-1"});
    if (!current.authorized) throw new Error("expected authorized actor");

    await expect(authorizer.reauthorizeCall({
      connectorKey: "connector-1",
      sessionId: "session-1",
      authorization: {...current, actorBindingId: bindingId},
    })).resolves.toBe(true);
    expect(authorizationVersion).toBe("a".repeat(64));
    expect(query.mock.calls[1]?.[0]).toContain("binding.id = $2::uuid");
    expect(query.mock.calls[1]?.[0]).toContain("conversation.session_id = $4");
    expect(query.mock.calls[1]?.[1]).toEqual(["whatsapp", bindingId, "connector-1", "session-1", "identity-1", "panda"]);
  });

  it("rejects malformed persisted call authority before querying", () => {
    expect(parseWhatsAppAuthorizationSnapshot({identityId: "identity-1", agentKey: "panda", actorBindingId: "not-a-uuid", authorizationVersion: "a".repeat(64)})).toBeNull();
  });
});
