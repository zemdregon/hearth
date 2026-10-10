import { useRef, useState } from 'react';
import { AlertCircle, Pencil, Trash2 } from 'lucide-react';
import { Button, Modal } from '../components/ui';

// A completed or deleted row unmounts the control that held keyboard focus, which would drop it to
// the start of the page. Remember where the row sat and hand focus to its neighbour afterwards.
let lastRow: { parent: Element; index: number } | null = null;
function rememberRow(from: Element | null) {
  const row = from?.closest('article');
  const parent = row?.parentElement;
  if (row && parent) lastRow = { parent, index: [...parent.children].indexOf(row) };
}
function restoreFocusAfterRemoval() {
  const target = lastRow;
  lastRow = null;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (document.activeElement && document.activeElement !== document.body) return;
    const rows = target?.parent.isConnected ? [...target.parent.children] : [];
    const row = rows[Math.min(target?.index ?? 0, rows.length - 1)];
    (row?.querySelector<HTMLElement>('button:not(:disabled)') ?? document.getElementById('main-content'))?.focus();
  }));
}

const EDIT_CONFLICT = 'This item changed while you were editing. Your draft is still here. Copy any changes you want to keep, then close and reopen this editor to load the latest version.';

/** The server also answers 409 for a full family store; its own wording is the useful one there. */
export function failureMessage(cause: unknown, key: string): string {
  const conflict = cause instanceof Error && 'status' in cause && cause.status === 409 && !/storage is full/i.test(cause.message);
  if (conflict && key === 'save') return EDIT_CONFLICT;
  return cause instanceof Error ? cause.message : 'Something went wrong. Please try again.';
}

export function useFamilyMutation() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  async function perform(key: string, action: () => Promise<unknown>) {
    if (inFlight.current) return false;
    inFlight.current = true;
    rememberRow(document.activeElement);
    setBusy(key);
    setError(null);
    try {
      await action();
      restoreFocusAfterRemoval();
      return true;
    } catch (cause) {
      setError(failureMessage(cause, key));
      return false;
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }
  return { busy, error, setError, perform };
}

export function FamilyFeedback({ error }: { error: string | null }) {
  return error ? <div className="family-error" role="alert"><AlertCircle size={18} aria-hidden="true" /><span>{error}</span></div> : null;
}

export function FamilyActions({ title, disabled, onEdit, onDelete }: { title: string; disabled?: boolean; onEdit: () => void; onDelete: () => void }) {
  return <div className="family-actions">
    <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={onEdit} aria-label={`Edit ${title}`}><Pencil size={15} aria-hidden="true" /></Button>
    <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={event => { rememberRow(event.currentTarget); onDelete(); }} aria-label={`Delete ${title}`}><Trash2 size={15} aria-hidden="true" /></Button>
  </div>;
}

export function FamilyDeleteDialog({ open, title, busy, error, onClose, onDelete }: { open: boolean; title: string; busy: boolean; error: string | null; onClose: () => void; onDelete: () => void }) {
  return <Modal open={open} onClose={() => { if (!busy) onClose(); }} title="Delete this item?" description={`“${title}” will be permanently removed from your family's space.`}>
    <FamilyFeedback error={error} />
    <div className="family-form-actions"><Button type="button" variant="secondary" onClick={onClose} disabled={busy}>Keep it</Button><Button type="button" variant="danger" onClick={onDelete} busy={busy}>Delete item</Button></div>
  </Modal>;
}

export function FamilyFilters<T extends string>({ value, onChange, options, label }: { value: T; onChange: (value: T) => void; options: { value: T; label: string; count?: number }[]; label: string }) {
  return <div className="family-filters" role="group" aria-label={label}>{options.map(option => <button key={option.value} type="button" className={value === option.value ? 'is-active' : ''} onClick={() => onChange(option.value)} aria-pressed={value === option.value}>{option.label}{option.count !== undefined && <span>{option.count}</span>}</button>)}</div>;
}

export function personInitials(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase() || '?';
}

export function avatarTextColor(background: string) {
  if (!/^#[\da-f]{6}$/i.test(background)) return '#fff';
  const rgb = [1, 3, 5].map(offset => parseInt(background.slice(offset, offset + 2), 16) / 255);
  const linear = rgb.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  const luminance = linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  return luminance > 0.179 ? '#000' : '#fff';
}

export function linesToList(value: string) {
  return [...new Set(value.split('\n').map(item => item.trim()).filter(Boolean))];
}
