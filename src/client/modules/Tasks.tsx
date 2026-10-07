import { useState, type FormEvent } from 'react';
import { CalendarDays, Check, Circle, ListTodo, Plus, UserRound } from 'lucide-react';
import type { FamilyRecord, Task } from '../../shared/types';
import { formatDate, isValidDate, todayInTimezone } from '../../shared/calendar';
import { useFamily, useRecords } from '../store';
import { Badge, Button, EmptyState, Field, Modal, SectionHeader } from '../components/ui';
import { FamilyActions, FamilyDeleteDialog, FamilyFeedback, FamilyFilters, useFamilyMutation } from './family-ui';
import './family-modules.css';

const emptyTask: Task = { title: '', done: false };

export function Tasks() {
  const { members, timezone, addRecord, updateRecord, deleteRecord } = useFamily();
  const tasks = useRecords('task');
  const today = todayInTimezone(timezone);
  const mutation = useFamilyMutation();
  const [filter, setFilter] = useState<'open' | 'all' | 'done'>('open');
  const [assignee, setAssignee] = useState('all');
  const [editing, setEditing] = useState<FamilyRecord<'task'> | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [draft, setDraft] = useState<Task>(emptyTask);
  const [deleting, setDeleting] = useState<FamilyRecord<'task'> | null>(null);
  const open = tasks.filter(task => !task.data.done);
  const overdue = open.filter(task => task.data.dueDate && task.data.dueDate < today);
  const visible = tasks.filter(task => (filter === 'all' || task.data.done === (filter === 'done')) && (assignee === 'all' || (assignee === 'none' ? !task.data.assigneeId : task.data.assigneeId === assignee))).sort((a, b) => Number(a.data.done) - Number(b.data.done) || (a.data.dueDate || '9999').localeCompare(b.data.dueDate || '9999') || b.createdAt.localeCompare(a.createdAt));

  function openForm(record?: FamilyRecord<'task'>) {
    mutation.setError(null);
    setEditing(record ?? null);
    setDraft(record ? { ...record.data } : { ...emptyTask });
    setFormOpen(true);
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft.title.trim()) { mutation.setError('Give this task a short title.'); return; }
    if (draft.dueDate && !isValidDate(draft.dueDate)) { mutation.setError('Choose a valid due date.'); return; }
    const data = { ...draft, title: draft.title.trim(), dueDate: draft.dueDate || undefined, assigneeId: draft.assigneeId || undefined };
    if (await mutation.perform('save', () => editing ? updateRecord(editing, data) : addRecord('task', data))) setFormOpen(false);
  }

  return <div className="family-module stack">
    <SectionHeader eyebrow="A LITTLE TEAMWORK" title="Shared tasks" description="A lighter load, when you share it." action={<Button onClick={() => openForm()}><Plus size={17} aria-hidden="true" />Add task</Button>} />
    <div className="family-stat-grid">
      <div className="card family-stat"><span className="family-stat-number">{open.length}</span><span>Things to do</span><ListTodo aria-hidden="true" size={20} /></div>
      <div className="card family-stat"><span className="family-stat-number">{tasks.length - open.length}</span><span>Done together</span><Check aria-hidden="true" size={20} /></div>
      <div className="card family-stat"><span className="family-stat-number">{overdue.length}</span><span>Need a little love</span><CalendarDays aria-hidden="true" size={20} /></div>
    </div>
    {!formOpen && !deleting && <FamilyFeedback error={mutation.error} />}
    <div className="family-toolbar">
      <FamilyFilters label="Filter tasks by completion" value={filter} onChange={setFilter} options={[{ value: 'open', label: 'To do', count: open.length }, { value: 'done', label: 'Completed', count: tasks.length - open.length }, { value: 'all', label: 'All tasks' }]} />
      <label className="family-inline-field"><UserRound size={16} aria-hidden="true" /><span className="sr-only">Filter by assignee</span><select className="input" value={assignee} onChange={event => setAssignee(event.target.value)}><option value="all">Everyone</option><option value="none">Unassigned</option>{members.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>
    </div>
    {visible.length ? <div className="card family-task-list">{visible.map(task => {
      const owner = members.find(member => member.id === task.data.assigneeId);
      const late = !task.data.done && task.data.dueDate && task.data.dueDate < today;
      return <article className={`family-task ${task.data.done ? 'is-complete' : ''}`} key={task.id}>
        <button type="button" className="family-check" aria-label={`${task.data.done ? 'Reopen' : 'Complete'} task: ${task.data.title}`} aria-pressed={task.data.done} disabled={Boolean(mutation.busy)} onClick={() => { void mutation.perform(task.id, () => updateRecord(task, { ...task.data, done: !task.data.done })); }}>{task.data.done ? <Check size={19} aria-hidden="true" /> : <Circle size={21} aria-hidden="true" />}</button>
        <div className="family-task-content"><h2>{task.data.title}</h2><div className="family-meta"><span><UserRound size={13} aria-hidden="true" />{owner?.name || 'Anyone can take this'}</span>{task.data.dueDate && <Badge tone={late ? 'rose' : task.data.dueDate === today ? 'amber' : 'neutral'}>{late ? 'Overdue · ' : task.data.dueDate === today ? 'Today · ' : ''}{formatDate(task.data.dueDate, { month: 'short', day: 'numeric', year: 'numeric' })}</Badge>}</div></div>
        <FamilyActions title={task.data.title} disabled={Boolean(mutation.busy)} onEdit={() => openForm(task)} onDelete={() => { mutation.setError(null); setDeleting(task); }} />
      </article>;
    })}</div> : <EmptyState icon={<ListTodo size={28} />} title={tasks.length ? 'A little breathing room' : 'Good things happen together'} description={tasks.length ? 'No tasks match these filters. Enjoy the clear list, or add something new.' : 'Add the errands, little reminders, and everyday jobs you can share.'} action={<Button variant="secondary" onClick={() => openForm()}><Plus size={16} />Add a task</Button>} />}
    <Modal open={formOpen} onClose={() => { if (!mutation.busy) setFormOpen(false); }} title={editing ? 'Edit task' : 'A little thing to do'} description="Make room for the little jobs, so you can get back to the good stuff.">
      <form className="stack" onSubmit={save}>
        <FamilyFeedback error={mutation.error} />
        <fieldset className="family-form-fields stack" disabled={Boolean(mutation.busy)}>
        <Field label="What needs doing?" id="task-title"><input className="input" id="task-title" autoFocus required maxLength={200} value={draft.title} placeholder="Pick up groceries for Sunday" onChange={event => setDraft({ ...draft, title: event.target.value })} /></Field>
        <div className="grid-2"><Field label="Who's on it?" id="task-assignee"><select className="input" id="task-assignee" value={draft.assigneeId || ''} onChange={event => setDraft({ ...draft, assigneeId: event.target.value })}><option value="">Anyone</option>{members.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</select></Field><Field label="Due date" id="task-due" hint="Optional"><input className="input" type="date" id="task-due" value={draft.dueDate || ''} onChange={event => setDraft({ ...draft, dueDate: event.target.value })} /></Field></div>
        <div className="family-form-actions"><Button type="button" variant="secondary" disabled={Boolean(mutation.busy)} onClick={() => setFormOpen(false)}>Cancel</Button><Button type="submit" busy={mutation.busy === 'save'}>{editing ? 'Save changes' : 'Add task'}</Button></div>
        </fieldset>
      </form>
    </Modal>
    <FamilyDeleteDialog open={Boolean(deleting)} title={deleting?.data.title || ''} busy={mutation.busy === 'delete'} error={mutation.error} onClose={() => setDeleting(null)} onDelete={() => { if (deleting) void mutation.perform('delete', () => deleteRecord(deleting)).then(ok => { if (ok) setDeleting(null); }); }} />
  </div>;
}
