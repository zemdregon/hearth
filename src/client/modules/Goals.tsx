import { useState, type FormEvent } from 'react';
import { CalendarDays, Check, Flag, Mountain, Plus, Sprout, Trash2, Trophy } from 'lucide-react';
import type { FamilyRecord, Goal } from '../../shared/types';
import { formatDate, isValidDate, todayInTimezone } from '../../shared/calendar';
import { useFamily, useRecords } from '../store';
import { Badge, Button, EmptyState, Field, Modal, SectionHeader } from '../components/ui';
import { FamilyActions, FamilyDeleteDialog, FamilyFeedback, FamilyFilters, useFamilyMutation } from './family-ui';
import './family-modules.css';

const newGoal = (): Goal => ({ title: '', description: '', milestones: [], completed: false });

export function Goals() {
  const { timezone, addRecord, updateRecord, deleteRecord } = useFamily();
  const goals = useRecords('goal');
  const today = todayInTimezone(timezone);
  const mutation = useFamilyMutation();
  const [filter, setFilter] = useState<'active' | 'completed' | 'all'>('active');
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<FamilyRecord<'goal'> | null>(null);
  const [deleting, setDeleting] = useState<FamilyRecord<'goal'> | null>(null);
  const [draft, setDraft] = useState<Goal>(newGoal);
  const active = goals.filter(goal => !goal.data.completed);
  const visible = goals.filter(goal => filter === 'all' || goal.data.completed === (filter === 'completed')).sort((a, b) => Number(a.data.completed) - Number(b.data.completed) || (a.data.targetDate || '9999').localeCompare(b.data.targetDate || '9999') || b.createdAt.localeCompare(a.createdAt));
  const milestoneCount = goals.reduce((total, goal) => total + goal.data.milestones.filter(milestone => milestone.done).length, 0);

  function openForm(record?: FamilyRecord<'goal'>) {
    mutation.setError(null);
    setEditing(record ?? null);
    setDraft(record ? { ...record.data, milestones: record.data.milestones.map(milestone => ({ ...milestone })) } : newGoal());
    setFormOpen(true);
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft.title.trim()) { mutation.setError('Give your shared goal a name.'); return; }
    if (draft.targetDate && !isValidDate(draft.targetDate)) { mutation.setError('Choose a valid target date, or leave it blank.'); return; }
    const emptyMilestone = draft.milestones.findIndex(milestone => !milestone.title.trim());
    if (emptyMilestone >= 0) { mutation.setError(`Give milestone ${emptyMilestone + 1} a name, or remove it.`); return; }
    const data: Goal = { ...draft, title: draft.title.trim(), description: draft.description.trim(), targetDate: draft.targetDate || undefined, milestones: draft.milestones.map(milestone => ({ ...milestone, title: milestone.title.trim() })), completed: draft.completed && draft.milestones.every(milestone => milestone.done) };
    if (await mutation.perform('save', () => editing ? updateRecord(editing, data) : addRecord('goal', data))) setFormOpen(false);
  }
  function toggleMilestone(goal: FamilyRecord<'goal'>, id: string) {
    const milestones = goal.data.milestones.map(milestone => milestone.id === id ? { ...milestone, done: !milestone.done } : milestone);
    void mutation.perform(`${goal.id}-${id}`, () => updateRecord(goal, { ...goal.data, milestones, completed: milestones.every(milestone => milestone.done) }));
  }
  function toggleGoal(goal: FamilyRecord<'goal'>) {
    void mutation.perform(goal.id, () => updateRecord(goal, { ...goal.data, completed: !goal.data.completed, milestones: goal.data.completed ? goal.data.milestones : goal.data.milestones.map(milestone => ({ ...milestone, done: true })) }));
  }

  return <div className="family-module stack">
    <SectionHeader eyebrow="GROWING IN THE SAME DIRECTION" title="Our bigger dreams" description="Make a little progress toward the life you want together." action={<Button onClick={() => openForm()}><Plus size={17} aria-hidden="true" />Add a goal</Button>} />
    {!formOpen && !deleting && <FamilyFeedback error={mutation.error} />}
    <div className="family-goals-intro"><div className="family-goal-intro-icon"><Mountain size={31} strokeWidth={1.5} aria-hidden="true" /></div><div><h2>Big dreams. Small steps.</h2><p>{active.length ? `${active.length} ${active.length === 1 ? 'dream' : 'dreams'} in motion` : 'Every shared dream begins somewhere'}{milestoneCount > 0 ? ` · ${milestoneCount} ${milestoneCount === 1 ? 'milestone' : 'milestones'} reached together` : '. A small step is still a step.'}</p></div></div>
    <FamilyFilters label="Filter goals" value={filter} onChange={setFilter} options={[{ value: 'active', label: 'In progress', count: active.length }, { value: 'completed', label: 'Achieved', count: goals.length - active.length }, { value: 'all', label: 'All goals' }]} />
    {visible.length ? <div className="family-goal-grid">{visible.map(goal => {
      const reached = goal.data.milestones.filter(milestone => milestone.done).length;
      const total = goal.data.milestones.length;
      const percentage = goal.data.completed ? 100 : total ? Math.round(reached / total * 100) : 0;
      return <article className={`card family-goal ${goal.data.completed ? 'is-complete' : ''}`} key={goal.id}>
        <div className="family-card-top"><span className="family-goal-symbol">{goal.data.completed ? <Trophy size={23} aria-hidden="true" /> : <Sprout size={23} aria-hidden="true" />}</span><FamilyActions title={goal.data.title} disabled={Boolean(mutation.busy)} onEdit={() => openForm(goal)} onDelete={() => { mutation.setError(null); setDeleting(goal); }} /></div>
        <h3>{goal.data.title}</h3>{goal.data.description && <p className="family-goal-description">{goal.data.description}</p>}
        <div className="family-goal-status">{goal.data.completed ? <Badge tone="green"><Check size={13} aria-hidden="true" />Achieved together</Badge> : <Badge tone="neutral">A work in progress</Badge>}{goal.data.targetDate && <span className={goal.data.targetDate < today && !goal.data.completed ? 'family-late' : 'muted'}><CalendarDays size={14} aria-hidden="true" />{goal.data.targetDate < today && !goal.data.completed ? 'Target was ' : 'Target: '}{formatDate(goal.data.targetDate)}</span>}</div>
        <div className="family-progress-label"><span>{total ? `${reached} of ${total} milestones` : goal.data.completed ? 'You made it' : 'One step at a time'}</span><strong>{percentage}%</strong></div><progress className="family-progress" value={percentage} max={100} aria-label={`Progress toward ${goal.data.title}`}>{percentage}%</progress>
        {total > 0 && <ul className="family-milestones">{goal.data.milestones.map(milestone => <li key={milestone.id}><label className={milestone.done ? 'is-done' : ''}><input type="checkbox" checked={milestone.done} disabled={Boolean(mutation.busy)} onChange={() => toggleMilestone(goal, milestone.id)} /><span>{milestone.title}</span></label></li>)}</ul>}
        <div className="family-card-bottom"><Button variant="secondary" size="sm" disabled={Boolean(mutation.busy)} onClick={() => toggleGoal(goal)}>{goal.data.completed ? 'Reopen goal' : reached < total ? 'Complete goal & milestones' : 'Complete goal'}</Button></div>
      </article>;
    })}</div> : <EmptyState icon={<Flag size={30} />} title={filter === 'completed' ? 'Your future victories live here' : 'What do you dream of doing together?'} description={filter === 'completed' ? 'Every finished goal is something worth remembering.' : 'Save for a trip, make a home, learn something new. Start with a dream and add a few small steps.'} action={<Button variant="secondary" onClick={() => openForm()}><Plus size={16} />Add a shared goal</Button>} />}
    <Modal open={formOpen} onClose={() => { if (!mutation.busy) setFormOpen(false); }} title={editing ? 'Shape your shared goal' : 'A dream to grow together'} description="You don't need the whole plan. Start with a little direction.">
      <form className="stack" onSubmit={save}>
        <FamilyFeedback error={mutation.error} />
        <fieldset className="family-form-fields stack" disabled={Boolean(mutation.busy)}>
        <Field label="What are you dreaming of?" id="goal-title"><input className="input" id="goal-title" required data-autofocus maxLength={200} value={draft.title} placeholder="Our first big adventure together" onChange={event => setDraft({ ...draft, title: event.target.value })} /></Field>
        <Field label="What makes it meaningful?" id="goal-description" hint="Optional"><textarea className="input" id="goal-description" rows={3} maxLength={2000} value={draft.description} placeholder="A few words about the dream…" onChange={event => setDraft({ ...draft, description: event.target.value })} /></Field>
        <Field label="A date to aim for" id="goal-date" hint="Optional. Dreams don't always need a deadline."><input className="input" id="goal-date" type="date" value={draft.targetDate || ''} onChange={event => setDraft({ ...draft, targetDate: event.target.value })} /></Field>
        <fieldset className="family-milestone-editor"><legend>Small steps along the way</legend><p className="muted">Optional milestones. Checking them all off completes your goal.</p>{draft.milestones.map((milestone, index) => <div className="family-milestone-input" key={milestone.id}><label className="sr-only" htmlFor={`milestone-${milestone.id}`}>Milestone {index + 1}</label><span aria-hidden="true">{index + 1}</span><input className="input" id={`milestone-${milestone.id}`} required maxLength={200} value={milestone.title} placeholder="One small step…" onChange={event => setDraft({ ...draft, milestones: draft.milestones.map(item => item.id === milestone.id ? { ...item, title: event.target.value } : item) })} /><Button type="button" variant="ghost" aria-label={`Remove milestone ${index + 1}`} onClick={() => setDraft({ ...draft, milestones: draft.milestones.filter(item => item.id !== milestone.id) })}><Trash2 size={16} aria-hidden="true" /></Button></div>)}<Button type="button" variant="ghost" size="sm" disabled={draft.milestones.length >= 100} onClick={() => setDraft({ ...draft, milestones: [...draft.milestones, { id: crypto.randomUUID(), title: '', done: false }] })}><Plus size={15} aria-hidden="true" />Add a milestone</Button></fieldset>
        <div className="family-form-actions"><Button type="button" variant="secondary" disabled={Boolean(mutation.busy)} onClick={() => setFormOpen(false)}>Cancel</Button><Button type="submit" busy={mutation.busy === 'save'}>{editing ? 'Save changes' : 'Save goal'}</Button></div>
        </fieldset>
      </form>
    </Modal>
    <FamilyDeleteDialog open={Boolean(deleting)} title={deleting?.data.title || ''} busy={mutation.busy === 'delete'} error={mutation.error} onClose={() => setDeleting(null)} onDelete={() => { if (deleting) void mutation.perform('delete', () => deleteRecord(deleting)).then(ok => { if (ok) setDeleting(null); }); }} />
  </div>;
}
