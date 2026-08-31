// update_user_profile tool. Lets the agent autonomously save a durable note
// about the OPERATOR — a communication-style signal, a standing preference,
// an expectation — into ~/.pentesterflow/USER.md, alongside the explicit
// /user add path a human can also use. Distinct from confirm_finding /
// coverage: this writes through a callback (not a store directly) because
// the write must also refresh the live system prompt (Agent.addUserProfileNote
// owns that orchestration) — a plain file write here would go stale until
// some unrelated action happened to trigger a prompt rebuild.

import type { Prompter } from '../permission/permission.js';
import { type Tool, argString } from './types.js';

export type UserProfileNoteHandler = (text: string) => Promise<void>;

export class UpdateUserProfileTool implements Tool {
  private readonly onNote: UserProfileNoteHandler;

  constructor(onNote: UserProfileNoteHandler) {
    this.onNote = onNote;
  }

  name(): string {
    return 'update_user_profile';
  }

  description(): string {
    return [
      "Save one durable note about the OPERATOR (not the target) into their persistent profile — a communication-style preference, a standing expectation, a recurring habit you've noticed across the conversation.",
      '',
      'Call this rarely and only for genuinely durable signals ("prefers terse output", "always wants a curl repro attached", "works mostly on GraphQL APIs") — never for one-off task details, target/finding facts (those belong in confirm_finding or /memory), or anything said only once in passing. When in doubt, do not call it.',
    ].join('\n');
  }

  schema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        note: {
          type: 'string',
          description: 'One concise, durable sentence about the operator.',
        },
      },
      required: ['note'],
    };
  }

  /** No permission gate — same rationale as confirm_finding: appending a
   *  short line to a local markdown file is benign, and gating every learned
   *  nuance behind a prompt would defeat the point of autonomous operation.
   *  The write is still visible: it shows up as a normal tool call in the
   *  transcript, same as every other tool. */
  requiresPermission(): boolean {
    return false;
  }

  summarize(args: Record<string, unknown>): { summary: string; detail: string } {
    const note = argString(args, 'note');
    return { summary: `user profile: ${note}`, detail: JSON.stringify(args, null, 2) };
  }

  async run(args: Record<string, unknown>, _signal: AbortSignal, _p: Prompter): Promise<string> {
    const note = argString(args, 'note').trim();
    if (!note) throw new Error('note is required');
    await this.onNote(note);
    return `Saved to user profile: ${note}`;
  }
}
