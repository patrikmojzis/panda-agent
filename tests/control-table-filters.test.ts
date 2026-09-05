import {afterEach, describe, expect, it, vi} from "vitest";

import {
  booleanFilterValueSetter,
  tableFiltersToParams,
} from "../apps/control-ui/src/components/common/data-table/hooks/filter-params.js";
import {controlApi} from "../apps/control-ui/src/lib/api.js";

afterEach(() => vi.unstubAllGlobals());

describe("Control table query filters", () => {
  it.each([true, false])("preserves the enabled filter %s from both boolean and text values", (value) => {
    for (const input of [value, String(value)]) {
      expect(tableFiltersToParams({
        columnFilters: [{id: "enabled", value: input}],
        filterValueSetters: {enabled: booleanFilterValueSetter},
      })).toEqual({enabled: value});
    }
  });

  it("omits unsupported boolean values without dropping other filters", () => {
    expect(tableFiltersToParams({
      columnFilters: [{id: "enabled", value: "all"}, {id: "status", value: "active"}],
      filterValueSetters: {enabled: booleanFilterValueSetter},
    })).toEqual({status: "active"});
  });

  it("keeps supported scalar and list values and removes empty or invalid values", () => {
    expect(tableFiltersToParams({columnFilters: [
      {id: "search", value: "  panda  "},
      {id: "attempts", value: 0},
      {id: "empty", value: " "},
      {id: "invalid", value: {value: "nested"}},
      {id: "kinds", value: ["main", "", null, " ", false, 2, Infinity, {}]},
      {id: "missing", value: undefined},
    ]})).toEqual({search: "  panda  ", attempts: 0, kinds: ["main", false, 2]});
  });

  it("applies global filters after column filters and lets an empty value clear the same key", () => {
    const setter = vi.fn((value: unknown) => value);
    expect(tableFiltersToParams({
      columnFilters: [{id: "search", value: "old"}, {id: "status", value: "active"}],
      globalFilter: {search: "new", status: undefined},
      filterValueSetters: {search: setter},
    })).toEqual({search: "new"});
    expect(setter.mock.calls).toEqual([["old", "search"], ["new", "search"]]);
  });

  it("sends the normalized filters through the Control API query", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({data: []}));
    vi.stubGlobal("fetch", fetch);
    await controlApi.sessions("panda", tableFiltersToParams({
      columnFilters: [
        {id: "visibility", value: "everything"},
        {id: "enabled", value: "false"},
        {id: "kind", value: ["main", "subagent"]},
      ],
      globalFilter: {search: "two words"},
      filterValueSetters: {
        enabled: booleanFilterValueSetter,
        visibility: (value) => value === "everything" ? "all" : undefined,
      },
    }));
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      "/api/control/agents/panda/sessions?visibility=all&enabled=false&kind=main&kind=subagent&search=two+words",
      {credentials: "include"},
    );
  });
});
