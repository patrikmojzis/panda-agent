# Browser cancellation: ownership and cleanup plan

**Status:** Recon complete; implementation pending.  
**Observed revision:** `39251993` (5 September 2026).  
**Scope:** Browser client, HTTP runner, session service and artifact writes. No production changes.

## 1. Problem and evidence

Cancellation currently stops at neither end of the browser request. A pre-aborted
`BrowserTool.run` with a synthetic fetch still issued one request and returned a
successful result. The client supplies only its network timeout to fetch; the
runner passes a disconnect signal that the service never consumes (Panda Agent,
2026a; 2026b; 2026c).

The runner installs `request.on("close")` after reading the request body. A local
Node 26.8.1 probe found request closure already occurred during body consumption
for both healthy and disconnected requests. Premature response closure, checked
against `response.writableFinished`, distinguished disconnect from success.
`request.destroyed` was true for healthy completed request bodies too and must
not become a post-body cancellation guard (Panda Agent, 2026b).

The existing timeout cleanup also needs careful ownership. `closeSession` waits
for storage-state persistence before closing Chromium; blocked persistence can
leave an action running. Concurrent actions/startups can share a scope, so closing
by scope key after an asynchronous wait can close a replacement session. Startup,
page recovery and input fallbacks can continue after cancellation unless they
check the operation's state. Existing artifact and shared storage-state writes
can also finish after cancellation; checking a signal after an await cannot undo
an issued write (Panda Agent, 2026c; 2026d).

## 2. Decision

Fix cancellation across all three browser layers. A client-only fetch abort would
end the local wait while leaving remote work running. Keep the implementation
inside the existing browser module, using a small private admission queue per
normalized session/device scope and explicit ownership of acquired resources.
Different scopes must remain parallel. Do not add a general scheduling framework.

## 3. Implementation sequence

| Step | Required change | Acceptance evidence |
| --- | --- | --- |
| B01 | Check client pre-abort before sending; combine caller and network deadline; clear timers/listeners; recheck after parsing and before artifact persistence/return. Use a fixed cancellation error. | Pre-aborted tool performs no fetch; in-flight call ends without replay or exposing its arbitrary abort reason. |
| B02 | Detect aborted bodies and unfinished response closure in the HTTP runner; remove listeners on settlement. | Actual HTTP disconnect reaches the service; normal response completion preserves session reuse. |
| B03 | Give each normalized scope an abortable admission queue. Include queue time in the request deadline. A canceled waiter must never start or close the active operation's resources. | Held first action, canceled second action and successful third action retain ordering and resource ownership; another scope proceeds independently. |
| B04 | Extend the existing action timeout boundary to cancellation. Detach the exact affected session, invalidate its generation and initiate dirty browser closure before releasing admission. Skip storage-state persistence during dirty teardown. | Browser closure starts despite blocked storage persistence; late cleanup cannot close a newer session. |
| B05 | Guard asynchronous acquisition, cache insertion, navigation, page recovery and input/context-creation fallbacks. Dispose resources acquired after cancellation. | Delayed DNS/launch/context/page creation never navigates or caches late resources; interrupted fill/Enter does not issue fallback input. |
| B06 | Suppress canceled progress and publication of artifacts/storage state. Stage writes under operation-owned paths, serialize publication with scope ownership and clean up late temporary files by exact path. Define settlement for publication already issued before cancellation; retain normal persistence and explicit close. | Delayed artifact/storage writes cannot publish canceled results or overwrite a replacement generation; owned temporary files are removed when pending writes settle. Normal persistence and unaffected sessions continue working. |

## 4. Contracts to preserve

- Public `BrowserTool` options, injected services and client `close()` remain.
- Keep action schemas, wire fields, authentication and navigation/origin policy.
- Keep existing timeout error wording and details; distinguish fixed cancellation
  errors without forwarding arbitrary caller reasons.
- Preserve normal storage-state persistence and explicit close behavior.
- Never retry a canceled action, recreate its page/context through recovery, or
  replay input whose external effect may already have happened.
- Capture generation/resource references before awaits. Late cleanup must not
  resolve a newer session by key and act on it.
- Do not write storage state directly to the shared scope path while an old
  operation can outlive admission. A separate current-owner check followed by
  an asynchronous publish is insufficient unless the ownership transition also
  accounts for that pending publication.

## 5. Verification and limits

Use the existing browser tool/runner/session-service test seams, including a real
local HTTP disconnect and controllable fake Chromium resources. Cover delayed
startup, blocked persistence, cancellation during input fallbacks, canceled queue
waiters, resource arrival after cancellation, delayed artifact/storage writes,
session replacement and independent device scopes. Check unchanged protocol/auth/navigation tests, typecheck, import
law and supported package exports. Then run the combined suite and appropriate
local runtime validation before committing.

Cancellation cannot roll back navigation, submitted forms or other external
effects already issued. HTTP abort does not acknowledge that Chromium has
finished closing. The launcher interface cannot interrupt a promise that never
settles; resources returned late must be closed immediately. Already-issued file
writes can also settle later: the guarantee concerns ownership and publication,
not instantaneous rollback of filesystem effects. Tests and user-facing errors
must not claim stronger guarantees than these boundaries provide.

## References

Panda Agent (2026a) *BrowserRunnerClient.handle and BrowserTool.handle*. Available
at: [client.ts](../../../src/integrations/browser/client.ts) and
[browser-tool.ts](../../../src/panda/tools/browser-tool.ts) (Accessed: 5 September 2026).

Panda Agent (2026b) *Browser runner HTTP request lifecycle*. Available at:
[runner.ts](../../../src/integrations/browser/runner.ts) (Accessed: 5 September 2026).

Panda Agent (2026c) *Browser session admission, timeout, startup and cleanup*.
Available at: [session-service.ts](../../../src/integrations/browser/session-service.ts)
(Accessed: 5 September 2026).

Panda Agent (2026d) *Browser artifact writes and client persistence*. Available at:
[artifacts.ts](../../../src/integrations/browser/artifacts.ts) and
[client.ts](../../../src/integrations/browser/client.ts) (Accessed: 5 September 2026).
