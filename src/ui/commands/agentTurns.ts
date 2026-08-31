// /compact, /next, /plan — turns that run the agent loop itself (as
// opposed to the other command groups, which just read/mutate state and
// print a system message).

import type { SlashContext } from './context.js';
import { buildCoverageNextPrompt, buildPlanPrompt } from './prompts.js';

export function handleCompact(ctx: SlashContext): void {
  if (ctx.agent.isRunning()) {
    ctx.dispatch({
      type: 'append',
      entry: { kind: 'error', text: 'compact: a turn is already running' },
    });
    return;
  }
  ctx.runAgentCompact();
}

export function handleNext(ctx: SlashContext): void {
  if (ctx.agent.isRunning()) {
    ctx.dispatch({
      type: 'append',
      entry: { kind: 'error', text: 'next: a turn is already running' },
    });
    return;
  }
  const objective = ctx.rest.join(' ').trim();
  void ctx.agent
    .coverageContext(new AbortController().signal)
    .then((coverageContext) =>
      ctx.runAgentTurn(buildCoverageNextPrompt(objective, coverageContext), {
        transcriptUserText: objective ? `/next ${objective}` : '/next',
        systemText: 'coverage-driven next steps — tools disabled',
        // coverageContext folds in model-authored coverage notes, not literal
        // keyboard input — an @-token planted there via indirect prompt
        // injection must not get silently expanded into local file contents.
        runOptions: { tools: false, expandMentions: false },
      }),
    )
    .catch((err: unknown) =>
      ctx.dispatch({
        type: 'append',
        entry: { kind: 'error', text: `/next: ${(err as Error).message}` },
      }),
    );
}

export function handlePlan(ctx: SlashContext): void {
  const objective = ctx.rest.join(' ').trim();
  const prompt = buildPlanPrompt(objective);
  ctx.runAgentTurn(prompt, {
    transcriptUserText: objective ? `/plan ${objective}` : '/plan',
    systemText: 'planning only — tools disabled',
    runOptions: { tools: false },
  });
}
