import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MAX_DELAY_SECONDS = 24 * 60 * 60;
const IDLE_POLL_MS = 250;

const SelfPromptParams = Type.Object({
  prompt: Type.String({
    description:
      "The exact follow-up user message to inject. It should be a crisp instruction to yourself, not a pretend answer from the user.",
  }),
  reason: Type.String({ description: "Why a new self-prompt turn is useful." }),
  delay: Type.Optional(
    Type.Number({
      description:
        "Delay before injecting the prompt, in seconds. Defaults to 0 (immediate). Max 86400 (24h). If the agent is busy, the delay starts once it is idle and delivery waits for idle.",
      minimum: 0,
      maximum: MAX_DELAY_SECONDS,
    }),
  ),
});

function buildSelfPromptDraftingInstruction(seed: string): string {
  const objective = seed.trim()
    ? seed.trim()
    : "No explicit seed was provided. Infer from the current conversation what self-prompt would most improve accuracy, usefulness, or control flow.";

  return [
    "You are handling a `/selfprompt` request from the user.",
    "",
    "Do NOT answer the objective directly in this turn.",
    "Your job is to write the best possible detailed follow-up prompt for yourself, then inject that generated prompt as a new extension-originated user message by calling the `self_prompt` tool.",
    "",
    "Objective / seed from the user:",
    objective,
    "",
    "Requirements for the generated prompt:",
    "- It must be a full, standalone instruction to yourself, not merely a restatement of the seed.",
    "- Make it specific, operational, and context-aware.",
    "- Include what to inspect, what evidence to gather, constraints, safety rules, success criteria, and desired output format when relevant.",
    "- If facts only the human can know are missing, do not fabricate them; the generated prompt should instruct you to ask the user concise clarification questions normally and wait before proceeding.",
    "- If safe assumptions are enough, state those assumptions inside the generated prompt.",
    "- If the seed asks for a timed follow-up, set `self_prompt.delay` to the requested seconds; otherwise omit it.",
    "- Call `self_prompt` exactly once with the generated prompt and a concise reason.",
    "- The `prompt` argument to `self_prompt` must be the full generated prompt, not the raw seed text above.",
    "",
    "Now draft the prompt and call `self_prompt` with `{ prompt, reason }`, adding `delay` only if needed.",
  ].join("\n");
}

function trimNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
}

function formatDelay(seconds: number): string {
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
  if (seconds < 60) return `${trimNumber(seconds)}s`;
  if (seconds < 3600) return `${trimNumber(seconds / 60)}m`;
  return `${trimNumber(seconds / 3600)}h`;
}

function parseDelay(value: string): number | undefined {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(ms|s|sec|secs|m|min|mins|h|hr|hrs)?$/i);
  if (!match) return undefined;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < 0) return undefined;

  const unit = (match[2] ?? "s").toLowerCase();
  const seconds = unit === "ms" ? amount / 1000 : unit.startsWith("m") ? amount * 60 : unit.startsWith("h") ? amount * 3600 : amount;

  return seconds <= MAX_DELAY_SECONDS ? seconds : undefined;
}

function parseSelfPromptArgs(input: string): { raw: boolean; delay: number; text: string; error?: string } {
  let rest = input.trim();
  let raw = false;
  let delay = 0;

  while (rest) {
    if (rest === "--raw" || rest.startsWith("--raw ")) {
      raw = true;
      rest = rest.slice("--raw".length).trim();
      continue;
    }

    const delayMatch = rest.match(/^--delay(?:-seconds)?(?:=|\s+)(\S+)(?:\s+|$)/);
    if (delayMatch) {
      const parsed = parseDelay(delayMatch[1]);
      if (parsed === undefined) {
        return {
          raw,
          delay,
          text: rest,
          error: "Invalid --delay. Use 30s, 5m, or 1h (max 24h).",
        };
      }
      delay = parsed;
      rest = rest.slice(delayMatch[0].length).trim();
      continue;
    }

    break;
  }

  return { raw, delay, text: rest };
}

function sendSelfPrompt(pi: ExtensionAPI, ctx: ExtensionContext, prompt: string) {
  if (ctx.isIdle()) {
    pi.sendUserMessage(prompt);
  } else {
    pi.sendUserMessage(prompt, { deliverAs: "followUp" });
  }
}

function setTrackedTimeout(
  timers: Set<ReturnType<typeof setTimeout>>,
  callback: () => void,
  delayMs: number,
) {
  let timer: ReturnType<typeof setTimeout>;
  timer = setTimeout(() => {
    timers.delete(timer);
    callback();
  }, delayMs);
  timers.add(timer);
}

function whenIdle(ctx: ExtensionContext, timers: Set<ReturnType<typeof setTimeout>>, callback: () => void) {
  if (ctx.isIdle()) {
    callback();
    return;
  }

  setTrackedTimeout(timers, () => whenIdle(ctx, timers, callback), IDLE_POLL_MS);
}

function scheduleSelfPrompt(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  prompt: string,
  delay: number,
  timers: Set<ReturnType<typeof setTimeout>>,
): { delayed: boolean; delayAfterIdle: boolean } {
  const delayMs = Math.round(delay * 1000);
  if (delayMs <= 0) {
    sendSelfPrompt(pi, ctx, prompt);
    return { delayed: false, delayAfterIdle: false };
  }

  const delayAfterIdle = !ctx.isIdle();
  const startDelay = () =>
    setTrackedTimeout(timers, () => whenIdle(ctx, timers, () => pi.sendUserMessage(prompt)), delayMs);

  if (delayAfterIdle) {
    whenIdle(ctx, timers, startDelay);
  } else {
    startDelay();
  }

  return { delayed: true, delayAfterIdle };
}

export default function (pi: ExtensionAPI) {
  const timers = new Set<ReturnType<typeof setTimeout>>();

  pi.on("session_shutdown", () => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  });

  pi.registerCommand("selfprompt", {
    description: "Have the agent draft a detailed prompt for itself, optionally after a delay",
    handler: async (args, ctx) => {
      const { raw, delay, text, error } = parseSelfPromptArgs(args);
      if (error) {
        ctx.ui.notify(error, "warning");
        return;
      }

      const prompt = raw ? text.trim() : buildSelfPromptDraftingInstruction(text);

      if (raw && !prompt) {
        ctx.ui.notify(
          "Usage: /selfprompt [--delay 30s] <goal> or /selfprompt --raw [--delay 30s] <exact message>",
          "warning",
        );
        return;
      }

      const scheduled = scheduleSelfPrompt(pi, ctx, prompt, delay, timers);
      if (scheduled.delayed) {
        const suffix = scheduled.delayAfterIdle ? " after the agent is idle" : "";
        ctx.ui.notify(`Self-prompt scheduled in ${formatDelay(delay)}${suffix}.`, "info");
      }
    },
  });

  pi.registerTool({
    name: "self_prompt",
    label: "Self Prompt",
    description:
      "Queue a new extension-originated user message for yourself, optionally after a delay. Use to re-enter the agent loop with a clearer instruction, recover from confusing state, or continue with a better-framed prompt.",
    promptSnippet:
      "Queue a new self-prompt turn when a fresh user-message turn would materially improve control flow or task framing.",
    promptGuidelines: [
      "Use self_prompt sparingly when a new extension-originated user message would materially improve control flow, task framing, or recovery from confusing tool/context state.",
      "Use self_prompt delay only for one-shot timed follow-ups like status checks; chain another delayed self_prompt from that follow-up if another check is truly needed.",
      "Do not use self_prompt to fabricate, assume, or obtain facts only the human knows; ask the user normally and wait when human input is required.",
      "The self_prompt prompt must be an instruction to yourself, not a pretend answer from the user.",
    ],
    parameters: SelfPromptParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const prompt = params.prompt.trim();
      const delay = params.delay === undefined ? 0 : Number(params.delay);

      if (!prompt) {
        return {
          content: [{ type: "text", text: "No self-prompt was queued because prompt was empty." }],
          details: { queued: false, reason: params.reason },
        };
      }

      if (!Number.isFinite(delay) || delay < 0 || delay > MAX_DELAY_SECONDS) {
        return {
          content: [
            {
              type: "text",
              text: "No self-prompt was queued because delay must be between 0 and 86400 seconds.",
            },
          ],
          details: { queued: false, reason: params.reason, delay: params.delay },
        };
      }

      const scheduled = scheduleSelfPrompt(pi, ctx, prompt, delay, timers);

      return {
        content: [
          {
            type: "text",
            text: scheduled.delayed
              ? `Scheduled a self-prompt in ${formatDelay(delay)}${scheduled.delayAfterIdle ? " after the agent is idle" : ""}. Reason: ${params.reason}`
              : `Queued a follow-up self-prompt. Reason: ${params.reason}`,
          },
        ],
        details: { queued: true, ...scheduled, delay, reason: params.reason, prompt },
        terminate: !scheduled.delayed,
      };
    },
  });
}
