/** Examples the user copies to a server. Fixed JSON, so the hook needs no tool such as `jq`. */
const events: { event: string; state: string; matcher?: string }[] = [
  { event: 'UserPromptSubmit', state: 'working' },
  // Moves the tab off "waiting" once a request the user answered has run.
  { event: 'PostToolUse', state: 'working' },
  { event: 'PermissionRequest', state: 'blocked' },
  // A question needs an answer, and no other event is documented to report it.
  { event: 'PreToolUse', state: 'blocked', matcher: 'AskUserQuestion' },
  // Not every notification: `idle_prompt` fires 60 seconds after any finished answer.
  {
    event: 'Notification',
    state: 'blocked',
    matcher: 'permission_prompt|elicitation_dialog|elicitation_url_dialog',
  },
  { event: 'Stop', state: 'done' },
  { event: 'StopFailure', state: 'error' },
];

const hookCommand = (state: string) => {
  const output = JSON.stringify({ terminalSequence: `\x1b]777;DachsTerm;status;${state}\x07` });
  return `printf '%s' '${output}'`;
};

export const agentHookExample = JSON.stringify(
  {
    hooks: Object.fromEntries(
      events.map(({ event, state, matcher }) => [
        event,
        [
          {
            ...(matcher && { matcher }),
            hooks: [{ type: 'command', command: hookCommand(state) }],
          },
        ],
      ]),
    ),
  },
  null,
  2,
);

export const tmuxSettingsExample = [
  'set -g allow-passthrough on',
  'set -g focus-events on',
  'set -g mouse on',
  'set -s extended-keys on',
  "set -as terminal-features 'xterm*:extkeys'",
].join('\n');
