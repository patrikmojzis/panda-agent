# A2A For Agents

Use `panda a2a send` when the recipient is another Panda session.

Use provider commands such as `panda telegram send`, `panda discord send`, or `panda whatsapp send` when the recipient is a human on an external channel.

Do not try to tunnel Panda-to-Panda through outbound channels. Panda blocks that, and rightly so.

## When To Use It

Good fit:

- hand work to another Panda agent
- wake a specific branch session
- send file attachments, including images, to another Panda session
- fire off a task and keep moving

Bad fit:

- talking to a human
- messaging your own current session
- waiting for an immediate reply in the same tool call

## Targeting

- `--to-agent` means the recipient agent's `main` session
- `--to-session` means one exact session
- use `--to-session` for branch sessions or any non-main lane

## Contract

```sh
panda a2a send --to-agent koala --text "Please summarize logs/app.log and send me the root cause."
```

Exact item types:

```sh
panda a2a send --to-session session_123 --text "Check this screenshot and the attached CSV." --file artifacts/error.png --file artifacts/data.csv
```

## Default Rhythm

1. use `--to-agent` when the recipient main session is fine
2. use `--to-session` when the target lane matters
3. send a clear, self-contained task
4. continue your own work
5. if you need a reply, the other session must message you back separately

This is fire-and-forget, not RPC.

## Attachments

- text and attachments are supported; use files for images in the CLI
- relative paths resolve from the current runtime working directory/context
- max `10` items per send
- max `20 MB` per attachment
- max `50 MB` total attachment bytes per send

The receiver gets durable receiver-local media.
Do not talk as if your sender-local filesystem path survives on the other side. It does not.

## Returns

`panda a2a send` returns queued metadata like:

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

- pick `--to-agent` only when main-session delivery is really what you want
- pick `--to-session` for branch work
- make the task explicit instead of sending vague "look at this" messages
- attach the exact artifact you want reviewed
- assume the receiver may wake immediately

## Avoid

- using outbound channels for Panda-to-Panda messaging
- using `--to-agent` when you really mean a branch session
- assuming you can wait for a synchronous response
- sending your whole workspace because you were too lazy to pick a file
