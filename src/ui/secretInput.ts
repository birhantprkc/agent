// Secret-input modal request shape (API keys, tokens).
// Rendering lives in src/ui-opentui/SecretInputModal.tsx.

export interface SecretInputRequest {
  header: string;
  question: string;
  subtitle?: string;
  placeholder?: string;
  footer?: string;
  resolve: (value: string) => void;
  reject: (err: Error) => void;
}
