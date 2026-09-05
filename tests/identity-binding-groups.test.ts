import {describe, expect, it, vi} from "vitest";

import {readIdentityBindingGroups} from "../src/domain/identity/postgres.js";

function identityRow(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    handle: id,
    display_name: id,
    status: "active",
    metadata: null,
    created_at: new Date(1000),
    updated_at: new Date(2000),
    ...overrides,
  };
}

function bindingRow(identityId: string, actor: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `binding-${actor}`,
    identity_id: identityId,
    source: "discord",
    connector_key: "main",
    external_actor_id: actor,
    metadata: null,
    created_at: new Date(1000),
    updated_at: new Date(2000),
    ...overrides,
  };
}

function queryRows(identities: readonly Record<string, unknown>[], bindings: readonly Record<string, unknown>[]) {
  return vi.fn().mockResolvedValueOnce({rows: identities}).mockResolvedValueOnce({rows: bindings});
}

describe("readIdentityBindingGroups", () => {
  it("returns an empty directory without reading the database", async () => {
    const query = vi.fn();
    await expect(readIdentityBindingGroups({query}, [], {invalidGroup: "throw"})).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it.each([1, 64])("reads %i identities and their bindings with two queries", async (count) => {
    const ids = Object.freeze(Array.from({length: count}, (_, index) => `identity-${index}`));
    const query = queryRows([...ids].reverse().map((id) => identityRow(id)), ids.map((id) => bindingRow(id, id)));

    const groups = await readIdentityBindingGroups({query}, ids, {invalidGroup: "throw"});

    expect(groups.map((group) => group.identity.id)).toEqual(ids);
    expect(groups.map((group) => group.bindings.map((binding) => binding.externalActorId))).toEqual(ids.map((id) => [id]));
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls.map((call) => call[1])).toEqual([[ids], [ids]]);
  });

  it("keeps requested identity order, repeated requests and each binding's query order", async () => {
    const query = queryRows(
      [identityRow("alice"), identityRow("bob"), identityRow("empty")],
      [bindingRow("alice", "a-first"), bindingRow("bob", "b-first"), bindingRow("alice", "a-second")],
    );

    const groups = await readIdentityBindingGroups({query}, ["bob", "alice", "bob", "empty"], {invalidGroup: "throw"});

    expect(groups.map(({identity, bindings}) => [identity.id, bindings.map((binding) => binding.externalActorId)])).toEqual([
      ["bob", ["b-first"]],
      ["alice", ["a-first", "a-second"]],
      ["bob", ["b-first"]],
      ["empty", []],
    ]);
  });

  it("retains existing persisted-key normalization and opaque actor values", async () => {
    const query = queryRows(
      [identityRow("alice", {handle: " ALICE "})],
      [bindingRow("alice", " actor ", {source: " \tdiscord\n", connector_key: " main "})],
    );

    await expect(readIdentityBindingGroups({query}, ["alice"], {invalidGroup: "throw"})).resolves.toMatchObject([{
      identity: {id: "alice", handle: "alice"},
      bindings: [{source: "discord", connectorKey: "main", externalActorId: " actor "}],
    }]);
  });

  it.each([
    {
      label: "an identity with an invalid status",
      identity: identityRow("alice", {status: "sideways"}),
      bindings: [bindingRow("alice", "good")],
      error: "Unsupported identity status sideways.",
    },
    {
      label: "an unrelated malformed binding in the identity group",
      identity: identityRow("alice"),
      bindings: [bindingRow("alice", "good"), bindingRow("alice", "bad", {source: "telegram", connector_key: " "})],
      error: "Identity binding row is missing connector key.",
    },
    {
      label: "invalid binding metadata",
      identity: identityRow("alice"),
      bindings: [bindingRow("alice", "bad", {metadata: Number.NaN})],
      error: "Identity binding metadata must be JSON-serializable.",
    },
  ])("omits the entire group or throws for $label", async ({identity, bindings, error}) => {
    const identities = [identity, identityRow("bob")];
    const rows = [...bindings, bindingRow("bob", "b")];

    const groups = await readIdentityBindingGroups({query: queryRows(identities, rows)}, ["alice", "bob"], {invalidGroup: "omit"});
    expect(groups.map(({identity, bindings}) => [identity.id, bindings.map((binding) => binding.externalActorId)])).toEqual([["bob", ["b"]]]);
    await expect(readIdentityBindingGroups({query: queryRows(identities, rows)}, ["alice", "bob"], {invalidGroup: "throw"})).rejects.toThrow(error);
  });

  it("omits missing identities while retaining soft-deleted ones, or reports the original missing error", async () => {
    const identities = [identityRow("deleted", {status: "deleted"})];
    const bindings = [bindingRow("deleted", "actor")];

    await expect(readIdentityBindingGroups({query: queryRows(identities, bindings)}, ["missing", "deleted"], {invalidGroup: "omit"})).resolves.toMatchObject([{
      identity: {id: "deleted", status: "deleted"},
      bindings: [{externalActorId: "actor"}],
    }]);
    await expect(readIdentityBindingGroups({query: queryRows(identities, bindings)}, ["missing", "deleted"], {invalidGroup: "throw"})).rejects.toThrow("Unknown identity missing");
  });

  it("reports the first invalid group in requested order", async () => {
    const query = queryRows(
      [identityRow("alice", {status: "sideways"}), identityRow("bob")],
      [bindingRow("bob", "bad", {connector_key: ""})],
    );
    await expect(readIdentityBindingGroups({query}, ["bob", "alice"], {invalidGroup: "throw"})).rejects.toThrow("Identity binding row is missing connector key.");
  });

  it.each([
    {queryNumber: 1, invalidGroup: "omit" as const},
    {queryNumber: 2, invalidGroup: "omit" as const},
    {queryNumber: 1, invalidGroup: "throw" as const},
    {queryNumber: 2, invalidGroup: "throw" as const},
  ])("propagates query $queryNumber failure under $invalidGroup policy", async ({queryNumber, invalidGroup}) => {
    const failure = new Error("database read failed");
    const query = vi.fn();
    if (queryNumber === 2) query.mockResolvedValueOnce({rows: [identityRow("alice")]});
    query.mockRejectedValueOnce(failure);

    await expect(readIdentityBindingGroups({query}, ["alice"], {invalidGroup})).rejects.toBe(failure);
    expect(query).toHaveBeenCalledTimes(queryNumber);
  });
});
