import { useEffect, useState, type ReactElement } from 'react';
import { AlertDialog, Callout, Checkbox, Flex, Select } from '@radix-ui/themes';
import { AlertCircle, Check, Copy, History, Trash2 } from 'lucide-react';
import { type HistoryEntry } from '../../src/protocol';

function ConfirmDelete({
  children,
  title,
  description,
  action,
  disabled,
  onConfirm,
}: {
  children: ReactElement;
  title: string;
  description: string;
  action: string;
  disabled: boolean;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog.Root>
      <AlertDialog.Trigger>{children}</AlertDialog.Trigger>
      <AlertDialog.Content className="confirm-dialog" maxWidth="420px">
        <AlertDialog.Title>{title}</AlertDialog.Title>
        <AlertDialog.Description>{description} This cannot be undone.</AlertDialog.Description>
        <div className="dialog-actions">
          <AlertDialog.Cancel>
            <button className="secondary-action">Cancel</button>
          </AlertDialog.Cancel>
          <AlertDialog.Action>
            <button
              className="secondary-action danger-action"
              disabled={disabled}
              onClick={onConfirm}
            >
              {action}
            </button>
          </AlertDialog.Action>
        </div>
      </AlertDialog.Content>
    </AlertDialog.Root>
  );
}

export function ScanHistory({
  entries,
  activeId,
  disabled,
  onOpen,
  onDelete,
  onClear,
  onExport,
}: {
  entries: HistoryEntry[];
  activeId: string | undefined;
  disabled: boolean;
  onOpen: (id: string) => void;
  onDelete: (ids: string[]) => void;
  onClear: () => void;
  onExport: (ids: string[], format: 'markdown' | 'latex') => Promise<string>;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [limit, setLimit] = useState(20);
  const [format, setFormat] = useState<'markdown' | 'latex'>('markdown');
  const [copying, setCopying] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const available = new Set(entries.map((entry) => entry.id));
    setSelected((previous) =>
      previous.every((id) => available.has(id))
        ? previous
        : previous.filter((id) => available.has(id)),
    );
    setCopied(false);
  }, [entries]);
  const busy = disabled || copying;

  async function copy() {
    setCopying(true);
    setCopied(false);
    setError('');
    try {
      const text = await onExport(selected, format);
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not copy the selected scans.');
    } finally {
      setCopying(false);
    }
  }

  return (
    <section id="scan-history" aria-label="Scan history">
      <div className="section-heading">
        <h2>
          <History size={15} />
          Scan history
        </h2>
      </div>
      {entries.length === 0 ? (
        <p className="empty">
          No saved scans yet. Successful recognitions will appear here automatically.
        </p>
      ) : (
        <>
          <p className="hint">
            {entries.length} saved {entries.length === 1 ? 'scan' : 'scans'} · Stored on this device
          </p>
          <Flex gap="3" align="center" wrap="wrap" mb="3">
            <button
              className="secondary-action"
              disabled={busy}
              onClick={() => {
                setSelected(
                  selected.length === entries.length ? [] : entries.map((entry) => entry.id),
                );
                setCopied(false);
              }}
            >
              {selected.length === entries.length ? 'Clear selection' : 'Select all'}
            </button>
            <span className="hint" role="status">
              {selected.length} selected
            </span>
            <ConfirmDelete
              title="Clear scan history?"
              description={`Delete all ${entries.length} saved scans and their crops?`}
              action="Clear history"
              disabled={busy}
              onConfirm={onClear}
            >
              <button className="text-link" disabled={busy}>
                <Trash2 size={13} aria-hidden="true" />
                Clear history
              </button>
            </ConfirmDelete>
          </Flex>
          <ul className="history-list">
            {entries.slice(0, limit).map((entry) => (
              <li key={entry.id} className={entry.id === activeId ? 'active' : ''}>
                <Checkbox
                  aria-label={`Select ${entry.name}`}
                  checked={selected.includes(entry.id)}
                  disabled={busy}
                  onCheckedChange={(checked) => {
                    setSelected((previous) =>
                      checked === true
                        ? [...previous, entry.id]
                        : previous.filter((id) => id !== entry.id),
                    );
                    setCopied(false);
                  }}
                />
                <button
                  className="history-open"
                  aria-label={`Open ${entry.name}`}
                  disabled={busy}
                  onClick={() => onOpen(entry.id)}
                >
                  <strong>{entry.name}</strong>
                  <span className="history-excerpt">{entry.preview || 'Empty source'}</span>
                  <small>
                    {new Date(entry.createdAt).toLocaleString()}
                    {entry.edited ? ' · Edited' : ''}
                    {entry.truncated ? ' · Incomplete' : ''}
                    {entry.id === activeId ? ' · Open' : ''}
                  </small>
                </button>
                <ConfirmDelete
                  title="Delete scan?"
                  description={`Delete ${entry.name} and its saved crop?`}
                  action="Delete scan"
                  disabled={busy}
                  onConfirm={() => onDelete([entry.id])}
                >
                  <button
                    className="icon-action"
                    aria-label={`Delete ${entry.name}`}
                    disabled={busy}
                  >
                    <Trash2 size={15} aria-hidden="true" />
                  </button>
                </ConfirmDelete>
              </li>
            ))}
          </ul>
          {limit < entries.length && (
            <button
              className="text-link history-more"
              disabled={busy}
              onClick={() => setLimit((value) => value + 20)}
            >
              Show more scans
            </button>
          )}
          <Flex className="history-export" gap="2" align="center" wrap="wrap" mt="3">
            <Select.Root
              value={format}
              disabled={busy}
              onValueChange={(value) => {
                if (value === 'markdown' || value === 'latex') setFormat(value);
                setCopied(false);
              }}
            >
              <Select.Trigger aria-label="History copy format" />
              <Select.Content>
                <Select.Item value="markdown">Markdown with math</Select.Item>
                <Select.Item value="latex">LaTeX / mixed source</Select.Item>
              </Select.Content>
            </Select.Root>
            <button
              className="secondary-action"
              disabled={busy || selected.length === 0}
              onClick={() => void copy()}
            >
              {copied ? (
                <Check size={15} aria-hidden="true" />
              ) : (
                <Copy size={15} aria-hidden="true" />
              )}
              {copying ? 'Copying…' : copied ? 'Copied selection' : 'Copy selected'}
            </button>
          </Flex>
          <p className="hint">
            Selected scans are combined oldest first, using your edits. LaTeX removes wrappers
            around standalone equations. Mixed passages keep their source.
          </p>
          {error && (
            <Callout.Root color="red" role="alert">
              <Callout.Icon>
                <AlertCircle size={17} aria-hidden="true" />
              </Callout.Icon>
              <Callout.Text>{error}</Callout.Text>
            </Callout.Root>
          )}
        </>
      )}
    </section>
  );
}
