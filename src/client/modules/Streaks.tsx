import { useEffect, useRef, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Flame, Plus, Trash2 } from 'lucide-react';
import { useFamily, useRecords } from '../store';
import { Button, EmptyState, Modal, SectionHeader } from '../components/ui';
import { addDays, backfillDates, formatDate, MAX_BACKFILL_DAYS, monthGrid, shiftMonth, streaksForDates, todayInTimezone } from '../../shared/calendar';
import type { FamilyRecord } from '../../shared/types';
import './wellness.css';

const habitColors = ['#2f624b', '#b65f45', '#776388', '#997027', '#426c85'];
/** A backdated habit longer than this many days gets a plain note about how many records it creates. */
const LARGE_BACKFILL_DAYS = 30;
const days = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;
/** Server validation messages can arrive as "field: message"; the person only needs the message. */
const withoutField = (message: string) => message.replace(/^[a-z][\w.[\]]*:\s+/, '');

export function Streaks() {
  const { user, members, timezone, capacity, addRecord, createHabit, deleteRecord } = useFamily();
  const habits = useRecords('habit');
  const logs = useRecords('habitLog');
  const today = todayInTimezone(timezone);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [month, setMonth] = useState(today.slice(0, 7));
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [color, setColor] = useState(habitColors[0]);
  const [startDate, setStartDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [removeHabit, setRemoveHabit] = useState<FamilyRecord<'habit'> | null>(null);
  const previousDay = useRef(today);
  const yesterday = addDays(today, -1);
  const earliestStart = addDays(today, -MAX_BACKFILL_DAYS);
  let startProblem = '';
  let backfillCount = 0;
  if (startDate) try { backfillCount = backfillDates(startDate, today).length; } catch (cause) { startProblem = cause instanceof RangeError ? cause.message : 'Choose a valid start date.'; }
  const selected = habits.find(habit => habit.id === selectedId) ?? habits[0];
  const selectedLogs = logs.filter(log => log.data.habitId === selected?.id);
  const dates = selectedLogs.map(log => log.data.date);
  const completed = new Set(dates);
  const stats = streaksForDates(dates, today);
  const ownHabit = selected?.ownerId === user?.id;
  const owner = members.find(member => member.id === selected?.ownerId);

  useEffect(() => {
    const previousMonth = previousDay.current.slice(0, 7);
    previousDay.current = today;
    setMonth(current => current === previousMonth ? today.slice(0, 7) : current);
  }, [today]);

  async function toggleDate(date: string) {
    if (!selected || !ownHabit || busy || date > today) return;
    setError(''); setBusy(true);
    try {
      const existing = selectedLogs.find(log => log.data.date === date);
      if (existing) await deleteRecord(existing);
      else await addRecord('habitLog', { habitId: selected.id, date });
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'That check-in could not be saved. Please try again.'); }
    finally { setBusy(false); }
  }

  async function submitHabit(event: React.FormEvent) {
    event.preventDefault();
    if (!user || !title.trim() || busy) return;
    setBusy(true); setError('');
    try {
      const record = await createHabit({ title: title.trim(), userId: user.id, color }, startDate || undefined);
      setSelectedId(record.id); setMonth(today.slice(0, 7)); setTitle(''); setStartDate(''); setAdding(false);
    } catch (cause) { setError(cause instanceof Error ? withoutField(cause.message) : 'Your habit could not be saved. Please try again.'); }
    finally { setBusy(false); }
  }

  function closeAdding() {
    if (busy) return;
    setAdding(false); setTitle(''); setStartDate(''); setError('');
  }

  async function confirmDelete() {
    if (!removeHabit) return;
    setBusy(true); setError('');
    try { await deleteRecord(removeHabit); setRemoveHabit(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Your habit could not be deleted. Please try again.'); }
    finally { setBusy(false); }
  }

  return <div className="wellness-page stack">
    <SectionHeader eyebrow="A little, often" title="Every day adds up." description="Small routines, shared encouragement. Make room for the things that matter to you." action={<Button onClick={() => { setError(''); setAdding(true); }}><Plus size={17} aria-hidden="true" /> Add a habit</Button>} />
    {error && !adding && !removeHabit && <p className="wellness-error" role="alert">{error}</p>}
    {habits.length === 0 ? <EmptyState icon={<Flame size={30} />} title="Start with something small" description="A glass of water, a few pages, a little fresh air. Add a habit and check in whenever you do it." action={<Button onClick={() => setAdding(true)}>Create your first habit</Button>} /> : <div className="habit-layout">
      <aside className="stack" aria-label="Family habits">
        <div className="eyebrow">Your family’s routines</div>
        <div className="habit-list">
          {habits.map(habit => {
            const member = members.find(person => person.id === habit.ownerId);
            const streak = streaksForDates(logs.filter(log => log.data.habitId === habit.id).map(log => log.data.date), today);
            return <button type="button" key={habit.id} className={`habit-selector ${selected?.id === habit.id ? 'is-selected' : ''}`} aria-pressed={selected?.id === habit.id} onClick={() => { setSelectedId(habit.id); setError(''); }}>
              <span className="habit-color" style={{ backgroundColor: habit.data.color }} aria-hidden="true"><Flame size={19} /></span>
              <span className="habit-label"><strong>{habit.data.title}</strong><span>{habit.ownerId === user?.id ? 'You' : member?.name ?? 'Family member'}</span></span>
              <span className="habit-mini-streak" aria-label={`${streak.current} day current streak`}>{streak.current}<small>{streak.current === 1 ? 'day' : 'days'}</small></span>
            </button>;
          })}
        </div>
        <div className="habit-encouragement"><span className="eyebrow">Keep coming back</span><p>A missed day is just a day. You can always begin again.</p></div>
      </aside>
      {selected && <section className="card habit-detail" aria-label={`${selected.data.title} calendar`}>
        <div className="wellness-row"><div><p className="eyebrow">{ownHabit ? 'Your routine' : `${owner?.name ?? 'Family member'}’s routine`}</p><h2>{selected.data.title}</h2></div>{ownHabit && <Button variant="ghost" aria-label={`Delete ${selected.data.title}`} onClick={() => { setError(''); setRemoveHabit(selected); }}><Trash2 size={17} /></Button>}</div>
        <div className="streak-stats">
          <div><span className="streak-stat-number"><Flame size={22} aria-hidden="true" />{stats.current}</span><span>Current streak</span></div>
          <div><span className="streak-stat-number">{stats.longest}</span><span>Longest streak</span></div>
          <div><span className="streak-stat-number">{stats.total}</span><span>Days checked in</span></div>
        </div>
        <div className="calendar-heading"><h3>{formatDate(`${month}-01`, { month: 'long', year: 'numeric' })}</h3><div className="wellness-row"><Button variant="ghost" aria-label="Previous month" onClick={() => setMonth(shiftMonth(month, -1))}><ChevronLeft size={19} /></Button><Button variant="ghost" size="sm" onClick={() => setMonth(today.slice(0, 7))}>Today</Button><Button variant="ghost" aria-label="Next month" disabled={month >= today.slice(0, 7)} onClick={() => setMonth(shiftMonth(month, 1))}><ChevronRight size={19} /></Button></div></div>
        <div className="habit-calendar" aria-label="Monthly check-ins">
          {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(day => <span className="calendar-weekday" key={day}>{day}</span>)}
          {monthGrid(month).map((date, index) => date ? <button type="button" key={date} className={`calendar-day ${completed.has(date) ? 'is-complete' : ''} ${date === today ? 'is-today' : ''}`} disabled={!ownHabit || date > today || busy} aria-pressed={completed.has(date)} aria-current={date === today ? 'date' : undefined} aria-label={`${formatDate(date)}${completed.has(date) ? ', checked in' : ', not checked in'}${ownHabit && date <= today ? ', click to toggle' : ''}`} onClick={() => void toggleDate(date)}>
            <span>{Number(date.slice(-2))}</span>{completed.has(date) && <Check size={15} aria-hidden="true" />}
          </button> : <span className="calendar-blank" key={`blank-${index}`} />)}
        </div>
        <div className="calendar-legend"><span><span className="legend-dot" /> Checked in</span><span>Dates in {timezone.replaceAll('_', ' ')}</span></div>
        {ownHabit ? <div className="habit-checkin"><Button busy={busy} variant={completed.has(today) ? 'secondary' : 'primary'} onClick={() => void toggleDate(today)}><Check size={17} aria-hidden="true" />{completed.has(today) ? 'Checked in today · undo' : 'Check in for today'}</Button><p className="muted">You can also select a past day. Your streak stays active through today if you checked in yesterday.</p></div> : <p className="muted habit-view-note">You’re cheering {owner?.name ?? 'your family member'} on. Only they can change their check-ins.</p>}
      </section>}
    </div>}
    <Modal open={adding} onClose={closeAdding} title="One small habit" description="Pick a routine you want to make a little more room for.">
      <form className="stack" onSubmit={event => void submitHabit(event)}>
        <fieldset className="wellness-form-fields stack" disabled={busy}>
        <label className="field">Habit name<input className="input" data-autofocus required maxLength={120} value={title} onChange={event => setTitle(event.target.value)} placeholder="Read a few pages" /></label>
        <fieldset className="wellness-fieldset"><legend>Choose a color</legend><div className="habit-colors">{habitColors.map((value, index) => <label key={value} className="habit-color-choice" style={{ backgroundColor: value }}><input type="radio" name="habit-color" value={value} checked={color === value} onChange={() => setColor(value)} /><span className="sr-only">{['Forest', 'Terracotta', 'Lavender', 'Ochre', 'Blue'][index]}</span>{color === value && <Check size={20} aria-hidden="true" />}</label>)}</div></fieldset>
        <label className="field">Already doing this? <span className="muted">(optional)</span>
          <input className="input" type="date" name="habit-start" value={startDate} min={earliestStart} max={yesterday} onChange={event => setStartDate(event.target.value)} aria-describedby={backfillCount > LARGE_BACKFILL_DAYS ? 'habit-start-help habit-start-records' : 'habit-start-help'} aria-invalid={Boolean(startProblem)} />
        </label>
        <p className={startProblem ? 'wellness-error' : 'muted'} id="habit-start-help" role={startProblem ? 'alert' : undefined}>{startProblem || (backfillCount ? `Counts ${days(backfillCount)} as checked in, ${backfillCount === 1 ? formatDate(startDate) : `${formatDate(startDate)} through ${formatDate(yesterday)}`}. You can uncheck any day afterward.` : `Pick the day you began and every day through yesterday will count toward your streak. Up to ${MAX_BACKFILL_DAYS} days back.`)}</p>
        {backfillCount > LARGE_BACKFILL_DAYS && <p className="muted" id="habit-start-records">This adds one check-in record for each day.</p>}
        {backfillCount > LARGE_BACKFILL_DAYS && (capacity === 'near-limit' || capacity === 'full') && <p className="wellness-notice" role="status">{capacity === 'full' ? 'Your family space has reached a storage limit, so a long backdate may not fit.' : 'Your family space is nearly full, so a long backdate may not fit.'}</p>}
        <p className="muted">Your family can see your progress. Only you can mark your days.</p>
        {error && <p className="wellness-error" role="alert">{error}</p>}
        <Button type="submit" busy={busy} disabled={!title.trim() || Boolean(startProblem)}>Create habit</Button>
        </fieldset>
      </form>
    </Modal>
    <Modal open={Boolean(removeHabit)} onClose={() => { if (!busy) setRemoveHabit(null); }} title="Delete this habit?" description={`This removes “${removeHabit?.data.title ?? ''}” and its check-in history.`}>
      {error && <p className="wellness-error" role="alert">{error}</p>}<div className="wellness-actions"><Button variant="secondary" disabled={busy} onClick={() => setRemoveHabit(null)}>Keep habit</Button><Button variant="danger" busy={busy} onClick={() => void confirmDelete()}>Delete habit</Button></div>
    </Modal>
  </div>;
}
