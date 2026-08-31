// Prompt text builders for the plan-only turns (/plan, /next). Pure string
// construction — no agent/dispatch dependency — so they're usable directly
// from agentTurns.ts without needing a SlashContext.

export function buildPlanPrompt(objective: string): string {
  const subject = objective
    ? `Plan this objective:\n\n${objective}`
    : 'Create a plan for the current objective using the existing conversation context.';
  return `${subject}

You are in plan-only mode for this turn.

Rules:
- Do not call tools, run commands, fetch URLs, scan targets, or modify files.
- Reason from the conversation context and the user's objective only.
- If important product, scope, safety, or implementation details are missing, ask concise clarifying questions instead of inventing details.
- If the intent is clear enough, produce a decision-complete implementation plan that another engineer or agent can execute without making major choices.
- Keep the plan concise and practical.

When you are ready to finalize, return the plan wrapped exactly in:
<proposed_plan>
...
</proposed_plan>

Use Markdown inside the block. Prefer these sections: Summary, Key Changes, Test Plan, Assumptions.`;
}

export function buildCoverageNextPrompt(objective: string, coverageContext: string): string {
  const subject = objective
    ? `Objective for next steps:\n\n${objective}`
    : 'Objective for next steps: choose the highest-value tests to run next from the current engagement context.';
  return `${subject}

You are in coverage-driven planning mode for this turn.

Coverage state:
${coverageContext}

Rules:
- Do not call tools, run commands, fetch URLs, scan targets, or modify files.
- Use the coverage state before suggesting any test.
- Prioritize endpoint/parameter/vulnerability-class combinations that are not already covered.
- Treat passed, failed, skipped, waf-blocked, and tried entries as already covered unless retesting is explicitly justified.
- If there are no candidates in coverage, tell the user what candidate inventory is missing and how to collect it.
- Output 5 to 10 concrete next tests with endpoint, parameter, vuln class, why it is next, and the exact coverage mark to record after testing.
- Keep it concise and actionable.`;
}
