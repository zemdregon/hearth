import { useEffect, useId, useRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react';
import { LoaderCircle, Sprout, X } from 'lucide-react';

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; size?: 'sm' | 'md'; busy?: boolean;
};

export function Button({ variant = 'primary', size = 'md', busy, children, className = '', disabled, type = 'button', ...props }: ButtonProps) {
  return <button type={type} className={`button ${variant === 'primary' ? '' : variant} ${size === 'sm' ? 'small' : ''} ${className}`} disabled={disabled || busy} aria-busy={busy || undefined} {...props}>
    {busy && <LoaderCircle size={16} className="spin" aria-hidden="true" />}{children}
  </button>;
}

export function Field({ label, children, hint, error, id }: { label: string; children: ReactNode; hint?: string; error?: string; id?: string }) {
  return <div className={`field ${error ? 'has-error' : ''}`}>
    {id ? <label htmlFor={id}>{label}</label> : <label className="field-wrap"><span>{label}</span>{children}</label>}
    {id && children}
    {hint && <span className="field-hint">{hint}</span>}
    {error && <span className="field-error" role="alert">{error}</span>}
  </div>;
}

export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: string; description?: string; action?: ReactNode }) {
  return <div className="empty-state"><div className="empty-icon" aria-hidden="true">{icon || <Sprout size={25} strokeWidth={1.5} />}</div><h2>{title}</h2>{description && <p>{description}</p>}{action && <div>{action}</div>}</div>;
}

export function Modal({ open, onClose, title, description, children }: { open: boolean; onClose: () => void; title: string; description?: string; children: ReactNode }) {
  const titleId = useId();
  const descriptionId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open || !dialog.current) return;
    const element = dialog.current;
    const previous = document.activeElement as HTMLElement | null;
    element.showModal();
    // React's autoFocus runs before the dialog is open and is ignored; honour the first marked field instead.
    element.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { element.close(); document.body.style.overflow = previousOverflow; previous?.focus(); };
  }, [open]);
  if (!open) return null;
  return <dialog ref={dialog} className="modal" aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined}
    onCancel={event => { event.preventDefault(); closeRef.current(); }}
    onClick={event => { if (event.target === event.currentTarget) { const bounds = event.currentTarget.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose(); } }}>
    <div className="modal-heading"><div><h2 id={titleId}>{title}</h2>{description && <p id={descriptionId} className="muted">{description}</p>}</div><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={20} /></button></div>
    <div className="modal-body">{children}</div>
  </dialog>;
}

export function SectionHeader({ eyebrow, title, description, action }: { eyebrow?: string; title: string; description?: string; action?: ReactNode }) {
  return <header className="section-header"><div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h1>{title}</h1>{description && <p className="section-description">{description}</p>}</div>{action && <div className="section-actions">{action}</div>}</header>;
}

export function Badge({ children, tone = 'neutral', className = '', ...props }: HTMLAttributes<HTMLSpanElement> & { children: ReactNode; tone?: 'green' | 'amber' | 'rose' | 'neutral' }) {
  return <span className={`pill ${tone} ${className}`} {...props}>{children}</span>;
}
