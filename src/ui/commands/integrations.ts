// /snapshot, /burp, /report, /update — commands that talk to something
// outside the chat loop (disk snapshot, the Burp bridge, the findings
// report generator, the GitHub release updater).

import { runSelfUpdate } from '../../update/selfUpdate.js';
import type { SlashContext } from './context.js';

export function handleSnapshot(ctx: SlashContext): void {
  const { agent, dispatch } = ctx;
  void agent
    .saveContextSnapshot('manual /snapshot')
    .then((path) =>
      dispatch({
        type: 'append',
        entry: {
          kind: 'system',
          text: path ? `context snapshot saved: ${path}` : 'no session store configured',
        },
      }),
    )
    .catch((err: unknown) =>
      dispatch({
        type: 'append',
        entry: { kind: 'error', text: `/snapshot: ${(err as Error).message}` },
      }),
    );
}

export function handleBurp(ctx: SlashContext): void {
  const { rest, dispatch, startBurpBridge } = ctx;
  if (!startBurpBridge) {
    dispatch({
      type: 'append',
      entry: { kind: 'error', text: '/burp is unavailable in this runtime.' },
    });
    return;
  }
  const portRaw = rest[0] ?? '';
  const port = portRaw ? Number.parseInt(portRaw, 10) : undefined;
  if (portRaw && (!Number.isFinite(port) || !port || port < 1 || port > 65535)) {
    dispatch({ type: 'append', entry: { kind: 'error', text: 'usage: /burp [port]' } });
    return;
  }
  void startBurpBridge(port)
    .then((result) =>
      dispatch({
        type: 'append',
        entry: {
          kind: 'system',
          text: result.alreadyRunning
            ? `Burp bridge already listening at ${result.url}\nToken: ${result.token}`
            : `Burp bridge listening at ${result.url}\nToken: ${result.token}`,
        },
      }),
    )
    .catch((err: unknown) =>
      dispatch({
        type: 'append',
        entry: { kind: 'error', text: `/burp: ${(err as Error).message}` },
      }),
    );
}

export function handleReport(ctx: SlashContext): void {
  const { rest, dispatch, generateFindingsReport } = ctx;
  if (!generateFindingsReport) {
    dispatch({
      type: 'append',
      entry: { kind: 'error', text: '/report is unavailable in this runtime.' },
    });
    return;
  }
  const fmtArg = (rest[0] ?? 'markdown').toLowerCase();
  if (fmtArg !== 'markdown' && fmtArg !== 'sarif') {
    dispatch({ type: 'append', entry: { kind: 'error', text: 'usage: /report [markdown|sarif]' } });
    return;
  }
  void generateFindingsReport(fmtArg)
    .then((result) =>
      dispatch({
        type: 'append',
        entry: {
          kind: 'system',
          text:
            result.count === 0
              ? `No findings recorded yet — empty report written to ${result.path}.`
              : `${result.count} finding${result.count === 1 ? '' : 's'} exported to ${result.path}`,
        },
      }),
    )
    .catch((err: unknown) =>
      dispatch({
        type: 'append',
        entry: { kind: 'error', text: `/report: ${(err as Error).message}` },
      }),
    );
}

export function handleUpdate(ctx: SlashContext): void {
  const { rest, dispatch } = ctx;
  const version = rest.join(' ').trim() || 'latest';
  dispatch({
    type: 'append',
    entry: { kind: 'system', text: `checking GitHub release updates (${version})…` },
  });
  void runSelfUpdate(version)
    .then((result) => {
      dispatch({
        type: 'append',
        entry: {
          kind: 'system',
          text:
            `update installed (${result.version})` +
            `${result.installDir ? ` → ${result.installDir}` : ''}` +
            `${result.output ? `\n${result.output}` : ''}`,
        },
      });
    })
    .catch((err: unknown) => {
      dispatch({
        type: 'append',
        entry: { kind: 'error', text: `/update: ${(err as Error).message}` },
      });
    });
}

/** `/jobs` — list background shell jobs for the operator (not just the model). */
export function handleJobs(ctx: SlashContext): void {
  const text = ctx.listJobs?.() ?? 'background jobs are not available in this runtime.';
  ctx.dispatch({ type: 'append', entry: { kind: 'system', text } });
}
