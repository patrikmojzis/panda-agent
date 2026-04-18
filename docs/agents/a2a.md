# A2A For Agents

Use `message_agent` when the recipient is another Panda session.

Use `outbound` when the recipient is a human on Telegram, WhatsApp, or another external channel.

Do not try to tunnel Panda-to-Panda through `outbound`. Panda blocks that, and rightly so.

## When To Use It

Good fit:

- hand work to another Panda agent
- wake a specific branch session
- send files or images to another Panda session
- fire off a task and keep moving

Bad fit:

- talking to a human
- messaging your own current session
- waiting for an immediate reply in the same tool call

## Targeting

- `agentKey` means the recipient agent's `main` session
- `sessionId` means one exact session
- passing both is allowed and makes Panda validate that the session belongs to that agent
- use `sessionId` for branch sessions or any non-main lane

## Contract

```json
{
  "agentKey": "koala",
  "items": [
    {"type": "text", "text": "Please summarize logs/app.log and send me the root cause."}
  ]
}
```

Exact item types:

```json
{
  "sessionId": "session_123",
  "items": [
    {"type": "text", "text": "Check this screenshot and the attached CSV."},
    {"type": "image", "path": "artifacts/error.png", "caption": "Current UI state"},
    {"type": "file", "path": "artifacts/data.csv", "filename": "data.csv", "mimeType": "text/csv"}
  ]
}
```

## Default Rhythm

1. use `agentKey` when the recipient main session is fine
2. use `sessionId` when the target lane matters
3. send a clear, self-contained task
4. continue your own work
5. if you need a reply, the other session must message you back separately

This is fire-and-forget, not RPC.

## Attachments

- text, image, and file items are supported
- relative paths resolve from the current runtime working directory/context
- max `10` items per send
- max `20 MB` per attachment
- max `50 MB` total attachment bytes per send

The receiver gets durable receiver-local media.
Do not talk as if your sender-local filesystem path survives on the other side. It does not.

## Returns

`message_agent` returns queued metadata like:

- `status: "queued"`
- `deliveryId`
- `targetAgentKey`
- `targetSessionId`
- `messageId`

Queued means the delivery worker owns it now.
It does not mean the other session has already answered.

## Failure Cases

Common reasons it fails:

- no A2A binding for `senderSessionId -> recipientSessionId`
- you tried to message your own current session
- the rate limit fired
- the attachment path does not exist or is unreadable
- the attachment is too large

## Good Habits

- pick `agentKey` only when main-session delivery is really what you want
- pick `sessionId` for branch work
- make the task explicit instead of sending vague "look at this" messages
- attach the exact artifact you want reviewed
- assume the receiver may wake immediately

## Avoid

- using `outbound` for Panda-to-Panda messaging
- using `agentKey` when you really mean a branch session
- assuming you can wait for a synchronous response
- sending your whole workspace because you were too lazy to pick a file
