// AskPrompter: a thin abstraction the TUI satisfies. The ask_user tool
// uses it to surface multi-choice questions to the human running the
// session.

export interface Option {
  /** Primary text shown in the menu (also the value returned on select). */
  label: string;
  /** Secondary one-line detail (endpoint, scheme, …). */
  description?: string;
  /**
   * Section heading. When consecutive options share a group, the modal
   * renders the heading once above that block (e.g. "Local", "Hosted").
   */
  group?: string;
  /** Compact tag rendered right-aligned or dim after the label (Local / Cloud). */
  badge?: string;
  /**
   * Non-selectable row (section dividers, hints). Navigation skips these;
   * never returned as a pick value.
   */
  disabled?: boolean;
}

export interface Question {
  /** Small uppercase chrome above the title (e.g. "PROVIDER"). */
  header?: string;
  /** Primary prompt line. */
  question: string;
  /** Optional subtitle under the title (active backend, path, …). */
  subtitle?: string;
  options: Option[];
  /** Override the default footer keybinding hint. */
  footer?: string;
}

export interface AskPrompter {
  /**
   * Show the question to the user and resolve with the label of the
   * chosen option. Rejects when the user cancels (Esc) or when the
   * provided signal aborts.
   */
  ask(q: Question, signal?: AbortSignal): Promise<string>;
}

/** Hermetic ask prompter for tests: always picks the first option. */
export class FirstOptionPrompter implements AskPrompter {
  async ask(q: Question): Promise<string> {
    const first = q.options[0];
    if (!first) throw new Error('ask: no options');
    return first.label;
  }
}
