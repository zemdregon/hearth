import { useState, type FormEvent } from 'react';
import { CalendarHeart, CalendarPlus, Clock3, Plus } from 'lucide-react';
import type { FamilyEvent, FamilyRecord } from '../../shared/types';
import { daysBetween, formatDate, isValidDate, todayInTimezone } from '../../shared/calendar';
import { useFamily, useRecords } from '../store';
import { Badge, Button, EmptyState, Field, Modal, SectionHeader } from '../components/ui';
import { FamilyActions, FamilyDeleteDialog, FamilyFeedback, FamilyFilters, useFamilyMutation } from './family-ui';
import './family-modules.css';

const eventIcons = [{ emoji: '🎉', label: 'Celebration' }, { emoji: '🎂', label: 'Birthday' }, { emoji: '❤️', label: 'Anniversary' }, { emoji: '✈️', label: 'Trip' }, { emoji: '🏡', label: 'Home' }, { emoji: '🌿', label: 'Something lovely' }, { emoji: '📅', label: 'A date to remember' }];

export function Events() {
  const { timezone, addRecord, updateRecord, deleteRecord } = useFamily();
  const events = useRecords('event');
  const today = todayInTimezone(timezone);
  const mutation = useFamilyMutation();
  const [filter, setFilter] = useState<'upcoming' | 'past' | 'all'>('upcoming');
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<FamilyRecord<'event'> | null>(null);
  const [deleting, setDeleting] = useState<FamilyRecord<'event'> | null>(null);
  const [draft, setDraft] = useState<FamilyEvent>({ title: '', date: today, emoji: '🎉', description: '' });
  const upcoming = events.filter(event => event.data.date >= today).sort((a, b) => a.data.date.localeCompare(b.data.date));
  const past = events.filter(event => event.data.date < today).sort((a, b) => b.data.date.localeCompare(a.data.date));
  const visible = filter === 'upcoming' ? upcoming : filter === 'past' ? past : [...upcoming, ...past];
  const next = upcoming[0];

  function openForm(record?: FamilyRecord<'event'>) {
    mutation.setError(null);
    setEditing(record ?? null);
    setDraft(record ? { ...record.data } : { title: '', date: today, emoji: '🎉', description: '' });
    setFormOpen(true);
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft.title.trim()) { mutation.setError('Give this occasion a name.'); return; }
    if (!isValidDate(draft.date)) { mutation.setError('Choose a valid date.'); return; }
    const data = { ...draft, title: draft.title.trim(), description: draft.description.trim() };
    if (await mutation.perform('save', () => editing ? updateRecord(editing, data) : addRecord('event', data))) setFormOpen(false);
  }

  return <div className="family-module stack">
    <SectionHeader eyebrow="SOMETHING TO LOOK FORWARD TO" title="Our calendar" description="Count the days until your next good memory." action={<Button onClick={() => openForm()}><Plus size={17} aria-hidden="true" />Add an event</Button>} />
    {!formOpen && !deleting && <FamilyFeedback error={mutation.error} />}
    {next && <section className="family-event-hero" aria-label="Next family event"><div><span className="eyebrow">NEXT UP, TOGETHER</span><h2><span aria-hidden="true">{next.data.emoji}</span> {next.data.title}</h2><p>{formatDate(next.data.date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</p>{next.data.description && <p className="family-event-description">{next.data.description}</p>}</div><div className="family-countdown"><strong>{daysBetween(today, next.data.date) === 0 ? 'Today!' : daysBetween(today, next.data.date)}</strong><span>{daysBetween(today, next.data.date) === 0 ? 'The wait is over' : daysBetween(today, next.data.date) === 1 ? 'sleep to go' : 'days to go'}</span></div></section>}
    <FamilyFilters label="Filter events" value={filter} onChange={setFilter} options={[{ value: 'upcoming', label: 'Coming up', count: upcoming.length }, { value: 'past', label: 'Past moments', count: past.length }, { value: 'all', label: 'All events' }]} />
    {visible.length ? <div className="family-event-grid">{visible.map(event => {
      const days = daysBetween(today, event.data.date);
      return <article className={`card family-event-card ${days < 0 ? 'is-past' : ''}`} key={event.id}><div className="family-card-top"><span className="family-event-icon" aria-hidden="true">{event.data.emoji}</span><FamilyActions title={event.data.title} disabled={Boolean(mutation.busy)} onEdit={() => openForm(event)} onDelete={() => { mutation.setError(null); setDeleting(event); }} /></div><h3>{event.data.title}</h3><time className="family-event-date" dateTime={event.data.date}><CalendarHeart size={15} aria-hidden="true" />{formatDate(event.data.date, { month: 'long', day: 'numeric', year: 'numeric' })}</time>{event.data.description && <p className="family-event-description">{event.data.description}</p>}<div className="family-card-bottom"><Badge tone={days === 0 ? 'rose' : days > 0 ? 'green' : 'neutral'}><Clock3 size={13} aria-hidden="true" />{days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : days > 0 ? `In ${days} days` : days === -1 ? 'Yesterday' : `${Math.abs(days)} days ago`}</Badge></div></article>;
    })}</div> : <EmptyState icon={<CalendarPlus size={30} />} title={filter === 'past' ? 'Good memories are on their way' : 'Put something lovely on the horizon'} description={filter === 'past' ? 'Your past family occasions will stay here to look back on.' : 'A birthday, a weekend away, or simply dinner together. Give yourselves something to count down to.'} action={<Button variant="secondary" onClick={() => openForm()}><Plus size={16} />Add an event</Button>} />}
    <Modal open={formOpen} onClose={() => { if (!mutation.busy) setFormOpen(false); }} title={editing ? 'Edit your event' : 'Something to look forward to'} description="Save the date. We'll count the days.">
      <form className="stack" onSubmit={save}>
        <FamilyFeedback error={mutation.error} />
        <fieldset className="family-form-fields stack" disabled={Boolean(mutation.busy)}>
        <Field label="What's the occasion?" id="event-title"><input className="input" id="event-title" required data-autofocus maxLength={200} value={draft.title} placeholder="Our weekend by the sea" onChange={event => setDraft({ ...draft, title: event.target.value })} /></Field>
        <div className="grid-2"><Field label="Date" id="event-date"><input className="input" id="event-date" type="date" required value={draft.date} onChange={event => setDraft({ ...draft, date: event.target.value })} /></Field><Field label="A little symbol" id="event-icon"><select className="input" id="event-icon" value={draft.emoji} onChange={event => setDraft({ ...draft, emoji: event.target.value })}>{!eventIcons.some(icon => icon.emoji === draft.emoji) && <option value={draft.emoji}>{draft.emoji} Current symbol</option>}{eventIcons.map(icon => <option key={icon.emoji} value={icon.emoji}>{icon.emoji} {icon.label}</option>)}</select></Field></div>
        <Field label="A few details" id="event-description" hint="Optional"><textarea className="input" id="event-description" rows={3} maxLength={2000} value={draft.description} placeholder="Plans, places, or a little reminder…" onChange={event => setDraft({ ...draft, description: event.target.value })} /></Field>
        <div className="family-form-actions"><Button type="button" variant="secondary" disabled={Boolean(mutation.busy)} onClick={() => setFormOpen(false)}>Cancel</Button><Button type="submit" busy={mutation.busy === 'save'}>{editing ? 'Save changes' : 'Save event'}</Button></div>
        </fieldset>
      </form>
    </Modal>
    <FamilyDeleteDialog open={Boolean(deleting)} title={deleting?.data.title || ''} busy={mutation.busy === 'delete'} error={mutation.error} onClose={() => setDeleting(null)} onDelete={() => { if (deleting) void mutation.perform('delete', () => deleteRecord(deleting)).then(ok => { if (ok) setDeleting(null); }); }} />
  </div>;
}
