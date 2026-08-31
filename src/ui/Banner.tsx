// Banner: PF logo, connection metadata, and helpers.

export const PF_MINI_LOGO = ['█▀█', '█▀▀', '▀  '];
export const PF_MINI_LOGO_WIDTH = 3;

export type ToolSupportPill = 'yes' | 'no' | 'unknown' | 'probing';

export interface BannerData {
  version?: string;
  provider: string;
  model: string;
  endpoint?: string;
  state?: string;
  status?: string;
  cwd: string;
  toolSupport?: ToolSupportPill;
  contextWindow?: number;
}

export function modelPill(t?: ToolSupportPill): { text: string; color: string } | null {
  switch (t) {
    case 'yes':
      return { text: 'tools ✓', color: 'green' };
    case 'no':
      return { text: 'NO TOOLS', color: 'red' };
    case 'probing':
      return { text: 'probing…', color: 'yellow' };
    case 'unknown':
      return { text: 'tools ?', color: 'gray' };
    default:
      return null;
  }
}

export function compactPath(path: string, maxLen: number): string {
  if (path.length <= maxLen) return path;
  const parts = path.split('/');
  if (parts.length <= 1) return path.slice(-maxLen);
  let result = '';
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    const sep = i === parts.length - 1 ? '' : '/';
    const candidate = part + sep + result;
    if (candidate.length > maxLen) {
      if (i === 0) return `…/${result}`;
      return `…/${result ? result : part}`;
    }
    result = candidate;
  }
  return result;
}

export function ellipsize(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value;
  if (maxLen <= 1) return '…';
  return `${value.slice(0, maxLen - 1)}…`;
}

export function packMetaLine(opts: {
  provider: string;
  ctx?: string;
  pill?: string;
  budget: number;
}): string {
  return ellipsize(
    [opts.provider, opts.ctx, opts.pill]
      .filter((part): part is string => Boolean(part))
      .join(' · '),
    opts.budget,
  );
}
