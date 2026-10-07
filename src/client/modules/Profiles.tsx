import { useState, type FormEvent } from 'react';
import { Heart, Lightbulb, MessageCircleHeart, Pencil, Sparkles, UserRound } from 'lucide-react';
import type { FamilyRecord, Profile } from '../../shared/types';
import { formatDate } from '../../shared/calendar';
import { questionById } from '../../shared/questions';
import { answerPairComplete, sameQuestionPair } from '../../shared/question-pairing';
import { useFamily, useRecords } from '../store';
import { Badge, Button, EmptyState, Field, Modal, SectionHeader } from '../components/ui';
import { avatarTextColor, FamilyFeedback, linesToList, personInitials, useFamilyMutation } from './family-ui';
import './family-modules.css';

export function Profiles() {
  const { user, members, questionPair, addRecord, updateRecord } = useFamily();
  const profiles = useRecords('profile');
  const answers = useRecords('answer');
  const mutation = useFamilyMutation();
  const [selectedId, setSelectedId] = useState(user.id);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<FamilyRecord<'profile'> | null>(null);
  const [draft, setDraft] = useState({ bio: '', loves: '', suggestions: '' });
  const selected = members.find(member => member.id === selectedId) || members.find(member => member.id === user.id) || user;
  const own = selected.id === user.id;
  const profile = profiles.find(record => record.ownerId === selected.id);
  const ownProfile = profiles.find(record => record.ownerId === user.id);
  // Nonowners receive only released opt-ins; their snapshot can legitimately
  // omit the other partner's private answer, so trust server release for them.
  const sharedAnswers = answers.filter(answer => answer.ownerId === selected.id && answer.data.shareToProfile && sameQuestionPair(answer.data.participantIds, questionPair) && (!own || answerPairComplete(answer, answers, questionPair)) && questionById(answer.data.questionId)?.choices[answer.data.choice] !== undefined).sort((a, b) => b.data.date.localeCompare(a.data.date));
  const pendingPreferences = own ? answers.filter(answer => answer.ownerId === user.id && answer.data.shareToProfile && sameQuestionPair(answer.data.participantIds, questionPair) && !answerPairComplete(answer, answers, questionPair)).length : 0;
  const preferences = sharedAnswers.filter((answer, index) => sharedAnswers.findIndex(item => item.data.questionId === answer.data.questionId) === index);

  function openForm() {
    mutation.setError(null);
    setEditing(ownProfile ?? null);
    setDraft({ bio: ownProfile?.data.bio || '', loves: (ownProfile?.data.loves || []).join('\n'), suggestions: (ownProfile?.data.suggestions || []).join('\n') });
    setFormOpen(true);
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    const data: Profile = { bio: draft.bio.trim(), loves: linesToList(draft.loves), suggestions: linesToList(draft.suggestions) };
    if (data.loves.length > 30 || data.suggestions.length > 30) { mutation.setError('Keep each list to 30 items or fewer.'); return; }
    if (data.loves.some(item => item.length > 200)) { mutation.setError('Keep each thing you love to 200 characters or fewer.'); return; }
    if (data.suggestions.some(item => item.length > 500)) { mutation.setError('Keep each suggestion to 500 characters or fewer.'); return; }
    if (await mutation.perform('save', () => editing ? updateRecord(editing, data) : addRecord('profile', data))) setFormOpen(false);
  }

  return <div className="family-module stack">
    <SectionHeader eyebrow="THE PEOPLE WHO MAKE IT HOME" title="Our people" description="Keep learning the little things about each other." action={<Button variant="secondary" onClick={openForm}><Pencil size={16} aria-hidden="true" />Edit my profile</Button>} />
    {!formOpen && <FamilyFeedback error={mutation.error} />}
    <div className="family-people" role="group" aria-label="Choose a family member">{members.map(member => <button type="button" key={member.id} className={`family-person ${member.id === selected.id ? 'is-selected' : ''}`} aria-pressed={member.id === selected.id} onClick={() => setSelectedId(member.id)}><span className="family-avatar" style={{ backgroundColor: member.color, color: avatarTextColor(member.color) }}>{personInitials(member.name)}</span><span>{member.name}{member.id === user.id && <small>You</small>}</span></button>)}</div>
    <section className="card family-profile-header" aria-label={`${selected.name}'s profile`}><span className="family-avatar family-avatar-large" style={{ backgroundColor: selected.color, color: avatarTextColor(selected.color) }}>{personInitials(selected.name)}</span><div><div className="family-profile-name"><h2>{selected.name}</h2>{own && <Badge tone="green">Your profile</Badge>}</div>{profile?.data.bio ? <p className="family-profile-bio">{profile.data.bio}</p> : <p className="muted">{own ? 'A few words about you can help your family know you a little better.' : `${selected.name} hasn't added a bio yet. There is always more to discover.`}</p>}</div></section>
    <div className="grid-2">
      <section className="card family-profile-section"><h3><Heart size={19} aria-hidden="true" />Little things {own ? 'I' : 'they'} love</h3>{profile?.data.loves.length ? <div className="family-love-list">{profile.data.loves.map(love => <span key={love} className="family-love">{love}</span>)}</div> : <div className="family-profile-empty"><Heart size={25} aria-hidden="true" /><p>{own ? 'Favorite foods, small comforts, hobbies, places. What makes you happy?' : 'Their favorite things will appear here when they add them.'}</p>{own && <Button variant="ghost" size="sm" onClick={openForm}>Add your favorites</Button>}</div>}</section>
      <section className="card family-profile-section"><h3><Lightbulb size={19} aria-hidden="true" />Thoughtful little ideas</h3><p className="muted family-profile-hint">{own ? 'Ways your family can make your day.' : `Ways to make ${selected.name}'s day.`}</p>{profile?.data.suggestions.length ? <ul className="family-suggestions">{profile.data.suggestions.map(suggestion => <li key={suggestion}><Sparkles size={15} aria-hidden="true" /><span>{suggestion}</span></li>)}</ul> : <div className="family-profile-empty"><Lightbulb size={25} aria-hidden="true" /><p>{own ? 'A gift idea, a date you would enjoy, or a small way someone could help.' : 'A little space for their wishes and suggestions.'}</p>{own && <Button variant="ghost" size="sm" onClick={openForm}>Share an idea</Button>}</div>}</section>
    </div>
    <section className="stack" aria-labelledby="profile-preferences"><div className="family-section-line"><h2 id="profile-preferences"><MessageCircleHeart size={20} aria-hidden="true" />Getting to know {own ? 'me' : selected.name}</h2><Badge>{preferences.length} shared {preferences.length === 1 ? 'answer' : 'answers'}</Badge></div><p className="muted family-profile-disclosure">Preferences {own ? 'you have' : `${selected.name} has`} chosen to share with the whole family after both partners answered.</p>{pendingPreferences > 0 && <p className="wellness-notice" role="status">{pendingPreferences} {pendingPreferences === 1 ? 'preference is' : 'preferences are'} waiting for your partner before appearing on your family profile.</p>}{preferences.length ? <div className="grid-2">{preferences.map(answer => {
      const question = questionById(answer.data.questionId)!;
      return <article className="card family-preference" key={answer.id}><span className="family-preference-label">{question.profileLabel}</span><p>{question.choices[answer.data.choice]}</p><time dateTime={answer.data.date}>Shared {formatDate(answer.data.date)}</time></article>;
    })}</div> : <EmptyState icon={<UserRound size={27} />} title="There is always more to discover" description={own ? 'When you answer a daily question, you can choose to add your answer to your profile.' : 'Only answers your family member chooses to share will appear here.'} />}</section>
    <Modal open={formOpen} onClose={() => { if (!mutation.busy) setFormOpen(false); }} title="A little more about you" description="Your profile is visible to your family. Share as much or as little as you like.">
      <form className="stack" onSubmit={save}>
        <FamilyFeedback error={mutation.error} />
        <fieldset className="family-form-fields stack" disabled={Boolean(mutation.busy)}>
        <Field label="A few words about you" id="profile-bio"><textarea className="input" id="profile-bio" autoFocus rows={3} maxLength={2000} value={draft.bio} placeholder="Usually found with a book and a cup of tea…" onChange={event => setDraft({ ...draft, bio: event.target.value })} /></Field>
        <Field label="Little things you love" id="profile-loves" hint="One per line. Up to 30 things, 200 characters each."><textarea className="input" id="profile-loves" rows={4} maxLength={6029} value={draft.loves} placeholder={'Sunday pancakes\nLong walks\nFresh flowers'} onChange={event => setDraft({ ...draft, loves: event.target.value })} /></Field>
        <Field label="Thoughtful little ideas" id="profile-suggestions" hint="One per line. Up to 30 ideas, 500 characters each."><textarea className="input" id="profile-suggestions" rows={4} maxLength={15029} value={draft.suggestions} placeholder={'Plan a picnic together\nA quiet evening with no plans'} onChange={event => setDraft({ ...draft, suggestions: event.target.value })} /></Field>
        <div className="family-form-actions"><Button type="button" variant="secondary" disabled={Boolean(mutation.busy)} onClick={() => setFormOpen(false)}>Cancel</Button><Button type="submit" busy={mutation.busy === 'save'}>Save my profile</Button></div>
        </fieldset>
      </form>
    </Modal>
  </div>;
}
