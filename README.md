# pi-selfprompt-extension

Pi extension that adds:

- `/selfprompt` — asks the agent to draft and queue a better follow-up prompt for itself.
- `self_prompt` tool — lets the agent queue an extension-originated user message, optionally after a delay.

## Install

```bash
pi install git:github.com/KarthikRaju391/pi-selfprompt-extension
```

Then restart pi or run `/reload`.

## Usage

```text
/selfprompt investigate this bug and continue with a crisp plan
/selfprompt --delay 10m check whether the long-running command finished
/selfprompt --raw --delay 30s Run a quick status check now.
```

The tool enforces a 24-hour maximum delay and waits for the agent to become idle before delivering queued messages.
