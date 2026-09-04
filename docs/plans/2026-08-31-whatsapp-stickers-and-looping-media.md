# WhatsApp Stickers and Looping Media

- **Date:** 31 August 2026
- **Status:** proposed implementation plan; no implementation started
- **Owner:** Panda WhatsApp, channel delivery and agent media
- **Decision state:** use first-class durable sticker and looping-video delivery;
  provide an optional agent-owned, Panda-managed media library; retain Baileys
  as the linked-device transport while accepting its upstream stability risk
- **Citation style:** Harvard author-date

## Abstract

Panda currently receives WhatsApp stickers as WebP attachments and records a
small amount of sticker metadata. It does not retain the `gifPlayback`
distinction for received looping videos, and its outbound WhatsApp adapter
supports only text, native images and document files. Consequently, an MP4 sent
through the current file option arrives as a document rather than playable
inline video, while native stickers and WhatsApp-style GIF playback cannot be
sent at all (Panda Agent, 2026c; Panda Agent, 2026d; Panda Agent, 2026e).

The recommended target is semantic media support rather than filename-based
special cases. Sticker and looping-video intents will become first-class
durable outbound items. A bounded WhatsApp media-preparation service will turn
supported source files into verified native artifacts. The WhatsApp adapter
will stream those artifacts through Baileys as a sticker message or an MP4
video with `gifPlayback: true`. Received media will preserve enough safe typed
metadata for Panda to distinguish a sticker, a looping video and an ordinary
video.

Reusable assets will be optional. The owning agent decides what to save, tag,
send and delete; Panda owns the durable storage, indexing, access control and
delivery mechanics. This agent-owned, Panda-managed split allows useful
curation without treating an ephemeral execution workspace as a durable media
database. It also avoids depending on a WhatsApp server-side sticker catalogue,
which is not a stable Baileys capability.

This is the best long-term design available while Panda uses a linked WhatsApp
account through Baileys. It does not eliminate the foundational risk that
Baileys is an unofficial, reverse-engineered transport. A future move to the
official WhatsApp Business Platform would be a transport migration, not a
reason to weaken the domain, storage or media-preparation boundaries described
here (WhiskeySockets, 2026b).

## 1. Background and problem statement

Panda already has three distinct channel-specific approaches to expressive
media:

1. Telegram supports received sticker inspection, agent-owned sticker saving,
   library search and native sticker sending by Telegram file ID or local file
   (Panda Agent, 2026i).
2. Discord supports native guild-sticker discovery and sending, while GIF files
   are validated and delivered as ordinary Discord media uploads. Remote GIF
   acquisition uses a bounded, SSRF-resistant downloader (Panda Agent, 2026h).
3. WhatsApp downloads images, videos, documents, stickers and audio, but exposes
   received media to the agent largely as generic attachments and supports only
   text, image and document outbound items (Panda Agent, 2026c; Panda Agent,
   2026d).

These protocols do not provide identical concepts. Telegram has reusable file
IDs and sticker sets. Discord has guild-owned sticker IDs and accepts uploaded
GIF files. WhatsApp uses WebP sticker messages and represents GIF-like playback
as an MP4 video with a protocol flag. A shared user experience is desirable,
but forcing these mechanics into one fake cross-channel sticker abstraction
would obscure authority, storage and delivery behaviour.

The implementation therefore needs to provide semantic parity:

- understand received stickers and looping videos;
- send them using native WhatsApp presentation;
- optionally save, search and reuse selected assets;
- preserve durable delivery status and external message IDs;
- operate safely on a local Mac mini and in Panda's container topology; and
- contain Baileys-specific protocol knowledge inside the WhatsApp integration.

## 2. Current state

### 2.1 Inbound media

`collectWhatsAppMediaParts` recognises `stickerMessage`, defaults its MIME type
to `image/webp` and records `whatsappMediaKind: "sticker"` plus the optional
`isAnimated` flag. Video messages are always recorded as
`whatsappMediaKind: "video"`; the Baileys `gifPlayback` field is not preserved
(Panda Agent, 2026c).

The media descriptor and its metadata survive into durable inbound metadata,
but prompt rendering lists only a generic attachment ID, filename, MIME type,
size and local path. WhatsApp history similarly omits the descriptor's nested
media metadata. The bytes therefore arrive, but the agent-facing semantic
contract is incomplete.

### 2.2 Outbound media

The shared outbound item union contains only `text`, `image` and `file`. The
WhatsApp adapter maps those to Baileys text, image and document messages. It
loads image and document files fully into memory with `readFile` before calling
`sendMessage` (Panda Agent, 2026b; Panda Agent, 2026d).

The current public command accurately exposes this boundary:

```text
panda whatsapp send --chat <jid-or-phone> --connector <key> \
  (--text <text|@file|@->|--stdin|--image <path>|--file <path>)...
```

`--image` sends a native WhatsApp image. `--file` sends a document. There is no
native outbound video, sticker or looping-video item (Panda Agent, 2026e).

### 2.3 Storage and runtime dependencies

Panda already resolves an agent-scoped media root under
`<PANDA_DATA_DIR>/agents/<agentKey>/media`, and its media store can relocate a
durable byte so that the agent media root becomes its single owner (Panda
Agent, 2026f; Panda Agent, 2026g).

`sharp` is a production dependency. `ffmpeg` is installed in the bash-runner
image, but not in the main application image that owns the WhatsApp worker.
Host availability and binary location on `panda-mini` are deployment facts that
must be checked before implementation rather than assumed (Panda Agent, 2026j;
Panda Agent, 2026k).

Panda pins and locally patches Baileys `7.0.0-rc14`. This is an explicit
compatibility boundary and requires upgrade-focused tests because release
candidate behaviour may change (Panda Agent, 2026j).

## 3. Aim and objectives

The aim is to provide native, durable and safe WhatsApp sticker and looping
media support without making the agent's execution workspace a hidden channel
database.

The implementation will:

1. preserve sticker and looping-video semantics on inbound messages;
2. add first-class durable outbound sticker and video items;
3. normalise supported inputs into conservative WhatsApp-compatible formats;
4. stream prepared artifacts rather than buffer complete outbound media;
5. give each agent an optional, explicitly curated reusable media library;
6. keep connector, session and conversation authority checks on every command;
7. preserve outbound delivery status, history and external message IDs;
8. bound network fetching, media decoding, conversion, disk use and temporary
   files; and
9. isolate Baileys wire details inside the WhatsApp adapter.

## 4. Facts fixed by the platform

The implementation must respect the following external constraints.

### 4.1 Stickers

WhatsApp stickers use WebP media. WhatsApp's published custom-sticker guidance
requires 512 by 512 pixels, a maximum of 100 KB for static stickers and 500 KB
for animated stickers, with animated content limited to 10 seconds (WhatsApp,
2026). Panda should use these values as conservative output requirements even
where a linked-device client may accept a broader input.

Baileys exposes sticker media as an individual sendable media message with an
optional animation flag. It does not provide a stable Telegram-equivalent
catalogue of an account's complete sticker tray or packs. Panda must therefore
own any durable reusable library it promises.

Sticker messages do not have a native caption field. If an agent supplies text
with a sticker, Panda must either send the text as a separate message or reject
the unsupported combination according to an explicit command contract. It must
not silently convert the sticker into an image merely to gain a caption.

### 4.2 GIF-style playback

WhatsApp does not send `.gif` files as native GIF messages. Baileys documents
the supported presentation as an MP4 video with `gifPlayback: true`
(WhiskeySockets, 2026a). The domain intent should therefore be called a looping
video or animation internally even if the user-facing command retains the
familiar name `whatsapp gif send`.

The conservative output is MP4 with H.264 video, `yuv420p`, AAC audio or no
audio and stream-friendly metadata. Meta publishes MP4/H.264 plus AAC or a
single absent audio stream as its compatible Business Platform video contract;
linked-device acceptance may differ, so real-device tests remain authoritative
for Panda's Baileys adapter (Meta Platforms, 2026).

### 4.3 Transport stability

Baileys is an unofficial WhatsApp Web client and is not affiliated with
WhatsApp. It warns users to expect breaking changes and to use the library in
accordance with WhatsApp's terms (WhiskeySockets, 2026b). Panda cannot remove
this risk through local abstraction. It can contain it through a narrow
adapter, a pinned dependency, contract fixtures and controlled upgrades.

## 5. Product and policy decisions

The following behaviour is Panda policy rather than a protocol requirement.

| Decision | Selected policy |
| --- | --- |
| Library participation | Optional and explicit; never auto-save all received media. |
| Ownership | The Panda agent owns the logical library. |
| Storage mechanics | Panda owns durable bytes, metadata, access control, deduplication and cleanup. |
| Initial chat scope | Private chats; group support remains outside this change. |
| Source types | Agent media reference, current-session inbound media reference, local/uploaded file and bounded HTTPS URL. |
| Static stickers | Supported in the first release. |
| Animated stickers | Supported in the first release, subject to the same bounded converter. |
| GIF command | Accept GIF or supported video input and always emit a verified looping MP4. |
| Captions | Allowed on looping video; sticker text is a separate outbound item. |
| Received-media saving | Explicit `save` command after current-session and ownership checks. |
| Retention | Library assets survive chat-media retention until explicitly deleted or covered by a future documented library policy. |
| Deduplication | SHA-256 within the owning agent library. |
| Remote URLs | HTTPS only through the existing safe-fetch boundary; private and local networks denied. |
| Ambiguous send outcome | Do not blindly resend when the socket may already have accepted the message. |
| Sticker pack metadata | Optional allowlisted presentation metadata; not an identity or authority source. |

The operator may later choose stricter byte, duration, resolution or library
quotas. Such limits should be configuration policy with conservative defaults,
not scattered encoder constants.

## 6. Architectural decision

### 6.1 Use durable outbound delivery

Sticker and looping-video sends are messages, not control side effects. Add
them to Panda's durable outbound item model and deliver them through the
existing outbound-delivery worker. Do not model them as new
`channel_actions`.

This gives the new message types the same durable status, reconnect draining,
history representation and external message IDs as text, image and document
delivery. The existing Telegram and Discord sticker-action implementation is
useful protocol evidence, but it should not force WhatsApp to inherit an action
ledger that cannot fully describe message results.

The domain shape should express user-visible intent without Baileys field
names. An indicative contract is:

```ts
interface OutboundStickerItem {
  type: "sticker";
  path: string;
  mimeType: "image/webp";
  animated: boolean;
}

interface OutboundVideoItem {
  type: "video";
  path: string;
  mimeType: "video/mp4";
  presentation: "video" | "looping";
  caption?: string;
}
```

`presentation: "looping"` maps to Baileys `gifPlayback: true` only inside the
WhatsApp adapter. Other channels may support these domain intents later, but
this change must not add speculative adapters or compatibility aliases.

### 6.2 Separate preparation from sending

Create a cohesive WhatsApp media-preparation module. It accepts an authorised
source and returns a durable, verified artifact descriptor. It does not send
messages. The outbound adapter accepts only prepared artifacts and does not
perform network fetching, format conversion or policy selection.

The preparation interface should be narrow and dependency-injected:

```ts
interface WhatsAppMediaPreparationService {
  prepareSticker(input: WhatsAppStickerSource): Promise<PreparedWhatsAppSticker>;
  prepareLoopingVideo(input: WhatsAppLoopingVideoSource): Promise<PreparedWhatsAppVideo>;
}
```

The service belongs under the WhatsApp integration because the target formats,
limits and presentation flags are channel-specific. Generic safe HTTP fetching,
process execution and filesystem primitives remain in their existing lower
modules.

### 6.3 Keep the library agent-owned and Panda-managed

The agent controls logical curation through explicit commands. Panda stores the
bytes beneath the agent-scoped media root and stores searchable metadata in
Postgres. A suggested channel-local record is:

```ts
interface AgentWhatsAppMediaAsset {
  id: string;
  agentKey: string;
  kind: "sticker" | "looping_video";
  contentHash: string;
  mimeType: "image/webp" | "video/mp4";
  localPath: string;
  sizeBytes: number;
  width: number;
  height: number;
  durationMs?: number;
  animated: boolean;
  tags: readonly string[];
  description?: string;
  sourceConnectorKey?: string;
  sourceMediaId?: string;
  createdAt: number;
  updatedAt: number;
}
```

Opaque references such as `wa-media:<uuid>` are the agent-facing contract.
Absolute storage paths are implementation details and must not become durable
model identifiers.

Do not use the ordinary agent workspace as the library. Execution environments
may be disposable or physically separate from the daemon and WhatsApp worker.
A workspace file can disappear between command admission and durable delivery,
breaking queued sends. Raw paths also make ownership, deduplication, backup and
safe deletion needlessly ambiguous.

One-off sending remains supported: an agent can send a prepared file without
saving it into the reusable library. The library is a curation feature, not a
mandatory ingestion sink.

## 7. Proposed implementation

### 7.1 Complete inbound semantic classification

Extend WhatsApp media collection to preserve an allowlisted typed summary:

- media kind: image, video, looping video, sticker, audio or document;
- sticker animation flag;
- video GIF-playback flag;
- width and height where present;
- duration where present; and
- voice-note presentation where present.

Prompt rendering should include compact semantic lines such as
`kind: sticker`, `animated: true` or `presentation: looping`. WhatsApp history
should return the same safe fields. Do not expose raw protobuf objects, media
keys, direct paths, remote URLs or unbounded Baileys metadata.

Received sticker bytes already pass through bounded, idempotent media download.
Preserve that path. Classification must not cause media decoding on the socket
ingress loop.

### 7.2 Resolve authorised media sources

Commands may resolve one of four source types:

1. an opaque agent-library reference;
2. an opaque inbound media reference found in the current session and chat;
3. a file delivered through the existing command-file/upload boundary; or
4. a remote HTTPS URL acquired through `fetchSafeHttpResource`.

The command layer must enforce current-session conversation binding and
connector access before expensive download or conversion. An inbound media
reference must resolve only inside the current session, source, connector and
conversation. A library reference must belong to `request.scope.agentKey`.

Remote retrieval must bound redirects, bytes and time; reject private,
loopback, link-local and metadata-service destinations; verify every redirect;
and validate content by signature rather than `Content-Type` or filename alone.
The existing Discord GIF downloader demonstrates the relevant safe-fetch seam,
but WhatsApp must apply its own input and output policy (Panda Agent, 2026h).

### 7.3 Prepare static stickers

For static image input:

1. validate the source signature and a bounded decoded pixel count;
2. strip untrusted metadata;
3. orient the image deterministically;
4. fit it within a transparent 512 by 512 canvas without distortion;
5. encode WebP using bounded deterministic settings;
6. reduce quality through a bounded strategy if necessary;
7. reject output that still exceeds the configured static limit; and
8. reopen and verify MIME, dimensions, frame count and actual byte size.

`sharp` is suitable for this static path. The implementation must explicitly
disable accidental enlargement or animation flattening where those behaviours
would violate the selected source contract.

### 7.4 Prepare animated stickers

Animated input must run through a bounded external conversion process rather
than unbounded in-process frame expansion. The converter will:

- reject duration, frame count, pixel and input-byte limits before conversion
  where metadata permits;
- resize onto a 512 by 512 transparent canvas;
- cap duration and frame rate;
- emit animated WebP;
- enforce a wall-clock timeout and single-job concurrency initially;
- kill the complete subprocess on cancellation or timeout;
- remove partial output; and
- verify the encoded output independently before publication.

The exact encoder and flags must be locked with fixtures on macOS arm64 and the
production Linux image. A command discovered only on a developer's shell is not
a supported runtime dependency.

### 7.5 Prepare looping video

GIF and supported video inputs will be normalised to MP4. The initial output
profile should use:

- H.264 video;
- `yuv420p` pixel format;
- even dimensions within a conservative maximum bounding box;
- bounded duration and frame rate;
- no audio by default for GIF-derived sources;
- AAC only when retained by explicit policy;
- fast-start metadata; and
- a configured output-byte ceiling below the observed linked-device maximum.

Run `ffprobe` before and after conversion. Reject extra streams, unsupported
codecs, excessive dimensions, duration discrepancies and output larger than
policy. Do not trust a successful `ffmpeg` exit code as proof of a valid
WhatsApp artifact.

### 7.6 Publish durable artifacts

Conversion output should first live in a private temporary directory. After
verification, publish it atomically through the agent media store with:

- a content hash;
- canonical MIME and extension;
- typed safe metadata;
- agent ownership;
- source provenance; and
- a stable ID used by the queued delivery.

The queued delivery must refer to a durable artifact that outlives the command
process. Temporary paths must never enter the delivery table. If enqueueing
fails, clean up an unowned one-off artifact according to an explicit ownership
rule; do not delete a saved library asset.

### 7.7 Send native messages

The WhatsApp outbound adapter will map prepared items as follows:

```ts
await socket.sendMessage(jid, {
  sticker: {url: item.path},
  mimetype: "image/webp",
  isAnimated: item.animated,
});

await socket.sendMessage(jid, {
  video: {url: item.path},
  mimetype: "video/mp4",
  gifPlayback: item.presentation === "looping",
  ...(item.caption ? {caption: item.caption} : {}),
});
```

Use Baileys' path/stream media input rather than reading the complete file into
memory. Require a non-empty returned external message ID before marking the
delivery sent. History must serialise the semantic item type without exposing
its local path.

Reply support should be added only when Panda retains enough WhatsApp message
key context to quote the exact target safely. A bare external message ID must
not be expanded into a guessed Baileys message object.

### 7.8 Add agent commands

The intended public surface is:

```text
panda whatsapp sticker inspect <media-ref> --chat <jid> --connector <key>
panda whatsapp sticker save <media-ref> --chat <jid> --connector <key> \
  [--tag <tag>...] [--description <text>]
panda whatsapp sticker list [--query <text>] [--tag <tag>] [--limit <n>]
panda whatsapp sticker send --chat <jid> --connector <key> \
  (--ref <wa-media-ref>|--media <inbound-ref>|--file <path>|--url <https-url>)

panda whatsapp gif send --chat <jid> --connector <key> \
  (--ref <wa-media-ref>|--media <inbound-ref>|--file <path>|--url <https-url>) \
  [--caption <text>]

panda whatsapp media delete <wa-media-ref>
```

`sticker save` is the only path that adds an inbound asset to the reusable
library. Sending an inbound reference directly is a one-off operation. The
commands must expose queued delivery IDs and prepared-media summaries, not
Baileys objects or filesystem paths.

Do not add sticker-pack import, arbitrary WhatsApp file IDs or aliases copied
from Telegram. Discovery, saving and sending should use opaque Panda-owned
references.

## 8. Persistence

Add a forward-only migration for an agent-owned WhatsApp media asset table. The
schema should enforce:

- UUID primary key;
- non-empty agent key;
- constrained asset kind and MIME combinations;
- positive dimensions and non-negative duration;
- non-negative byte size;
- fixed-format SHA-256 digest;
- unique `(agent_key, content_hash, kind)` identity;
- JSON-free typed columns for policy-critical fields;
- bounded tags and descriptions; and
- creation and update timestamps.

The database stores the durable record; the filesystem stores the bytes. A
create operation must publish both consistently or remove the partial result.
A delete operation should remove metadata and bytes through one service with
idempotent missing-file handling. Do not let command handlers issue raw file
deletions.

Library listings must be scoped by agent. Conversation authority is required
for chat-local inbound references and sends, but not for listing the owning
agent's private library. Session-scoped readonly views should expose only
library metadata deliberately required by model queries; local paths remain
private to the service and worker.

## 9. Security and resource controls

Media is hostile input even when it arrives from a paired contact. The
implementation must include:

- admission limits on declared and actual bytes;
- decoded pixel, frame, duration and stream-count limits;
- MIME/signature verification;
- SSRF-safe URL retrieval and redirect handling;
- bounded conversion concurrency and queue length;
- hard subprocess and download timeouts;
- cancellation propagation and complete temporary cleanup;
- no shell interpolation of filenames, URLs or metadata;
- metadata stripping and allowlisted reconstruction;
- private file permissions;
- agent and connector ownership checks;
- no raw media URLs, keys, phone numbers or local paths in routine logs;
- quotas and observable storage consumption; and
- dependency monitoring for Baileys, Sharp/libvips, FFmpeg and WebP decoders.

Conversion should not execute on the WhatsApp socket ingress path. A slow or
malicious artifact must not delay acknowledgements, reconnect handling or
ordinary text delivery.

## 10. Runtime packaging and operations

The process that prepares WhatsApp media requires a deterministic
`ffmpeg`/`ffprobe` installation. The supported binaries and versions must be
present in both local Mac and container deployments. Panda should resolve an
explicit configured binary or a verified startup path; it should not rely on an
interactive shell's `PATH`.

Add a media-preparation readiness component distinct from socket health. It
should report only safe facts:

- converter available or unavailable;
- supported static, animated and looping-video capabilities;
- active and queued job counts;
- last successful preparation timestamp; and
- bounded failure reason categories.

Initial conversion concurrency should be one per daemon. Record input bytes,
output bytes, duration, preparation time and result category without logging
the content, source URL, local path or chat identifier.

One-off durable artifacts require a cleanup policy linked to terminal delivery
state and retention. Saved library assets must never be swept by the one-off
artifact cleaner.

## 11. Delivery sequence

### Phase 0: contract and fixture spike

Collect real static sticker, animated sticker, GIF and ordinary video fixtures.
Prove the selected encoder profile on macOS arm64 and the production Linux
image. Send the resulting artifacts through the pinned Baileys version to
Android, iOS and WhatsApp Web. Confirm visual playback, byte ceilings and
returned external message IDs before changing persistence.

### Phase 1: inbound semantic completion

Preserve `gifPlayback`, safe dimensions and duration in inbound media metadata.
Expose sticker and looping-video classification in prompt text and WhatsApp
history. Add fixture-based parsing tests without decoding on ingress.

### Phase 2: first-class durable outbound items

Add sticker and video item types, Postgres serialisation, delivery-history
serialisation and adapter support. Initially accept only already-compliant
artifacts so durable delivery behaviour can be proven independently from
conversion.

### Phase 3: bounded media preparation

Add safe source resolution, static sticker preparation, animated sticker
preparation, looping-video conversion, post-conversion validation, runtime
packaging, readiness and resource controls.

### Phase 4: agent-owned library

Add the migration, service, inspect/save/list/delete operations, opaque
references, deduplication and explicit chat-media import. Direct one-off sending
must remain available.

### Phase 5: operational hardening

Exercise worker restart, socket reconnect, conversion cancellation, disk-full,
missing artifact, corrupt artifact, ambiguous send result, dependency upgrade
and retention cleanup scenarios. Document canary and rollback procedures.

## 12. Verification strategy

### 12.1 Behaviour-level tests

Protect behaviour through public seams:

- received static and animated stickers retain correct classification;
- received `gifPlayback` video is presented as looping media, not ordinary
  video;
- prompt and history expose safe semantic metadata and no secrets;
- static sticker conversion produces verified 512 by 512 WebP within policy;
- animated sticker conversion respects byte, duration, frame and timeout
  limits;
- GIF and video sources produce verified MP4/H.264 looping artifacts;
- mislabeled, malformed, oversized and decompression-heavy inputs fail closed;
- remote URLs reject private destinations and unsafe redirects;
- only an authorised current-session chat media reference can be imported;
- an agent cannot read or send another agent's saved asset;
- duplicate content resolves to one agent-owned asset;
- one-off sending does not add an item to the reusable library;
- queued delivery survives process restart and uses a durable artifact;
- sticker and looping-video sends return external WhatsApp message IDs;
- `whatsapp.history` identifies sent sticker and looping-video items; and
- converter failure does not block WhatsApp text ingress or delivery.

### 12.2 Repository checks

Run focused suites followed by the cross-layer gates:

```bash
pnpm exec vitest run \
  tests/whatsapp-media.test.ts \
  tests/whatsapp-message-ingestion.test.ts \
  tests/whatsapp-outbound.test.ts \
  tests/whatsapp-cli.test.ts \
  tests/command-cli.test.ts \
  tests/media-store.test.ts

pnpm typecheck
pnpm architecture:import-law:ratchet
pnpm agent-command-shim:check
pnpm ci:prompt-contracts
git diff --check
```

Add focused Postgres tests for the library migration and store. Run `pnpm
smoke` against a disposable `TEST_DATABASE_URL` because the change crosses
command, persistence, worker and delivery boundaries. Inspect the generated
smoke summary before raw logs on failure.

### 12.3 Real-device acceptance

Using a dedicated authorised test chat, verify:

1. receive and inspect a static sticker;
2. receive and inspect an animated sticker;
3. receive a GIF-style video and distinguish it from ordinary video;
4. send a static sticker from file and from a saved reference;
5. send an animated sticker from file and from a received-media reference;
6. send GIF input and observe looping inline playback;
7. send an ordinary MP4 and observe ordinary inline video playback;
8. restart Panda before a queued send drains and confirm exactly one visible
   result or an explicit ambiguous failure;
9. list, search and delete the agent's saved assets; and
10. confirm a second agent cannot discover or send those references.

## 13. Principal risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Baileys or WhatsApp changes the private wire contract. | Pin Baileys, retain protocol fixtures, run real-device canaries before upgrades and keep wire fields local to the adapter. |
| A malformed media file exploits a decoder. | Bound input before decode, isolate external conversion, use hard timeouts and maintain Sharp/FFmpeg/WebP updates. |
| Conversion exhausts CPU, RAM or disk on the Mac mini. | Single-job concurrency, queue limits, pixel/frame/duration limits, private temporary directories and cleanup. |
| A remote URL reaches an internal service. | Reuse the SSRF-safe fetch boundary and validate every redirect. |
| A queued send references a vanished workspace file. | Publish a durable agent-media artifact before enqueueing. |
| Automatic saving creates privacy and storage growth. | Save only through an explicit agent action and enforce quotas. |
| The agent cannot find reusable assets. | Store typed metadata, tags and description under opaque refs with bounded search. |
| A saved asset leaks across agents. | Agent-key ownership in schema and service-level access checks; never authorise by path. |
| A sticker silently becomes an image or document. | First-class item types and fail-closed adapter mapping. |
| History claims a send that WhatsApp never accepted. | Require the returned message ID and represent ambiguous socket outcomes explicitly. |
| Main app lacks the converter despite runner support. | Package and health-check the converter in the actual preparation runtime. |
| A broad generic media framework spreads protocol policy. | Keep target validation and Baileys mapping local to WhatsApp; share only proven lower-level primitives. |

## 14. Non-goals

- Synchronising the user's complete WhatsApp sticker tray or pack catalogue.
- Creating or publishing WhatsApp sticker packs.
- Treating raw Baileys media keys or file IDs as durable Panda references.
- Auto-saving every received sticker or animation.
- Making an execution workspace the source of truth for durable media.
- Enabling WhatsApp group ingress.
- Adding video transcoding to every channel in the same change.
- Building a universal cross-channel sticker provider abstraction.
- Implementing official WhatsApp Business Platform migration.
- Bypassing WhatsApp terms, anti-spam controls or account policy.

## 15. Definition of done

The work is complete when:

1. inbound stickers and looping videos retain typed semantic metadata;
2. prompt and history surfaces expose that metadata safely;
3. sticker and video are first-class durable outbound items;
4. prepared sticker and looping-video artifacts meet verified output policy;
5. outbound media streams through Baileys without whole-file buffering;
6. native sends retain durable status and returned external message IDs;
7. the owning agent can explicitly save, list, search, send and delete reusable
   WhatsApp media through opaque references;
8. one-off sending works without saving to the library;
9. workspaces and raw filesystem paths are not durable library authority;
10. network, decode, conversion, disk and concurrency limits fail closed;
11. converter readiness is visible in the runtime that actually prepares media;
12. focused tests, typecheck, import law, command-shim checks, prompt contracts
    and disposable-database smoke pass; and
13. static sticker, animated sticker, looping video and ordinary video pass the
    real-device acceptance matrix.

## 16. Conclusion

The selected design is the strongest long-term solution available under
Panda's current linked-device WhatsApp constraint. It treats stickers and
looping media as durable message semantics, keeps format conversion outside the
socket adapter and gives agents control over an optional reusable library
without handing persistence to ephemeral workspaces.

The remaining strategic risk is Baileys itself. Panda should accept that risk
explicitly, contain it behind the WhatsApp integration and retain a domain and
storage model that could survive a future move to the official WhatsApp
Business Platform.

## References

Meta Platforms (2026) *WhatsApp Business Platform: media*. Available at:
<https://www.postman.com/meta/whatsapp-business-platform/folder/13382743-ecb27be5-4d27-4763-bbee-6a8002c04bf3>
(Accessed: 31 August 2026).

Mojzis, P. and Codex (2026) *WhatsApp sticker, GIF and agent media library
architecture discussion*, 31 August. Unpublished internal product discussion.

Panda Agent (2026a) *Panda architecture*. Available at:
[`docs/developers/architecture.md`](../developers/architecture.md) (Accessed: 31
August 2026).

Panda Agent (2026b) *Channel outbound types*. Available at:
[`src/domain/channels/types.ts`](../../src/domain/channels/types.ts) (Accessed:
31 August 2026).

Panda Agent (2026c) *WhatsApp media ingestion*. Available at:
[`src/integrations/channels/whatsapp/media.ts`](../../src/integrations/channels/whatsapp/media.ts)
(Accessed: 31 August 2026).

Panda Agent (2026d) *WhatsApp outbound adapter*. Available at:
[`src/integrations/channels/whatsapp/outbound.ts`](../../src/integrations/channels/whatsapp/outbound.ts)
(Accessed: 31 August 2026).

Panda Agent (2026e) *WhatsApp command module*. Available at:
[`src/integrations/channels/whatsapp/commands.ts`](../../src/integrations/channels/whatsapp/commands.ts)
(Accessed: 31 August 2026).

Panda Agent (2026f) *Data directory resolution*. Available at:
[`src/lib/data-dir.ts`](../../src/lib/data-dir.ts) (Accessed: 31 August 2026).

Panda Agent (2026g) *Filesystem media store*. Available at:
[`src/domain/channels/media-store.ts`](../../src/domain/channels/media-store.ts)
(Accessed: 31 August 2026).

Panda Agent (2026h) *Discord GIF preparation service*. Available at:
[`src/integrations/channels/discord/gifs.ts`](../../src/integrations/channels/discord/gifs.ts)
(Accessed: 31 August 2026).

Panda Agent (2026i) *Telegram sticker commands*. Available at:
[`src/integrations/channels/telegram/sticker-commands.ts`](../../src/integrations/channels/telegram/sticker-commands.ts)
(Accessed: 31 August 2026).

Panda Agent (2026j) *Package manifest*. Available at:
[`package.json`](../../package.json) (Accessed: 31 August 2026).

Panda Agent (2026k) *Runtime container image*. Available at:
[`Dockerfile`](../../Dockerfile) (Accessed: 31 August 2026).

WhatsApp (2026) *How to create and share custom stickers and sticker packs*.
Available at:
<https://faq.whatsapp.com/1056840314992666/?cms_platform=android&locale=en_US>
(Accessed: 31 August 2026).

WhiskeySockets (2026a) *Baileys README: media messages*. Available at:
<https://github.com/WhiskeySockets/Baileys/blob/master/README.md> (Accessed: 31
August 2026).

WhiskeySockets (2026b) *Baileys quickstart*. Available at:
<https://github.com/WhiskeySockets/docs/blob/main/quickstart.mdx> (Accessed: 31
August 2026).
