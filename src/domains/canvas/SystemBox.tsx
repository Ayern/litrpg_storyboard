import { useState } from 'react';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';

import {
  achievementBanner,
  levelLine,
  questStatusLabels,
  statChange,
  statDelta,
  systemMessageHtml,
  systemMessageMarkdown,
} from './systemMessage';
import type { SystemMessage } from './systemMessage';

// A system card as an in-world box. LitRPG stories announce things in a box the
// characters see, and an author then has to retype that box into a web editor, so
// the card is drawn the way the reader will meet it and copied in one press: as
// plain text to centre in a chapter, or as centred HTML.
//
// What the box says depends on what it is announcing: a level that moved, a skill
// that evolved, a quest with objectives. `systemMessage.ts` holds that shape and
// the text format the card stores it in; this file draws it and copies it out.

/** The box as the card face draws it, in the shape its kind asks for. */
export function SystemBoxFace({ message }: { message: SystemMessage }) {
  const rewards = message.rewards.map(reward => reward.trim()).filter(Boolean);
  const objectives = message.objectives.filter(objective => objective.text.trim());
  const empty =
    !message.title &&
    !message.body &&
    message.stats.length === 0 &&
    objectives.length === 0 &&
    rewards.length === 0 &&
    !levelLine(message) &&
    !message.points.trim() &&
    !message.rank.trim() &&
    !message.evolution.trim();

  return (
    <div className="system-box" data-system-kind={message.kind}>
      <span className="system-box-header">{message.header}</span>
      {message.title && <span className="system-box-title">{message.title}</span>}

      {message.kind === 'level_up' && (
        <>
          {levelLine(message) && (
            <span className="system-box-level">{levelLine(message)}</span>
          )}
          {message.points.trim() && (
            <span className="system-box-points">
              {message.points.trim()} point{message.points.trim() === '1' ? '' : 's'} to place
            </span>
          )}
          {message.stats.length > 0 && (
            <ul className="system-box-stats">
              {message.stats.map((stat, index) => (
                <li key={index} className="system-box-stat">
                  <span>{statChange(stat)}</span>
                  {statDelta(stat.from, stat.to) && (
                    <span className="system-box-delta">{statDelta(stat.from, stat.to)}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {message.kind === 'skill' && (
        <>
          {message.rank.trim() && (
            <span className="system-box-rank">Rank {message.rank.trim()}</span>
          )}
          {message.evolution.trim() && (
            <span className="system-box-evolution">{message.evolution.trim()}</span>
          )}
        </>
      )}

      {message.kind === 'quest' && (
        <>
          <span className="system-box-status">{questStatusLabels[message.status]}</span>
          {objectives.length > 0 && (
            <ul className="system-box-objectives">
              {objectives.map((objective, index) => (
                <li
                  key={index}
                  className={`system-box-objective${objective.done ? ' done' : ''}`}
                >
                  <span className="system-box-tick">{objective.done ? '✓' : '○'}</span>
                  {objective.text.trim()}
                </li>
              ))}
            </ul>
          )}
          {rewards.length > 0 && (
            <span className="system-box-rewards">Rewards: {rewards.join(' · ')}</span>
          )}
        </>
      )}

      {message.kind === 'achievement' && (
        <>
          <span className="system-box-banner">{achievementBanner}</span>
          {rewards.length > 0 && (
            <span className="system-box-rewards">Rewards: {rewards.join(' · ')}</span>
          )}
        </>
      )}

      {message.body && <span className="system-box-body">{message.body}</span>}

      {empty && (
        <span className="system-box-empty">
          Choose what this box announces, then fill in the fields under it.
        </span>
      )}
    </div>
  );
}

export type SystemBoxFormat = 'markdown' | 'html';

/** Copy, with its own answer: a clipboard that refuses says so rather than
 *  claiming the box is on it. Each format is its own button, so pressing one
 *  never leaves the other looking pressed. */
function CopyButton({ text, idle, title }: { text: string; idle: string; title: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  const copy = async () => {
    try {
      await writeText(text);
      setState('copied');
      window.setTimeout(() => setState('idle'), 2000);
    } catch (e) {
      console.error('Could not copy the system box:', e);
      setState('failed');
    }
  };

  return (
    <button
      type="button"
      className="system-box-copy nodrag nopan"
      title={title}
      onClick={event => {
        event.stopPropagation();
        void copy();
      }}
    >
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : idle}
    </button>
  );
}

/** The box as Markdown, or as HTML when the site's editor wants tags. */
export function CopySystemBoxButton({
  message,
  format = 'markdown',
}: {
  message: SystemMessage;
  format?: SystemBoxFormat;
}) {
  return format === 'html' ? (
    <CopyButton
      text={systemMessageHtml(message)}
      idle="Copy HTML"
      title="Copy this box as centred HTML, for an editor that takes tags"
    />
  ) : (
    <CopyButton
      text={systemMessageMarkdown(message)}
      idle="Copy System Box"
      title="Copy this box as plain text with its bold lines, ready to centre in Royal Road or Scribble Hub"
    />
  );
}
