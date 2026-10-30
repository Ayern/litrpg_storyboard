import {
  questStatuses,
  questStatusLabels,
  systemKindLabels,
  systemKinds,
} from './systemMessage';
import type { SystemKind, SystemMessage, SystemStat } from './systemMessage';

// The fields a card's kind asks for, rather than one text box for every
// announcement. The form writes the card's notes (through the caller), so
// switching the kind here rewrites the message the box and the copies read — and
// the whole edit is one Save, one history step.

interface SystemMessageFormProps {
  message: SystemMessage;
  onChange: (next: SystemMessage) => void;
}

export function SystemMessageForm({ message, onChange }: SystemMessageFormProps) {
  const patch = (next: Partial<SystemMessage>) => onChange({ ...message, ...next });

  const setStat = (index: number, next: Partial<SystemStat>) =>
    patch({
      stats: message.stats.map((stat, at) => (at === index ? { ...stat, ...next } : stat)),
    });

  return (
    <div className="system-message-form">
      <label className="node-drawer-label" htmlFor="system-kind">
        Message type
      </label>
      <select
        id="system-kind"
        className="node-editor-select"
        value={message.kind}
        onChange={event => patch({ kind: event.target.value as SystemKind })}
      >
        {systemKinds.map(kind => (
          <option key={kind} value={kind}>
            {systemKindLabels[kind]}
          </option>
        ))}
      </select>

      <label className="node-drawer-label" htmlFor="system-title">
        Title
      </label>
      <input
        id="system-title"
        className="node-editor-label"
        value={message.title}
        placeholder={
          message.kind === 'skill' ? 'e.g. [Ember Step]' : 'e.g. The Tide Advances'
        }
        onChange={event => patch({ title: event.target.value })}
      />

      {message.kind === 'level_up' && (
        <>
          <div className="system-field-pair">
            <div>
              <label className="node-drawer-label" htmlFor="system-level-from">
                Level from
              </label>
              <input
                id="system-level-from"
                className="node-editor-label"
                inputMode="numeric"
                value={message.levelFrom}
                onChange={event => patch({ levelFrom: event.target.value })}
              />
            </div>
            <div>
              <label className="node-drawer-label" htmlFor="system-level-to">
                Level to
              </label>
              <input
                id="system-level-to"
                className="node-editor-label"
                inputMode="numeric"
                value={message.levelTo}
                onChange={event => patch({ levelTo: event.target.value })}
              />
            </div>
          </div>

          <label className="node-drawer-label" htmlFor="system-points">
            Points to place
          </label>
          <input
            id="system-points"
            className="node-editor-label"
            inputMode="numeric"
            value={message.points}
            onChange={event => patch({ points: event.target.value })}
          />

          <div className="node-drawer-label system-stats-heading">
            Stat changes
            <button
              type="button"
              className="system-add-row"
              onClick={() =>
                patch({ stats: [...message.stats, { name: '', from: '', to: '' }] })
              }
            >
              Add stat
            </button>
          </div>

          {message.stats.length === 0 && (
            <p className="node-drawer-note">
              A stat that moved, e.g. Agility 12 → 13, prints as a line in the box.
            </p>
          )}

          {message.stats.map((stat, index) => (
            <div className="system-stat-row" key={index}>
              <input
                className="node-editor-label system-stat-name"
                aria-label={`Stat ${index + 1} name`}
                placeholder="Agility"
                value={stat.name}
                onChange={event => setStat(index, { name: event.target.value })}
              />
              <input
                className="node-editor-label"
                aria-label={`Stat ${index + 1} from`}
                inputMode="numeric"
                placeholder="12"
                value={stat.from}
                onChange={event => setStat(index, { from: event.target.value })}
              />
              <span className="system-stat-arrow">→</span>
              <input
                className="node-editor-label"
                aria-label={`Stat ${index + 1} to`}
                inputMode="numeric"
                placeholder="13"
                value={stat.to}
                onChange={event => setStat(index, { to: event.target.value })}
              />
              <button
                type="button"
                className="system-remove-row"
                aria-label={`Remove stat ${index + 1}`}
                onClick={() =>
                  patch({ stats: message.stats.filter((_, at) => at !== index) })
                }
              >
                ×
              </button>
            </div>
          ))}
        </>
      )}

      {message.kind === 'skill' && (
        <>
          <label className="node-drawer-label" htmlFor="system-rank">
            Rank or tier
          </label>
          <input
            id="system-rank"
            className="node-editor-label"
            placeholder="2 (Evolved)"
            value={message.rank}
            onChange={event => patch({ rank: event.target.value })}
          />

          <label className="node-drawer-label" htmlFor="system-evolution">
            Evolution note
          </label>
          <input
            id="system-evolution"
            className="node-editor-label"
            placeholder="Evolved from [Spark Step] via Deep Water immersion"
            value={message.evolution}
            onChange={event => patch({ evolution: event.target.value })}
          />
        </>
      )}

      {message.kind === 'quest' && (
        <>
          <label className="node-drawer-label" htmlFor="system-status">
            Quest status
          </label>
          <select
            id="system-status"
            className="node-editor-select"
            value={message.status}
            onChange={event =>
              patch({ status: event.target.value as SystemMessage['status'] })
            }
          >
            {questStatuses.map(status => (
              <option key={status} value={status}>
                {questStatusLabels[status]}
              </option>
            ))}
          </select>

          <div className="node-drawer-label system-stats-heading">
            Objectives
            <button
              type="button"
              className="system-add-row"
              onClick={() =>
                patch({ objectives: [...message.objectives, { text: '', done: false }] })
              }
            >
              Add objective
            </button>
          </div>

          {message.objectives.map((objective, index) => (
            <div className="system-objective-row" key={index}>
              <input
                type="checkbox"
                aria-label={`Objective ${index + 1} done`}
                checked={objective.done}
                onChange={event =>
                  patch({
                    objectives: message.objectives.map((entry, at) =>
                      at === index ? { ...entry, done: event.target.checked } : entry
                    ),
                  })
                }
              />
              <input
                className="node-editor-label"
                aria-label={`Objective ${index + 1} text`}
                placeholder="Reach the Drowned Stair"
                value={objective.text}
                onChange={event =>
                  patch({
                    objectives: message.objectives.map((entry, at) =>
                      at === index ? { ...entry, text: event.target.value } : entry
                    ),
                  })
                }
              />
              <button
                type="button"
                className="system-remove-row"
                aria-label={`Remove objective ${index + 1}`}
                onClick={() =>
                  patch({
                    objectives: message.objectives.filter((_, at) => at !== index),
                  })
                }
              >
                ×
              </button>
            </div>
          ))}
        </>
      )}

      {(message.kind === 'quest' || message.kind === 'achievement') && (
        <>
          <label className="node-drawer-label" htmlFor="system-rewards">
            Rewards
          </label>
          <textarea
            id="system-rewards"
            className="node-editor-content system-rewards"
            placeholder={'400 XP\n+10 Faction Standing (Salt Choir)'}
            value={message.rewards.join('\n')}
            onChange={event =>
              patch({
                rewards: event.target.value
                  .split('\n')
                  .map(line => line.trim())
                  .filter(Boolean),
              })
            }
          />
        </>
      )}

      <label className="node-drawer-label" htmlFor="system-body">
        {message.kind === 'notice' ? 'Body' : 'Extra text (optional)'}
      </label>
      <textarea
        id="system-body"
        className="node-editor-content"
        placeholder={
          message.kind === 'notice'
            ? 'What the System is saying.'
            : 'Flavour text under the box, if you want any.'
        }
        value={message.body}
        onChange={event => patch({ body: event.target.value })}
      />
    </div>
  );
}
