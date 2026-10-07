import { useState, type FormEvent } from 'react';
import { CalendarDays, Heart, MessageSquareText, Plus, Quote } from 'lucide-react';
import type { FamilyRecord, Note } from '../../shared/types';
import { formatDate, isValidDate, todayInTimezone } from '../../shared/calendar';
import { useFamily, useRecords } from '../store';
import { Badge, Button, EmptyState, Field, Modal, SectionHeader } from '../components/ui';
import { FamilyActions, FamilyDeleteDialog, FamilyFeedback, useFamilyMutation } from './family-ui';
import './family-modules.css';

export function Notes() {
  const { members, timezone, addRecord, updateRecord, deleteRecord } = useFamily();
  const notes = useRecords('note');
  const today = todayInTimezone(timezone);
  const mutation = useFamilyMutation();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<FamilyRecord<'note'> | null>(null);
  const [draft, setDraft] = useState<Note>({ text: '', date: today });
  const [deleting, setDeleting] = useState<FamilyRecord<'note'> | null>(null);
  const [query, setQuery] = useState('');
  const todaysNotes = notes.filter(note => note.data.date === today).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const history = notes.filter(note => note.data.date !== today && note.data.text.toLocaleLowerCase().includes(query.toLocaleLowerCase())).sort((a, b) => b.data.date.localeCompare(a.data.date) || b.createdAt.localeCompare(a.createdAt));
  const groups = new Map<string, FamilyRecord<'note'>[]>();
  history.forEach(note => groups.set(note.data.date, [...(groups.get(note.data.date) || []), note]));

  function openForm(record?: FamilyRecord<'note'>) {
    mutation.setError(null);
    setEditing(record ?? null);
    setDraft(record ? { ...record.data } : { text: '', date: today });
    setFormOpen(true);
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft.text.trim()) { mutation.setError('Write a little something before saving your note.'); return; }
    if (!isValidDate(draft.date)) { mutation.setError('Choose a valid date for your note.'); return; }
    const data = { ...draft, text: draft.text.trim() };
    if (await mutation.perform('save', () => editing ? updateRecord(editing, data) : addRecord('note', data))) setFormOpen(false);
  }
  function noteCard(note: FamilyRecord<'note'>, featured = false) {
    return <article className={featured ? 'family-note-featured' : 'card family-note'} key={note.id}>
      <Quote className="family-note-quote" size={featured ? 26 : 18} aria-hidden="true" />
      <p className="family-note-text">{note.data.text}</p>
      <div className="family-note-footer"><span className="family-note-author">A note from {members.find(member => member.id === note.ownerId)?.name || 'your family'}</span><FamilyActions title="note" disabled={Boolean(mutation.busy)} onEdit={() => openForm(note)} onDelete={() => { mutation.setError(null); setDeleting(note); }} /></div>
    </article>;
  }

  return <div className="family-module stack">
    <SectionHeader eyebrow="WORDS TO COME HOME TO" title="Little notes" description="The big feelings, the small reminders, and everything between." action={<Button onClick={() => openForm()}><Plus size={17} aria-hidden="true" />Write a note</Button>} />
    {!formOpen && !deleting && <FamilyFeedback error={mutation.error} />}
    <section className="family-note-today" aria-labelledby="notes-today-title">
      <div className="family-section-line"><h2 id="notes-today-title"><Heart size={19} aria-hidden="true" />Today's notes</h2><span>{formatDate(today, { weekday: 'long', month: 'long', day: 'numeric' })}</span></div>
      {todaysNotes.length ? <div className="stack">{todaysNotes.map(note => noteCard(note, true))}</div> : <div className="family-note-blank"><Quote size={30} aria-hidden="true" /><h3>A few words can make a whole day.</h3><p>Leave something kind, funny, or useful for your family.</p><Button variant="secondary" onClick={() => openForm()}>Write today's first note</Button></div>}
    </section>
    <div className="family-section-line family-history-heading"><h2><MessageSquareText size={19} aria-hidden="true" />The note collection</h2><label className="family-search"><span className="sr-only">Search note history</span><input type="search" className="input" placeholder="Find a little memory…" value={query} onChange={event => setQuery(event.target.value)} /></label></div>
    {groups.size ? [...groups.entries()].map(([date, records]) => <section className="stack family-note-group" key={date} aria-label={`Notes for ${formatDate(date)}`}><div className="family-note-date"><CalendarDays size={15} aria-hidden="true" /><time dateTime={date}>{formatDate(date, { weekday: 'short', month: 'long', day: 'numeric', year: 'numeric' })}</time>{date > today && <Badge tone="amber">Coming up</Badge>}</div><div className="family-notes-grid">{records.map(note => noteCard(note))}</div></section>) : <EmptyState icon={<MessageSquareText size={27} />} title={query ? 'No notes found' : 'Your little archive starts here'} description={query ? 'Try another word or clear your search.' : 'Notes from other days will be kept here, ready to revisit.'} action={query ? <Button variant="secondary" onClick={() => setQuery('')}>Clear search</Button> : undefined} />}
    <Modal open={formOpen} onClose={() => { if (!mutation.busy) setFormOpen(false); }} title={editing ? 'Edit your note' : 'Leave a little note'} description="A moment of your day, saved for the people you love.">
      <form className="stack" onSubmit={save}>
        <FamilyFeedback error={mutation.error} />
        <fieldset className="family-form-fields stack" disabled={Boolean(mutation.busy)}>
        <Field label="Your note" id="note-text" hint={`${draft.text.length}/5,000 characters`}><textarea className="input" id="note-text" required autoFocus maxLength={5000} rows={6} placeholder="Just wanted to say…" value={draft.text} onChange={event => setDraft({ ...draft, text: event.target.value })} /></Field>
        <Field label="Date" id="note-date" hint="Save a memory from another day, or leave a note for a day ahead."><input type="date" className="input" id="note-date" required value={draft.date} onChange={event => setDraft({ ...draft, date: event.target.value })} /></Field>
        <div className="family-form-actions"><Button type="button" variant="secondary" disabled={Boolean(mutation.busy)} onClick={() => setFormOpen(false)}>Cancel</Button><Button type="submit" busy={mutation.busy === 'save'}>{editing ? 'Save changes' : 'Save note'}</Button></div>
        </fieldset>
      </form>
    </Modal>
    <FamilyDeleteDialog open={Boolean(deleting)} title={deleting ? deleting.data.text.slice(0, 70) + (deleting.data.text.length > 70 ? '…' : '') : ''} busy={mutation.busy === 'delete'} error={mutation.error} onClose={() => setDeleting(null)} onDelete={() => { if (deleting) void mutation.perform('delete', () => deleteRecord(deleting)).then(ok => { if (ok) setDeleting(null); }); }} />
  </div>;
}
