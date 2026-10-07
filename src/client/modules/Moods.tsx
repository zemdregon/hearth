import { useEffect, useRef, useState } from 'react';
import { Heart, LockKeyhole, Pencil, Trash2, Users } from 'lucide-react';
import { useFamily, useRecords } from '../store';
import { Badge, Button, EmptyState, Modal, SectionHeader } from '../components/ui';
import { formatDate, todayInTimezone } from '../../shared/calendar';
import type { FamilyRecord, Mood } from '../../shared/types';
import './wellness.css';

const moodOptions = [
  { score: 1, symbol: '☁', label: 'Low' }, { score: 2, symbol: '☂', label: 'A little low' },
  { score: 3, symbol: '⛅', label: 'Steady' }, { score: 4, symbol: '☀', label: 'Good' },
  { score: 5, symbol: '✺', label: 'Great' },
];

export function Moods() {
  const { user, members, timezone, addRecord, updateRecord, deleteRecord } = useFamily();
  const records = useRecords('mood');
  const today = todayInTimezone(timezone);
  const [editing, setEditing] = useState<FamilyRecord<'mood'> | null>(null);
  const [date, setDate] = useState(today);
  const [score, setScore] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [shared, setShared] = useState(false);
  const [filter, setFilter] = useState<'mine' | 'family'>('mine');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [deleting, setDeleting] = useState<FamilyRecord<'mood'> | null>(null);
  const previousDay = useRef(today);
  const existing = records.find(record => record.ownerId === user?.id && record.data.date === date && record.id !== editing?.id);
  const visible = records.filter(record => filter === 'mine' ? record.ownerId === user?.id : record.data.shared).sort((left, right) => right.data.date.localeCompare(left.data.date) || right.createdAt.localeCompare(left.createdAt));

  useEffect(() => {
    if (today === previousDay.current) return;
    const priorDay = previousDay.current;
    previousDay.current = today;
    if (!editing && date === priorDay) {
      if (score === null && !note && !shared) setDate(today);
      else setSaved(`It’s a new day. Your unfinished check-in is still dated ${formatDate(date)}.`);
    }
  }, [today, date, editing, note, score, shared]);

  function reset() { setEditing(null); setDate(today); setScore(null); setNote(''); setShared(false); }
  function edit(record: FamilyRecord<'mood'>) {
    setEditing(record); setDate(record.data.date); setScore(record.data.score); setNote(record.data.note); setShared(record.data.shared); setError(''); setSaved('');
    document.getElementById('mood-entry')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (score === null || !date || existing || busy) return;
    setBusy(true); setError(''); setSaved('');
    const data: Mood = { date, score, note: note.trim(), shared };
    try {
      if (editing) await updateRecord(editing, data); else await addRecord('mood', data);
      setSaved(shared ? 'Check-in saved and shared with your family.' : 'Check-in saved. Only you can see it.'); reset();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Your check-in could not be saved. Please try again.'); }
    finally { setBusy(false); }
  }
  async function confirmDelete() {
    if (!deleting) return;
    setBusy(true); setError('');
    try { await deleteRecord(deleting); if (editing?.id === deleting.id) reset(); setDeleting(null); setSaved('Check-in deleted.'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Your check-in could not be deleted. Please try again.'); }
    finally { setBusy(false); }
  }

  return <div className="wellness-page stack">
    <SectionHeader eyebrow="A moment for you" title="How are you, really?" description="There’s no right way to feel. Take a moment to notice what today feels like." />
    <div className="mood-layout">
      <section id="mood-entry" className="card mood-entry stack" aria-label="Mood check-in">
        <div className="wellness-row"><h2>{editing ? 'Edit your check-in' : 'A little check-in'}</h2><Badge tone={shared ? 'green' : 'neutral'}>{shared ? <Users size={13} aria-hidden="true" /> : <LockKeyhole size={13} aria-hidden="true" />}{shared ? 'Shared' : 'Just you'}</Badge></div>
        <form onSubmit={event => void save(event)} className="stack">
          <fieldset className="wellness-form-fields stack" disabled={busy}>
          <label className="field">Date<input className="input" type="date" required max={today} value={date} onChange={event => setDate(event.target.value)} /></label>
          <fieldset className="wellness-fieldset"><legend>What best fits how you feel?</legend><div className="mood-options">{moodOptions.map(option => <label key={option.score} className={`mood-option ${score === option.score ? 'is-selected' : ''}`}>
            <input type="radio" required name="mood-score" value={option.score} checked={score === option.score} onChange={() => setScore(option.score)} /><span className="mood-symbol" aria-hidden="true">{option.symbol}</span><span>{option.label}</span>
          </label>)}</div></fieldset>
          <label className="field">Anything on your mind? <span className="muted">Optional</span><textarea className="input" rows={4} maxLength={2000} placeholder="A moment, a thought, something you noticed…" value={note} onChange={event => setNote(event.target.value)} /></label>
          <label className={`mood-sharing ${shared ? 'is-shared' : ''}`}><input type="checkbox" checked={shared} onChange={event => setShared(event.target.checked)} /><span><strong>Share this check-in with my family</strong><span>Your feeling and note are private unless you choose to share them.</span></span></label>
          {existing && <div className="wellness-notice"><p>You already have a check-in for this day.</p><Button variant="secondary" size="sm" onClick={() => edit(existing)}>Edit that check-in</Button></div>}
          {error && !deleting && <p className="wellness-error" role="alert">{error}</p>}
          <div className="wellness-actions"><Button type="submit" disabled={score === null || Boolean(existing)} busy={busy}>{editing ? 'Save changes' : 'Save check-in'}</Button>{editing && <Button variant="ghost" disabled={busy} onClick={reset}>Cancel edit</Button>}</div>
          <p className="muted mood-privacy"><LockKeyhole size={14} aria-hidden="true" />Your check-ins stay in your family space. They are never sent to AI.</p>
          </fieldset>
        </form>
      </section>
      <section className="mood-history stack" aria-label="Mood history">
        <div className="wellness-row"><h2>Life, day by day</h2><Heart size={20} aria-hidden="true" /></div>
        <div className="wellness-tabs" aria-label="Check-in visibility"><button type="button" aria-pressed={filter === 'mine'} className={filter === 'mine' ? 'is-active' : ''} onClick={() => setFilter('mine')}>My check-ins</button><button type="button" aria-pressed={filter === 'family'} className={filter === 'family' ? 'is-active' : ''} onClick={() => setFilter('family')}>Shared with family</button></div>
        {saved && <p className="wellness-success" role="status">{saved}</p>}
        {visible.length === 0 ? <EmptyState icon={<Heart size={25} />} title={filter === 'mine' ? 'A little space to reflect' : 'Room to share, when you’re ready'} description={filter === 'mine' ? 'Your check-ins will gather here, one day at a time.' : 'Only check-ins that someone has chosen to share appear here.'} /> : <div className="stack mood-history-list">{visible.map(record => {
          const option = moodOptions.find(value => value.score === record.data.score);
          const own = record.ownerId === user?.id;
          const member = members.find(value => value.id === record.ownerId);
          return <article key={record.id} className="card mood-history-card"><div className="wellness-row"><div className="mood-history-title"><span className="mood-history-symbol" aria-hidden="true">{option?.symbol ?? '○'}</span><div><h3>{option?.label ?? 'Check-in'}</h3><p className="muted">{!own ? `${member?.name ?? 'Family member'} · ` : ''}{formatDate(record.data.date)}</p></div></div><Badge tone={record.data.shared ? 'green' : 'neutral'}>{record.data.shared ? 'Shared' : 'Private'}</Badge></div>
            {record.data.note && <p className="mood-note">{record.data.note}</p>}
            {own && <div className="mood-history-actions"><Button variant="ghost" size="sm" onClick={() => edit(record)} disabled={busy}><Pencil size={14} aria-hidden="true" />Edit<span className="sr-only"> check-in for {formatDate(record.data.date)}</span></Button><Button variant="ghost" size="sm" onClick={() => { setError(''); setDeleting(record); }} disabled={busy}><Trash2 size={14} aria-hidden="true" />Delete<span className="sr-only"> check-in for {formatDate(record.data.date)}</span></Button></div>}
          </article>;
        })}</div>}
      </section>
    </div>
    <Modal open={Boolean(deleting)} onClose={() => { if (!busy) setDeleting(null); }} title="Delete this check-in?" description="This removes the feeling and note for this day.">{error && <p className="wellness-error" role="alert">{error}</p>}<div className="wellness-actions"><Button variant="secondary" disabled={busy} onClick={() => setDeleting(null)}>Keep check-in</Button><Button variant="danger" busy={busy} onClick={() => void confirmDelete()}>Delete check-in</Button></div></Modal>
  </div>;
}
