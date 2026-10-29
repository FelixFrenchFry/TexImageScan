import { useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { AlertDialog, Flex } from '@radix-ui/themes';
import { History, Trash2 } from 'lucide-react';
import { type HistoryEntry } from '../../src/protocol';
import { renderMath, splitMath } from '../../src/preview';

const historyDate = new Intl.DateTimeFormat('de-DE', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});
const historyTime = new Intl.DateTimeFormat('de-DE', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

function HistoryPreview({ source }: { source: string }) {
  const content = useRef<HTMLSpanElement>(null);
  const rendered = useMemo(() => {
    const math = splitMath(source).find((part) => part.kind === 'math');
    if (math?.kind === 'math') return renderMath(math.source, false);
    // older scans and edits may contain bare LaTeX
    return /^\s*\\/.test(source) ? renderMath(source, false) : null;
  }, [source]);

  useLayoutEffect(() => {
    const node = content.current;
    const viewport = node?.parentElement;
    if (!node || !viewport) return;
    const fit = () => {
      if (node.offsetHeight && viewport.clientHeight)
        node.style.setProperty(
          '--history-math-scale',
          String(Math.min(1, viewport.clientHeight / node.offsetHeight)),
        );
    };
    const observer = new ResizeObserver(fit);
    observer.observe(node);
    observer.observe(viewport);
    fit();
    return () => observer.disconnect();
  }, [rendered]);

  return (
    <span className="history-preview">
      {rendered?.kind === 'html' ? (
        <span
          ref={content}
          className="history-preview-content"
          dangerouslySetInnerHTML={{ __html: rendered.html }}
        />
      ) : (
        <span className="history-preview-text">{source || 'Empty source'}</span>
      )}
    </span>
  );
}

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
}: {
  entries: HistoryEntry[];
  activeId: string | undefined;
  disabled: boolean;
  onOpen: (id: string) => void;
  onDelete: (ids: string[]) => void;
  onClear: () => void;
}) {
  const [limit, setLimit] = useState(20);

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
            <ConfirmDelete
              title="Clear scan history?"
              description={`Delete all ${entries.length} saved scans and their crops?`}
              action="Clear history"
              disabled={disabled}
              onConfirm={onClear}
            >
              <button className="text-link" disabled={disabled}>
                <Trash2 size={13} aria-hidden="true" />
                Clear history
              </button>
            </ConfirmDelete>
          </Flex>
          <ul className="history-list">
            {entries.slice(0, limit).map((entry) => (
              <li key={entry.id} className={entry.id === activeId ? 'active' : ''}>
                <button
                  className="history-open"
                  aria-label={`Open ${entry.name}`}
                  disabled={disabled}
                  onClick={() => onOpen(entry.id)}
                >
                  <HistoryPreview source={entry.preview} />
                  <span className="history-name">
                    {entry.name}
                    {entry.edited ? ' · Edited' : ''}
                    {entry.truncated ? ' · Incomplete' : ''}
                    {entry.id === activeId ? ' · Open' : ''}
                  </span>
                  <time className="history-timestamp" dateTime={entry.createdAt}>
                    {historyDate.format(new Date(entry.createdAt))}
                    {' · '}
                    {historyTime.format(new Date(entry.createdAt))}
                  </time>
                </button>
                <ConfirmDelete
                  title="Delete scan?"
                  description={`Delete ${entry.name} and its saved crop?`}
                  action="Delete scan"
                  disabled={disabled}
                  onConfirm={() => onDelete([entry.id])}
                >
                  <button
                    className="icon-action"
                    aria-label={`Delete ${entry.name}`}
                    disabled={disabled}
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
              disabled={disabled}
              onClick={() => setLimit((value) => value + 20)}
            >
              Show more scans
            </button>
          )}
        </>
      )}
    </section>
  );
}
