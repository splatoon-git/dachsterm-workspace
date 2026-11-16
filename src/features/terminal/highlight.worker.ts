/// <reference lib="webworker" />
// Runs rule expressions away from the page, so a runaway expression stops this worker and not the
// app. The page ends the worker when a batch takes too long (`highlightWorker.ts`).
import { matchLines, type MatchRequest, type WorkerReply } from './highlightMatch';

const scope = self as unknown as DedicatedWorkerGlobalScope;
const reply = (message: WorkerReply) => scope.postMessage(message);

scope.onmessage = (event: MessageEvent<MatchRequest>) => {
  const { id, rules, lines } = event.data;
  const matches = matchLines(rules, lines, (rule) => reply({ type: 'rule', id, rule: rule.id }));
  reply({ type: 'done', id, matches });
};
