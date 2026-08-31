/** @jsxImportSource @opentui/react */
// OpenTUI App — full-width chat (ChatPane) + input/menus/statusbar/modals.
// Bounded app-owned scroll; no left sidebar.
//
// This REVERSES the earlier native-terminal-scrollback design
// (writeToScrollback/createScrollbackSurface, now deleted along with
// transcriptScrollback.ts): real OS scrollback is one linear stream and
// can't coexist with a persistent side column once content has scrolled
// past it, so ChatPane owns its own bounded viewport + scroll offset
// instead. See ChatPane.tsx's header comment for the height-measurement
// approach (explicit, computed here — NOT read back from a ref, that
// doesn't converge reliably, confirmed by instrumenting it).
//
// Key-handling: Ink's single useInput(input, key) callback is split into
// useKeyboard (keypresses; e.name is a lowercase string for both named
// keys and plain chars, e.sequence holds the raw typed text) and usePaste
// (real bracketed-paste events — event.bytes, not a heuristic on chunked
// input like Ink's looksLikePaste). See PermissionModal.tsx/SecretInputModal.tsx
// for the same split established in Phase 3. pageup/pagedown/home/end AND
// mouse wheel (ChatPane onMouseScroll) page the app-owned chat viewport.
// Mouse DRAG selection is wired via useSelectionHandler — the renderer's
// useMouse:true (cli/index.ts) hands mouse events to the app, and selected
// text is copied to the clipboard via OSC 52 rather than relying on the
// terminal's own native selection-copy (OSC 52 also works over SSH/tmux,
// which matters for a pentesting CLI routinely run on a remote engagement
// box).
//
// clearScreen: now a no-op, kept only so handleSlash's shared `() => void`
// signature still has something to call. The whole screen is a normal
// reconciled tree repainted every frame now (alternate-screen, not
// split-footer), so dispatch({type:'clear'}) alone — which already empties
// state.transcript — is visually sufficient; there's no committed
// scrollback content left over to erase the way the split-footer design
// needed `renderer.resetSplitFooterForReplay` for.
//
// Exit: Ink's useApp().exit() is replaced by an `onExit` prop the CLI
// wires to renderer.destroy() (see FirstRunPicker.tsx's Phase 3 port for
// the same pattern at smaller scale, and cli/index.ts for the mount side).

import {
  useKeyboard,
  usePaste,
  useRenderer,
  useSelectionHandler,
  useTerminalDimensions,
} from '@opentui/react';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { AgentRunOptions } from '../agent/agent.js';
import { type AgentEvent, MaxStepsError } from '../agent/events.js';
import { findActiveMention, listMentionDir, parseMentionPath } from '../agent/mentions.js';
import { formatUserError } from '../llm/errors.js';
import type { BannerData } from '../ui/Banner.js';
import type { AppProps } from '../ui/appTypes.js';
import {
  copyText,
  decodePasteEvent,
  lastCopyableOutput,
  readSystemClipboard,
} from '../ui/clipboard.js';
import { handleSlash } from '../ui/commands/index.js';
import { filterSlash } from '../ui/slashItems.js';
import type { TranscriptEntry, TranscriptFilter } from '../ui/state.js';
import { initialState, reducer } from '../ui/state.js';
import { usePing } from '../ui/usePing.js';
import {
  expandPastedTextMarkers,
  normalizePastedText,
  pastedTextMarker,
  shouldCollapsePaste,
  useTextField,
} from '../ui/useTextField.js';
import { AskModal } from './AskModal.js';
import { ChatPane } from './ChatPane.js';
import { Input } from './Input.js';
import { MentionMenu } from './MentionMenu.js';
import { PermissionModal, computePermissionBudget } from './PermissionModal.js';
import { SecretInputModal, type SecretInputRequest } from './SecretInputModal.js';
import { SkillsModal } from './SkillsModal.js';
import { SlashMenu } from './SlashMenu.js';
import { StatusBar } from './StatusBar.js';

export type { AppProps, ApplyProvider, PersistDisabledSkills } from '../ui/appTypes.js';

const MENTION_LIMIT = 12;
const CONTEXT_SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;
// Chat-pane height reservation is an approximation, not a pixel-perfect
// measurement (same "explicit, don't chase auto-measure timing" reasoning
// as ChatPane.tsx). Branch by what's actually mounted so the idle prompt
// doesn't permanently burn ~18 rows of empty chat space:
// Quiet layout: no idle keybinding hint row under the input.
//   idle  — rounded input + status ≈ 5
//   menu  — + slash/@ picker ≈ 6 more
//   modal — permission/ask/skills/secret (detail height-capped)
const FOOTER_IDLE = 5;
const FOOTER_WITH_MENU = 11;
/** Base chrome for skills/ask/secret modals (no huge shell body). */
const FOOTER_MODAL = 14;
const CHAT_MIN_HEIGHT = 3;

export function App({
  agent,
  bannerData,
  parentSignal,
  bindPermPublisher,
  bindAskPublisher,
  yoloInitial,
  readConfig,
  applyProvider,
  setYolo,
  setPermissionMode,
  bindBannerPublisher,
  persistDisabledSkills,
  sessionDebug,
  onSkillCreated,
  bindNoticePublisher,
  startBurpBridge,
  generateFindingsReport,
  listJobs,
  resumeSummary,
  onExit,
}: AppProps) {
  if (!onExit) throw new Error('OpenTUI App requires onExit from the CLI mount');
  const renderer = useRenderer();
  const [state, dispatch] = useReducer(reducer, '', () => {
    const s = initialState('', bannerData);
    if (yoloInitial) s.yolo = true;
    return s;
  });
  const input = useTextField('');
  const inputValue = input.value;
  const [slashIdx, setSlashIdx] = useState(0);
  const [mentionIdx, setMentionIdx] = useState(0);
  const [secretInput, setSecretInput] = useState<SecretInputRequest | null>(null);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [unseenBelow, setUnseenBelow] = useState(false);
  const prevTranscriptLen = useRef(0);
  const runCtl = useRef<AbortController | null>(null);
  const snapshotSaving = useRef(false);
  const resumeSummaryShown = useRef(false);
  const pendingTurns = useRef<Array<{ agentValue: string; display: string; shown: boolean }>>([]);
  const [queueLen, setQueueLen] = useState(0);
  const [inputEpoch, setInputEpoch] = useState(0);
  const runAgentTurnRef = useRef<
    (
      value: string,
      opts?: { transcriptUserText?: string; systemText?: string; runOptions?: AgentRunOptions },
    ) => void
  >(() => {});

  // No-op — see the file header comment for why the split-footer-era
  // renderer.resetSplitFooterForReplay() call is no longer needed.
  const clearScreen = useCallback(() => {}, []);

  useEffect(() => {
    if (resumeSummaryShown.current || !resumeSummary) return;
    resumeSummaryShown.current = true;
    dispatch({ type: 'append', entry: { kind: 'system', text: resumeSummary } });
  }, [resumeSummary]);

  const applyYolo = useCallback(
    (on: boolean) => {
      setYolo?.(on);
      setPermissionMode?.(on ? 'yolo' : 'ask');
      dispatch({ type: 'set-yolo', on });
    },
    [setYolo, setPermissionMode],
  );

  const applyPermissionModeCb = useCallback(
    (mode: 'ask' | 'auto-safe' | 'yolo') => {
      setPermissionMode?.(mode);
      setYolo?.(mode === 'yolo');
      dispatch({ type: 'set-yolo', on: mode === 'yolo' });
    },
    [setPermissionMode, setYolo],
  );

  const applyCompactMode = useCallback((on: boolean) => {
    dispatch({ type: 'set-compact-mode', on });
  }, []);

  const promptSecret = useCallback((inputReq: Omit<SecretInputRequest, 'resolve' | 'reject'>) => {
    return new Promise<string>((resolve, reject) => {
      setSecretInput({
        ...inputReq,
        resolve: (value) => {
          setSecretInput(null);
          resolve(value);
        },
        reject: (err) => {
          setSecretInput(null);
          reject(err);
        },
      });
    });
  }, []);

  const historyRef = useRef<string[]>([]);
  const historyDraft = useRef<string>('');
  const [historyIdx, setHistoryIdx] = useState<number | null>(null);
  const HISTORY_CAP = 500;
  const pastedTextRef = useRef<Map<number, string>>(new Map());
  const pastedTextSeq = useRef(0);

  const isMaxStepsError = useCallback((err: Error): err is MaxStepsError => {
    return err instanceof MaxStepsError || err.name === 'MaxStepsError';
  }, []);

  const runAgentTurn = useCallback(
    (
      value: string,
      opts?: { transcriptUserText?: string; systemText?: string; runOptions?: AgentRunOptions },
    ) => {
      if (agent.isRunning()) {
        const display = opts?.transcriptUserText ?? value;
        pendingTurns.current.push({ agentValue: value, display, shown: true });
        setQueueLen(pendingTurns.current.length);
        if (display) {
          dispatch({ type: 'append', entry: { kind: 'user', text: display } });
        }
        setInputEpoch((n) => n + 1);
        return;
      }
      sessionDebug?.write('turn_start', {
        prompt: value,
        transcript_user_text: opts?.transcriptUserText,
        system_text: opts?.systemText,
      });
      if (opts?.transcriptUserText) {
        dispatch({ type: 'append', entry: { kind: 'user', text: opts.transcriptUserText } });
      }
      if (opts?.systemText) {
        dispatch({ type: 'append', entry: { kind: 'system', text: opts.systemText } });
      }

      dispatch({ type: 'set-busy', busy: true });
      const ctl = new AbortController();
      runCtl.current = ctl;
      // Claude Code / Grok style: hit the per-turn tool budget → quiet
      // auto-continue another turn. No "Max steps" modal / stop prompt.
      let autoContinue = false;

      const handleEvent = (ev: AgentEvent) => {
        sessionDebug?.agentEvent(ev);
        if (ev.type === 'error' && isMaxStepsError(ev.err)) {
          if (!ctl.signal.aborted) {
            autoContinue = true;
            dispatch({
              type: 'append',
              entry: { kind: 'system', text: 'Continuing…' },
            });
          }
          return;
        }
        dispatch({ type: 'agent-event', event: ev });
      };

      const drainQueue = () => {
        const next = pendingTurns.current.shift();
        setQueueLen(pendingTurns.current.length);
        if (!next) return;
        setTimeout(() => {
          runAgentTurnRef.current(
            next.agentValue,
            next.shown ? undefined : { transcriptUserText: next.display },
          );
        }, 0);
      };

      void agent
        .run(value, ctl.signal, handleEvent, opts?.runOptions)
        .catch((err: unknown) => {
          sessionDebug?.write('run_error', {
            err:
              err instanceof Error
                ? { name: err.name, message: err.message, stack: err.stack }
                : String(err),
          });
          dispatch({
            type: 'append',
            entry: { kind: 'error', text: formatUserError(err) },
          });
        })
        .finally(() => {
          if (autoContinue && !ctl.signal.aborted) {
            setTimeout(() => {
              runAgentTurnRef.current(
                'Continue from where you stopped and finish the current task.',
              );
            }, 0);
            return;
          }
          drainQueue();
        });
    },
    [agent, isMaxStepsError, sessionDebug],
  );

  runAgentTurnRef.current = runAgentTurn;

  const runAgentCompact = useCallback(() => {
    sessionDebug?.write('compact_start');
    dispatch({ type: 'set-busy', busy: true });
    const ctl = new AbortController();
    runCtl.current = ctl;
    void agent
      .compact(ctl.signal, (event) => {
        sessionDebug?.agentEvent(event);
        dispatch({ type: 'agent-event', event });
      })
      .catch((err: unknown) => {
        sessionDebug?.write('compact_error', {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message, stack: err.stack }
              : String(err),
        });
        dispatch({
          type: 'append',
          entry: { kind: 'error', text: `compact: ${formatUserError(err)}` },
        });
      });
  }, [agent, sessionDebug]);

  useEffect(() => {
    bindPermPublisher?.((req) => dispatch({ type: 'set-perm', req }));
    bindAskPublisher?.((req) => dispatch({ type: 'set-ask', req }));
    bindBannerPublisher?.((patch) => dispatch({ type: 'merge-banner-data', patch }));
    bindNoticePublisher?.((notice) => {
      if (typeof notice === 'string') {
        dispatch({ type: 'append', entry: { kind: 'system', text: notice } });
        return;
      }
      if (notice.type === 'child-progress') {
        dispatch({
          type: 'child-progress',
          key: notice.key,
          label: notice.label,
          tools: notice.tools,
          done: notice.done,
        });
      }
    });
  }, [bindPermPublisher, bindAskPublisher, bindBannerPublisher, bindNoticePublisher]);

  useEffect(() => {
    const saveSnapshot = () => {
      if (agent.isRunning()) return;
      if (snapshotSaving.current) return;
      snapshotSaving.current = true;
      void agent
        .saveContextSnapshot('periodic 5 minute snapshot')
        .then((path) => {
          if (path) sessionDebug?.write('context_snapshot', { path });
        })
        .catch((err: unknown) => {
          sessionDebug?.write('context_snapshot_error', {
            err: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          snapshotSaving.current = false;
        });
    };
    saveSnapshot();
    const timer = setInterval(saveSnapshot, CONTEXT_SNAPSHOT_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [agent, sessionDebug]);

  const { width: cols, height: rows } = useTerminalDimensions();

  // Live banner: OpenTUI repaints every frame, so surface tool-support /
  // context-window patches from bindBannerPublisher instead of freezing a
  // mount-time snapshot (Ink's <Static> needed the freeze; we don't).
  const liveBanner: BannerData = state.bannerData;

  const clientGetter = useCallback(() => agent.client, [agent]);
  const setReady = useCallback((ok: boolean) => dispatch({ type: 'set-api-ready', ready: ok }), []);
  usePing(clientGetter, setReady);

  useEffect(() => {
    const onAbort = () => {
      runCtl.current?.abort();
      onExit();
    };
    if (parentSignal.aborted) onAbort();
    else parentSignal.addEventListener('abort', onAbort, { once: true });
    return () => parentSignal.removeEventListener('abort', onAbort);
  }, [parentSignal, onExit]);

  const skillSlashItems = inputValue.startsWith('/')
    ? agent.skills.listEnabled().map((s) => ({
        name: `/${s.name}`,
        description: `[skill] ${s.description.slice(0, 70)}${s.description.length > 70 ? '…' : ''}`,
      }))
    : [];
  const slashMatches = filterSlash(inputValue, skillSlashItems);

  const mentionCtx = useMemo(() => findActiveMention(inputValue), [inputValue]);
  const mentionDirBase = useMemo(
    () => (mentionCtx ? parseMentionPath(mentionCtx.partial) : null),
    [mentionCtx],
  );
  const mentionMatches = useMemo(
    () =>
      mentionDirBase ? listMentionDir(mentionDirBase.dir, mentionDirBase.base, MENTION_LIMIT) : [],
    [mentionDirBase],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: inputValue is a deliberate proxy trigger — see ../ui/App.tsx's identical comment.
  useEffect(() => {
    if (slashMatches.length > 0) setSlashIdx(0);
  }, [inputValue]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: same proxy-trigger reasoning as above, for mentionMatches.
  useEffect(() => {
    if (mentionMatches.length > 0) setMentionIdx(0);
  }, [inputValue]);

  const submit = useCallback(
    (value: string) => {
      const agentValue = expandPastedTextMarkers(value, pastedTextRef.current);
      const recorded = value.trim();
      if (recorded.length > 0) {
        const h = historyRef.current;
        if (h[h.length - 1] !== recorded) {
          h.push(recorded);
          if (h.length > HISTORY_CAP) h.shift();
        }
      }
      setHistoryIdx(null);
      historyDraft.current = '';

      if (agentValue.startsWith('#')) {
        const personal = agentValue.startsWith('#!');
        const text = agentValue.slice(personal ? 2 : 1).trim();
        if (!text) {
          dispatch({
            type: 'append',
            entry: {
              kind: 'system',
              text: 'usage: #<text to remember>  (or #!<text> for personal)',
            },
          });
          return;
        }
        void agent
          .addMemory({ text, scope: personal ? 'personal' : 'project' })
          .then((fact) =>
            dispatch({
              type: 'append',
              entry: fact
                ? { kind: 'system', text: `remembered (${fact.scope}/${fact.type}): ${fact.name}` }
                : { kind: 'error', text: 'memory not saved (empty after redaction or no store)' },
            }),
          )
          .catch((err: unknown) =>
            dispatch({
              type: 'append',
              entry: { kind: 'error', text: `memory save failed: ${String(err)}` },
            }),
          );
        return;
      }

      if (agentValue.startsWith('/')) {
        const handled = handleSlash(
          agent,
          agentValue,
          dispatch,
          onExit,
          clearScreen,
          state.yolo,
          applyYolo,
          state.compactMode,
          applyCompactMode,
          readConfig,
          applyProvider,
          promptSecret,
          persistDisabledSkills,
          onSkillCreated,
          runAgentTurn,
          runAgentCompact,
          startBurpBridge,
          generateFindingsReport,
          applyPermissionModeCb,
          listJobs,
        );
        if (handled) return;
      }
      runAgentTurn(agentValue, { transcriptUserText: value });
    },
    [
      agent,
      onExit,
      clearScreen,
      state.yolo,
      applyYolo,
      applyPermissionModeCb,
      state.compactMode,
      applyCompactMode,
      readConfig,
      applyProvider,
      promptSecret,
      persistDisabledSkills,
      onSkillCreated,
      runAgentTurn,
      runAgentCompact,
      startBurpBridge,
      generateFindingsReport,
      listJobs,
    ],
  );

  // ---------- dashboard layout math ----------
  // Explicit heights that always sum to `rows` — never flex-guess. Permission
  // card especially: long shell payloads used to push the box below the last
  // terminal row; we pin an exact footer strip and clamp the command body.
  const chatWidth = Math.max(20, cols);
  // Mini PF monogram is 3 rows + margin; compact is one line.
  const bannerHeight = state.compactMode ? 2 : 4;
  const inputLines = Math.max(1, inputValue.split('\n').length);
  const extraInputLines = Math.max(0, inputLines - 1);
  const hasPerm = Boolean(state.pendingPerm);
  const hasModal = Boolean(
    secretInput || state.pendingPerm || state.pendingAsk || state.pendingSkills,
  );
  const hasMenu = !hasModal && (mentionMatches.length > 0 || slashMatches.length > 0);
  const permLayout = hasPerm
    ? computePermissionBudget({
        terminalRows: rows,
        bannerHeight,
        chatMinHeight: CHAT_MIN_HEIGHT,
      })
    : null;
  const permDetailLines = permLayout?.maxDetailLines ?? 0;
  // Cap every footer variant so banner + chat min + footer never exceeds
  // the terminal (short windows used to over-allocate FOOTER_MODAL=14).
  const footerCeiling = Math.max(0, rows - bannerHeight - CHAT_MIN_HEIGHT);
  const footerRaw = hasPerm
    ? (permLayout?.footerHeight ?? FOOTER_MODAL)
    : hasModal
      ? FOOTER_MODAL
      : hasMenu
        ? FOOTER_WITH_MENU
        : FOOTER_IDLE + extraInputLines;
  const footerReserved = Math.min(footerRaw, footerCeiling);
  // Scroll region BELOW the banner. ChatPane outer height is forced to
  // (this + bannerHeight) so Chat + footer always fill exactly `rows`.
  const chatPaneHeight = Math.max(CHAT_MIN_HEIGHT, rows - bannerHeight - footerReserved);

  // Stick-to-bottom + unseen-below cue. scrollOffset === 0 means follow;
  // new content while scrolled up sets unseenBelow until End / scroll home.
  useEffect(() => {
    const len = state.transcript.length;
    if (len === 0) {
      setScrollOffset(0);
      setUnseenBelow(false);
      prevTranscriptLen.current = 0;
      return;
    }
    if (len > prevTranscriptLen.current && scrollOffset > 0) {
      setUnseenBelow(true);
    }
    if (scrollOffset === 0) setUnseenBelow(false);
    prevTranscriptLen.current = len;
  }, [state.transcript.length, scrollOffset]);

  // While scrolled up and the agent is working, surface the follow cue
  // even if transcript.length isn't growing (streaming deltas rewrite the
  // tail entry in place).
  useEffect(() => {
    if (scrollOffset > 0 && state.busy) setUnseenBelow(true);
  }, [state.busy, scrollOffset]);

  const scrollBy = useCallback((delta: number) => {
    setScrollOffset((o) => {
      const next = Math.max(0, o + delta);
      if (next === 0) setUnseenBelow(false);
      return next;
    });
  }, []);

  /** Last mouse-selected text (macOS Terminal has no native select under mouse mode). */
  const lastSelectionRef = useRef<string>('');

  /** Insert paste into the prompt (collapse multi-line to a marker). */
  const insertPastedText = useCallback(
    (raw: string) => {
      const pasted = normalizePastedText(raw);
      if (!pasted) return;
      if (shouldCollapsePaste(pasted)) {
        pastedTextSeq.current += 1;
        const id = pastedTextSeq.current;
        pastedTextRef.current.set(id, pasted);
        input.insertText(pastedTextMarker(id, pasted));
        return;
      }
      input.insertText(pasted);
    },
    [input],
  );

  const copyToClipboard = useCallback(
    (text: string, notice?: string) => {
      void copyText(text, renderer).then((ok) => {
        if (!notice) return;
        dispatch({
          type: 'append',
          entry: {
            kind: 'system',
            text: ok ? notice : 'Copy failed — select text and use Ctrl+Y, or copy from the host',
          },
        });
      });
    },
    [renderer],
  );

  // Bracketed paste (what macOS Terminal / iTerm emit for Cmd+V).
  usePaste((event) => {
    if (secretInput || state.pendingPerm || state.pendingAsk || state.pendingSkills) return;
    const pasted = decodePasteEvent(event.bytes);
    if (pasted) insertPastedText(pasted);
  });

  // Mouse-drag selection → clipboard (pbcopy on macOS; OSC 52 is ignored by Terminal.app).
  useSelectionHandler((selection) => {
    if (selection.isDragging) return;
    const text = selection.getSelectedText();
    if (!text) return;
    lastSelectionRef.current = text;
    void copyText(text, renderer);
  });

  useKeyboard((e) => {
    // 0. Always-on: Ctrl-C kills the app; Esc cancels an in-flight run.
    //    Cmd+C (meta) is copy on macOS — handled below, not quit.
    if (e.ctrl && e.name === 'c' && !e.meta) {
      runCtl.current?.abort();
      onExit();
      return;
    }
    if (e.name === 'escape' && state.busy) {
      runCtl.current?.abort();
      return;
    }

    // 1. Modal overlays consume keys before us.
    if (secretInput || state.pendingPerm || state.pendingAsk || state.pendingSkills) return;

    // 2. Global chords (expand / copy / paste / filter).
    if (e.ctrl && e.name === 'o') {
      dispatch({ type: 'expand-tool-output' });
      return;
    }
    // Cmd+C / Ctrl+Y — copy selection or last tool/finding output.
    // (macOS Terminal: Cmd+C never reaches the app for native selections when
    // mouse tracking is on; we keep last drag-select in lastSelectionRef.)
    if ((e.meta && e.name === 'c') || (e.ctrl && e.name === 'y')) {
      const text = lastSelectionRef.current || lastCopyableOutput(state.transcript) || inputValue;
      if (text) {
        copyToClipboard(text, `Copied ${text.length} chars`);
      } else {
        dispatch({ type: 'append', entry: { kind: 'system', text: 'Nothing to copy yet' } });
      }
      return;
    }
    // Ctrl+V / Cmd+V — pbpaste when the terminal didn't inject bracketed paste.
    if ((e.ctrl || e.meta) && e.name === 'v') {
      void readSystemClipboard().then((clip) => {
        if (clip) insertPastedText(clip);
      });
      return;
    }
    if (e.ctrl && e.name === 'f') {
      dispatch({ type: 'cycle-transcript-filter' });
      return;
    }

    // 2b. Chat pane scroll — bounded app-owned viewport. Mouse wheel is
    //     handled on the root box + ChatPane via onMouseScroll.
    //     Home/End: line start/end when the draft is non-empty; chat
    //     history jumps only when the input is empty (Ctrl-A/E always
    //     do line edges). Page step accounts for the scroll-cue row.
    const pageStep = Math.max(3, chatPaneHeight - (scrollOffset > 0 ? 1 : 0));
    if (e.name === 'pageup') {
      scrollBy(pageStep);
      return;
    }
    if (e.name === 'pagedown') {
      scrollBy(-pageStep);
      return;
    }
    if (e.name === 'home') {
      if (inputValue.length > 0) {
        input.moveLineStart();
        return;
      }
      setScrollOffset(Number.MAX_SAFE_INTEGER); // ChatPane clamps to max.
      return;
    }
    if (e.name === 'end') {
      if (inputValue.length > 0) {
        input.moveLineEnd();
        return;
      }
      setScrollOffset(0);
      setUnseenBelow(false);
      return;
    }

    // 3. Active @file picker (takes priority over slash).
    if (mentionMatches.length > 0) {
      if (e.name === 'up') {
        setMentionIdx((i) => (i - 1 + mentionMatches.length) % mentionMatches.length);
        return;
      }
      if (e.name === 'down') {
        setMentionIdx((i) => (i + 1) % mentionMatches.length);
        return;
      }
      if (e.name === 'tab' || e.name === 'return') {
        const picked = mentionMatches[mentionIdx];
        if (picked && mentionCtx) {
          const head = inputValue.slice(0, mentionCtx.at);
          const suffix = picked.isDir ? '' : ' ';
          input.setValue(`${head}@${picked.insert}${suffix}`);
        }
        return;
      }
      if (e.name === 'escape') {
        if (mentionCtx) input.setValue(inputValue.slice(0, mentionCtx.at));
        return;
      }
    }

    // 4. Active slash menu.
    if (slashMatches.length > 0) {
      if (e.name === 'up') {
        setSlashIdx((i) => (i - 1 + slashMatches.length) % slashMatches.length);
        return;
      }
      if (e.name === 'down') {
        setSlashIdx((i) => (i + 1) % slashMatches.length);
        return;
      }
      if (e.name === 'tab') {
        const typed = inputValue.trim();
        const picked = slashMatches.find((s) => s.name === typed) ?? slashMatches[slashIdx];
        if (picked) input.setValue(picked.args ? `${picked.name} ` : picked.name);
        return;
      }
      if (e.name === 'return') {
        const typed = inputValue.trim();
        const exact = slashMatches.find((s) => s.name === typed);
        if (exact) {
          input.clear();
          submit(typed);
          return;
        }
        const picked = slashMatches[slashIdx];
        if (picked) {
          input.setValue(picked.args ? `${picked.name} ` : picked.name);
          return;
        }
      }
      if (e.name === 'escape') {
        const slashAt = inputValue.indexOf('/');
        input.setValue(slashAt >= 0 ? inputValue.slice(0, slashAt) : '');
        return;
      }
    }

    // 5. Normal multi-line input editing — stays available while the agent
    //    runs so the prompt box never freezes on "planning…".

    // 5a. Esc clears the draft when idle (busy Esc already aborted above).
    if (e.name === 'escape') {
      if (inputValue.length > 0) input.clear();
      if (historyIdx !== null) {
        setHistoryIdx(null);
        historyDraft.current = '';
      }
      return;
    }

    // 5b. Ctrl-N / Ctrl-J → insert a newline instead of submitting.
    if (e.ctrl && (e.name === 'n' || e.name === 'j')) {
      input.insertText('\n');
      return;
    }

    if (e.name === 'return') {
      const v = inputValue.trim();
      if (v.length === 0) return;
      input.clear();
      setInputEpoch((n) => n + 1);
      submit(v);
      return;
    }

    // 5c. Cursor movement.
    if (e.name === 'left') {
      input.moveLeft();
      return;
    }
    if (e.name === 'right') {
      input.moveRight();
      return;
    }
    if (e.name === 'up') {
      if (!inputValue.includes('\n') && cursorIsOnFirstLine(inputValue, input.cursor)) {
        const h = historyRef.current;
        if (h.length === 0) return;
        if (historyIdx === null) {
          historyDraft.current = inputValue;
          const next = h.length - 1;
          setHistoryIdx(next);
          input.setValue(h[next] ?? '');
        } else if (historyIdx > 0) {
          const next = historyIdx - 1;
          setHistoryIdx(next);
          input.setValue(h[next] ?? '');
        }
        return;
      }
      input.moveUp();
      return;
    }
    if (e.name === 'down') {
      if (!inputValue.includes('\n') && cursorIsOnLastLine(inputValue, input.cursor)) {
        if (historyIdx === null) return;
        const h = historyRef.current;
        const next = historyIdx + 1;
        if (next >= h.length) {
          setHistoryIdx(null);
          input.setValue(historyDraft.current);
          historyDraft.current = '';
        } else {
          setHistoryIdx(next);
          input.setValue(h[next] ?? '');
        }
        return;
      }
      input.moveDown();
      return;
    }
    if (e.ctrl && e.name === 'a') {
      input.moveLineStart();
      return;
    }
    if (e.ctrl && e.name === 'e') {
      input.moveLineEnd();
      return;
    }

    // 5d. Deletion — Backspace deletes left; Delete deletes forward.
    if (e.name === 'backspace') {
      input.backspace();
      return;
    }
    if (e.name === 'delete') {
      input.deleteForward();
      return;
    }

    // 5e. Other chords reserved (Cmd/Ctrl combos not handled above).
    if (e.ctrl || e.meta) return;

    // 5f. Plain printable / unbracketed paste dump.
    // Terminal.app sometimes pastes without bracketed-paste markers as one
    // multi-character sequence — treat multi-char as paste so multi-line
    // content collapses cleanly instead of injecting raw control noise.
    if (e.sequence && e.name !== 'escape') {
      if (e.sequence.length > 1) {
        insertPastedText(e.sequence);
      } else {
        input.insertText(e.sequence);
      }
    }
  });

  // ---------- layout ----------

  const { liveEntry, filteredCommitted, showLiveEntry, expandHint } = useMemo(() => {
    const last = state.transcript[state.transcript.length - 1];
    const live = last && last.kind === 'assistant' && last.streaming ? last : null;
    const committed = live ? state.transcript.slice(0, -1) : state.transcript;
    return {
      liveEntry: live,
      filteredCommitted: filterTranscript(committed, state.transcriptFilter),
      showLiveEntry: live ? transcriptEntryMatchesFilter(live, state.transcriptFilter) : false,
      expandHint: state.transcript.some((e) => e.collapsible && !e.expanded),
    };
  }, [state.transcript, state.transcriptFilter]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: transcript.length + busy are deliberate cache-busters for agent's hidden mutable state — same reasoning as ../ui/App.tsx's identical memo.
  const statusInfo = useMemo(() => {
    return {
      target: agent.target.baseURL() || agent.target.name(),
      memoryItems: agent.getMemoryStats().items,
      ctxTokens: agent.contextTokens(),
      compactThreshold: agent.getAutoCompactThreshold(),
      usage: agent.getUsage(),
    };
  }, [agent, state.transcript.length, state.busy]);

  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  useEffect(() => {
    if (!state.busy) {
      setElapsedSeconds(0);
      return;
    }
    const start = Date.now();
    setElapsedSeconds(0);
    const id = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - start) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [state.busy]);

  // Multi-line drafts grow the input frame; FOOTER_IDLE already covers a
  // 1-line frame + hint + status. Soft-wrapped long lines add physical
  // rows beyond split('\n') — budget a little extra from total length.
  const softWrapExtra = Math.max(
    0,
    Math.ceil(
      Math.max(...inputValue.split('\n').map((l) => l.length), 0) / Math.max(20, chatWidth - 6),
    ) - 1,
  );

  // When a permission card is open the input is hidden — do not let a
  // multi-line draft steal rows from the chat strip (that pushed the
  // card under the last terminal row on short windows).
  const chatScrollHeight = hasPerm
    ? chatPaneHeight
    : Math.max(CHAT_MIN_HEIGHT, chatPaneHeight - softWrapExtra);

  return (
    <box
      style={{
        flexDirection: 'column',
        width: cols,
        height: rows,
        // Hard clip — nothing paints past the terminal edge.
        overflow: 'hidden',
      }}
      onMouseScroll={(e) => {
        // Root-level wheel so scrolling works over input/status too, not
        // only when the pointer is over the chat pane.
        if (secretInput || state.pendingPerm || state.pendingAsk || state.pendingSkills) return;
        if (!e.scroll) return;
        const step = Math.max(1, e.scroll.delta ?? 1) * 3;
        if (e.scroll.direction === 'up') scrollBy(step);
        else if (e.scroll.direction === 'down') scrollBy(-step);
      }}
    >
      <ChatPane
        committed={filteredCommitted}
        liveEntry={showLiveEntry && liveEntry ? liveEntry : undefined}
        bannerData={liveBanner}
        compactMode={state.compactMode}
        width={chatWidth}
        height={chatScrollHeight}
        totalHeight={bannerHeight + chatScrollHeight}
        scrollOffset={scrollOffset}
        onScrollBy={scrollBy}
        unseenBelow={unseenBelow}
        onToggleExpand={(entry) =>
          dispatch({
            type: 'toggle-expand',
            progressKey: entry.progressKey,
            fullText: entry.fullText,
          })
        }
      />
      {/* Exact footer height when a modal is open so ChatPane + footer
            always sum to `rows`. flexShrink:0 keeps Yoga from crushing
            the permission card; overflow:hidden is a last-resort clip. */}
      <box
        style={{
          flexDirection: 'column',
          flexShrink: 0,
          flexGrow: 0,
          height: hasModal || hasPerm ? footerReserved : undefined,
          maxHeight: hasModal || hasPerm ? footerReserved : undefined,
          overflow: 'hidden',
          width: chatWidth,
          justifyContent: 'center',
          alignItems: 'center',
        }}
      >
        {secretInput ? (
          <SecretInputModal req={secretInput} />
        ) : state.pendingAsk ? (
          <AskModal req={state.pendingAsk} />
        ) : state.pendingPerm ? (
          <PermissionModal
            req={state.pendingPerm}
            maxWidth={chatWidth}
            maxDetailLines={permDetailLines}
            maxHeight={footerReserved}
          />
        ) : state.pendingSkills ? (
          <SkillsModal
            agent={agent}
            persistDisabledSkills={persistDisabledSkills}
            onClose={() => dispatch({ type: 'set-skills-picker', open: false })}
          />
        ) : (
          <box style={{ flexDirection: 'column' }}>
            {mentionMatches.length > 0 ? (
              <MentionMenu
                cwd={mentionDirBase?.dir ?? ''}
                candidates={mentionMatches}
                selected={mentionIdx}
              />
            ) : slashMatches.length > 0 ? (
              <SlashMenu items={slashMatches} selected={slashIdx} />
            ) : null}
            {/* Status (Writing / Thinking / Ready) sits ABOVE the prompt box. */}
            <StatusBar
              busy={state.busy}
              apiReady={state.apiReady}
              activeSkill={state.activeSkill}
              yolo={state.yolo}
              ctxTokens={statusInfo.ctxTokens}
              compactThreshold={statusInfo.compactThreshold}
              memoryItems={statusInfo.memoryItems}
              model={state.bannerData.model}
              toolSupport={state.bannerData.toolSupport}
              phase={state.phase}
              transcriptFilter={state.transcriptFilter}
              target={statusInfo.target}
              expandHint={expandHint}
              runningTool={state.runningTool}
              lastTool={state.lastTool}
              findingsCount={state.findingsCount}
              usage={statusInfo.usage}
              elapsedSeconds={elapsedSeconds}
              draftTokens={Math.floor(inputValue.length / 4)}
              maxWidth={chatWidth}
            />
            <Input
              key={inputEpoch}
              value={inputValue}
              cursor={input.cursor}
              width={chatWidth}
              hint={
                state.busy
                  ? queueLen > 0
                    ? `${queueLen} queued · Esc to cancel`
                    : 'Esc to cancel'
                  : undefined
              }
            />
          </box>
        )}
      </box>
    </box>
  );
}

// ---------- helpers ----------

function cursorIsOnFirstLine(value: string, cursor: number): boolean {
  return value.lastIndexOf('\n', cursor - 1) === -1;
}

function cursorIsOnLastLine(value: string, cursor: number): boolean {
  return value.indexOf('\n', cursor) === -1;
}

function filterTranscript(entries: TranscriptEntry[], filter: TranscriptFilter): TranscriptEntry[] {
  if (filter === 'all') return entries;
  if (filter === 'current') {
    const lastUserIdx = entries.findLastIndex((entry) => entry.kind === 'user');
    return lastUserIdx === -1 ? entries : entries.slice(lastUserIdx);
  }
  return entries.filter((entry) => transcriptEntryMatchesFilter(entry, filter));
}

function transcriptEntryMatchesFilter(entry: TranscriptEntry, filter: TranscriptFilter): boolean {
  switch (filter) {
    case 'all':
    case 'current':
      return true;
    case 'compact':
      if (entry.kind === 'tool-result' && entry.text.startsWith('[ok]')) return false;
      return entry.kind !== 'decision';
    case 'findings':
      return entry.kind === 'finding' || entry.text.includes('Confirmed Finding');
    case 'errors':
      return entry.kind === 'error' || entry.text.includes('[error]');
  }
}
