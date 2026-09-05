import {afterEach, describe, expect, it, vi} from "vitest";

import {apiWrite} from "../apps/control-ui/src/lib/api.js";
import {handleControlFormError} from "../apps/control-ui/src/lib/form-errors.js";

const {toastError} = vi.hoisted(() => ({toastError: vi.fn()}));
// The UI uses Sonner's ESM export; resolving the package directory selects its CJS entry.
vi.mock("../apps/control-ui/node_modules/sonner/dist/index.mjs", () => ({toast: {error: toastError}}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function submit(response: Response, options?: Parameters<typeof handleControlFormError>[2]) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
  const form = {setErrorMap: vi.fn()};
  try {
    await apiWrite("/identities", {body: {handle: "panda"}});
  } catch (error) {
    await handleControlFormError(error, form, options);
  }
  return form;
}

describe("Control form submission errors", () => {
  it("maps Control messages to every matching field before status fallback", async () => {
    const form = await submit(Response.json({error: "Email SECURE mode is required"}, {status: 403}), {
      messageFieldMap: {"secure mode": ["imapSecure", "smtpSecure"], required: "imapSecure"},
    });
    expect(form.setErrorMap).toHaveBeenCalledExactlyOnceWith({onSubmit: {fields: {
      imapSecure: {message: "Email SECURE mode is required"},
      smtpSecure: {message: "Email SECURE mode is required"},
    }}});
    expect(toastError).not.toHaveBeenCalled();
  });

  it.each([
    [401, "Your Control session expired. Sign in again."],
    [403, "You do not have permission to write this resource."],
  ])("shows the status-specific feedback for %i", async (status, message) => {
    const form = await submit(Response.json({error: "server message"}, {status}));
    expect(form.setErrorMap).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledExactlyOnceWith(message);
  });

  it.each([
    [JSON.stringify({error: "handle already exists"}), 400, "handle already exists"],
    [JSON.stringify({error: "stale_version", currentVersion: 2}), 409, "stale_version"],
    ["null", 401, "Your Control session expired. Sign in again."],
    ["<html>Unavailable</html>", 403, "You do not have permission to write this resource."],
    ["null", 500, "Control request failed with 500"],
    ["<html>Unavailable</html>", 502, "Control request failed with 502"],
    ["{}", 400, "Control request failed with 400"],
    [JSON.stringify({error: ""}), 400, "Control write failed"],
  ])("reports error body %s with status %i", async (body, status, message) => {
    const form = await submit(new Response(body, {status}));
    expect(form.setErrorMap).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledExactlyOnceWith(message);
  });

  it.each([
    [new Error("local validation failed"), "local validation failed"],
    [null, "Control write failed"],
    [{data: [{loc: ["body", "handle"], msg: "foreign validation"}]}, "Control write failed"],
  ])("reports ordinary thrown errors without treating them as API field errors", async (error, message) => {
    const form = {setErrorMap: vi.fn()};
    await handleControlFormError(error, form);
    expect(form.setErrorMap).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledExactlyOnceWith(message);
  });
});
