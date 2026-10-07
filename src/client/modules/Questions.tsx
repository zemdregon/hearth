import { useEffect, useRef, useState } from 'react';
import { Check, HeartHandshake, LockKeyhole, RefreshCw, Sparkles, Trash2, Users } from 'lucide-react';
import { useFamily, useRecords } from '../store';
import { Badge, Button, EmptyState, Modal, SectionHeader } from '../components/ui';
import { formatDate, todayInTimezone } from '../../shared/calendar';
import { questionById, questionForDate } from '../../shared/questions';
import { answerPairComplete, sameQuestionPair } from '../../shared/question-pairing';
import type { FamilyRecord, QuestionPair } from '../../shared/types';
import './wellness.css';

export function Questions() {
  const { user, members, timezone, questionPair, addRecord, updateRecord, deleteRecord, refresh } = useFamily();
  const answers = useRecords('answer');
  const today = todayInTimezone(timezone);
  const question = questionForDate(today);
  const paired = Boolean(questionPair?.includes(user.id));
  const partner = members.find(member => questionPair?.includes(member.id) && member.id !== user.id);
  const pairMembers = members.filter(member => questionPair?.includes(member.id));
  // Profile-only answers received from other household members aren't part of this conversation.
  const conversation = answers.filter(answer => answer.ownerId === user.id || (paired && sameQuestionPair(answer.data.participantIds, questionPair)));
  const todayAnswers = conversation.filter(answer => answer.data.date === today && answer.data.questionId === question.id && sameQuestionPair(answer.data.participantIds, questionPair));
  const ownAnswer = todayAnswers.find(answer => answer.ownerId === user.id);
  const previousPairAnswer = conversation.find(answer => answer.ownerId === user.id && answer.data.date === today && !sameQuestionPair(answer.data.participantIds, questionPair));
  const allAnswered = Boolean(ownAnswer && answerPairComplete(ownAnswer, answers, questionPair));
  const [choice, setChoice] = useState<number | null>(ownAnswer?.data.choice ?? null);
  const [shareToProfile, setShareToProfile] = useState(ownAnswer?.data.shareToProfile ?? false);
  const [editing, setEditing] = useState<FamilyRecord<'answer'> | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [deleting, setDeleting] = useState<FamilyRecord<'answer'> | null>(null);
  const [historyLimit, setHistoryLimit] = useState(20);
  const previousDay = useRef(today);
  const pairKey = JSON.stringify(questionPair);
  const previousPair = useRef(pairKey);
  const draftPair = useRef<QuestionPair | null>(questionPair ? [...questionPair] : null);

  useEffect(() => {
    const newDay = previousDay.current !== today;
    const newPair = previousPair.current !== pairKey;
    previousDay.current = today; previousPair.current = pairKey;
    // A changed audience clears drafts and consent; ordinary concurrent edits preserve both.
    if ((editing || drafting) && !newDay && !newPair) return;
    setChoice(ownAnswer?.data.choice ?? null); setShareToProfile(ownAnswer?.data.shareToProfile ?? false);
    draftPair.current = questionPair ? [...questionPair] : null;
    if (newDay || newPair) {
      setEditing(null); setDrafting(false); setError('');
      setNotice(newPair ? 'Your question pairing changed. Review your partner before answering.' : 'A new day, a new question. Choose the answer that feels right today.');
    }
  }, [today, pairKey, ownAnswer?.id, ownAnswer?.version, editing, drafting]);

  function beginDraft() {
    if (!editing && !drafting) draftPair.current = questionPair ? [...questionPair] : null;
    if (!editing) setDrafting(true);
  }
  function cancelEdit() {
    setEditing(null); setDrafting(false); setError(''); setChoice(ownAnswer?.data.choice ?? null); setShareToProfile(ownAnswer?.data.shareToProfile ?? false);
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (choice === null || busy || !paired || previousPairAnswer) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const expectedPair = editing?.data.participantIds ?? draftPair.current;
      if (!expectedPair || !sameQuestionPair(expectedPair, questionPair)) throw new Error('Your question pairing changed. Review your partner and choose your answer again.');
      const data = { questionId: question.id, date: today, choice, shareToProfile, participantIds: [...expectedPair] as QuestionPair };
      const original = editing ?? (drafting ? undefined : ownAnswer);
      if (original) await updateRecord(original, data); else await addRecord('answer', data);
      setEditing(null); setDrafting(false); setNotice('Your answer is saved.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Your answer could not be saved. Please try again.'); }
    finally { setBusy(false); }
  }
  async function checkAnswers() {
    setBusy(true); setError(''); setNotice('');
    try { await refresh(); setNotice('Answers refreshed.'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not refresh answers. Please try again.'); }
    finally { setBusy(false); }
  }
  async function togglePreference(answer: FamilyRecord<'answer'>) {
    setBusy(true); setError(''); setNotice('');
    try {
      await updateRecord(answer, { ...answer.data, shareToProfile: !answer.data.shareToProfile });
      setNotice(answer.data.shareToProfile ? 'That answer has been removed from your profile.' : 'Profile sharing is on. Your whole family can see this preference after you and your partner have answered.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Your preference could not be updated. Please try again.'); }
    finally { setBusy(false); }
  }
  async function confirmDelete() {
    if (!deleting || busy) return;
    setBusy(true); setError('');
    try { await deleteRecord(deleting); setDeleting(null); cancelEdit(); setNotice('Your answer was deleted.'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Your answer could not be deleted. Please try again.'); }
    finally { setBusy(false); }
  }
  const historyDates = [...new Set(conversation.filter(answer => answer.data.date < today || (!paired && answer.ownerId === user.id)).map(answer => answer.data.date))].sort().reverse();

  return <div className="wellness-page questions-page stack">
    <SectionHeader eyebrow="Stay curious about each other" title="A small question. A closer connection." description="One thoughtful prompt each day. A little more understanding, one conversation at a time." />
    {error && !deleting && <p className="wellness-error" role="alert">{error}</p>}
    {notice && <p className="wellness-success" role="status">{notice}</p>}
    {!paired ? <EmptyState icon={<HeartHandshake size={30} />} title="A space for two" description="Daily questions are for the couple chosen by your family administrator. You aren’t currently paired. Your own saved answers remain private to you; family members can still choose to share preferences on their profiles." /> : <div className="questions-layout">
      <section className="card question-card stack" aria-label="Today’s question">
        <div className="wellness-row"><Badge tone="green"><Sparkles size={13} aria-hidden="true" />Today’s question</Badge><span className="muted">{formatDate(today, { month: 'short', day: 'numeric' })}</span></div>
        <p className="eyebrow">You &amp; {partner?.name ?? 'your partner'}</p>
        <h2 className="daily-question">{question.prompt}</h2>
        {previousPairAnswer ? <div className="wellness-notice"><p>Today’s saved answer belongs to an earlier pairing. It stays private to you. Start a new question with {partner?.name ?? 'your partner'} tomorrow.</p><p><strong>Your saved answer:</strong> {questionById(previousPairAnswer.data.questionId)?.choices[previousPairAnswer.data.choice]}</p><div className="wellness-actions">{previousPairAnswer.data.shareToProfile && <Button variant="secondary" size="sm" disabled={busy} onClick={() => void togglePreference(previousPairAnswer)}>Remove from profile</Button>}<Button variant="ghost" size="sm" onClick={() => { setError(''); setDeleting(previousPairAnswer); }}>Delete my saved answer</Button></div></div> : (!ownAnswer || editing || drafting) ? <form onSubmit={event => void save(event)} className="stack"><fieldset className="wellness-form-fields stack" disabled={busy}>
          <fieldset className="wellness-fieldset"><legend className="sr-only">Choose your answer</legend><div className="question-choices">{question.choices.map((text, index) => <label key={text} className={`question-choice ${choice === index ? 'is-selected' : ''}`}><input type="radio" required name="daily-answer" value={index} checked={choice === index} onChange={() => { beginDraft(); setChoice(index); }} /><span className="question-letter" aria-hidden="true">{String.fromCharCode(65 + index)}</span><span>{text}</span>{choice === index && <Check size={18} aria-hidden="true" />}</label>)}</div></fieldset>
          <label className="mood-sharing"><input type="checkbox" checked={shareToProfile} onChange={event => { beginDraft(); setShareToProfile(event.target.checked); }} /><span><strong>Add this preference to my profile</strong><span>Optional. Your whole family can see this preference after you and {partner?.name ?? 'your partner'} both answer.</span></span></label>
          {drafting && ownAnswer && !editing && <p className="wellness-notice">An answer was saved in another window. Your unsaved choice is kept here.</p>}
          <div className="wellness-actions"><Button type="submit" busy={busy} disabled={choice === null}>{editing ? 'Save changes' : 'Save my answer'}</Button>{(editing || (drafting && ownAnswer)) && <Button variant="ghost" disabled={busy} onClick={cancelEdit}>{editing ? 'Cancel edit' : 'Review saved answer'}</Button>}</div>
        </fieldset></form> : <div className="question-own-answer"><div><span className="eyebrow">Your answer</span><p>{question.choices[ownAnswer.data.choice]}</p><span className="muted">{ownAnswer.data.shareToProfile ? allAnswered ? 'This preference is shared on your family profile.' : 'Profile sharing is on. Waiting for your partner before sharing with family.' : 'This answer will stay off your profile.'}</span></div><Button variant="secondary" size="sm" disabled={busy} onClick={() => { draftPair.current = ownAnswer.data.participantIds ? [...ownAnswer.data.participantIds] : null; setChoice(ownAnswer.data.choice); setShareToProfile(ownAnswer.data.shareToProfile); setDrafting(false); setEditing(ownAnswer); setError(''); setNotice(''); }}>Edit answer</Button></div>}
        <p className="question-privacy"><LockKeyhole size={16} aria-hidden="true" /><span>Only you can see your answer until you both answer. Then you and {partner?.name ?? 'your partner'} can see each other’s choices. Your whole family sees a preference only if you choose profile sharing. A new question arrives each day in {timezone.replaceAll('_', ' ')}.</span></p>
      </section>
      <aside className="stack question-aside"><section className="card question-reveal"><div className="question-reveal-icon"><HeartHandshake size={28} aria-hidden="true" /></div><h2>{allAnswered ? 'A little more understood.' : ownAnswer ? 'Your answer is tucked away.' : 'A moment to meet each other.'}</h2>
        {allAnswered ? <><p className="muted">You’ve both answered. Different choices can be a lovely place to start a conversation.</p><div className="question-results">{pairMembers.map(member => {
          const answer = todayAnswers.find(record => record.ownerId === member.id);
          return <div className="question-result" key={member.id}><span className="question-avatar" style={{ backgroundColor: member.color }}>{member.name.slice(0, 1)}</span><div><strong>{member.id === user.id ? 'You' : member.name}</strong><p>{answer && question.choices[answer.data.choice]}</p></div></div>;
        })}</div></> : <><p className="muted">{previousPairAnswer ? 'Your previous answer keeps its original audience. A changed pairing never transfers a saved answer to another person.' : ownAnswer ? `Once you and ${partner?.name ?? 'your partner'} have answered, your choices will appear here together.` : 'Choose what feels most like you. Your choices are revealed to each other once you both answer.'}</p><div className="question-waiting"><Users size={17} aria-hidden="true" /><span>{ownAnswer ? 'Your answer is saved' : previousPairAnswer ? 'A fresh start tomorrow' : 'Your answer is still to come'}</span>{ownAnswer && <Check size={17} aria-hidden="true" />}</div>{ownAnswer && <Button variant="secondary" busy={busy} onClick={() => void checkAnswers()}><RefreshCw size={15} aria-hidden="true" />Check for answers</Button>}</>}
      </section><div className="question-conversation"><span className="eyebrow">Let curiosity lead</span><p>“What made you choose that?” is a lovely place to begin.</p></div></aside>
    </div>}
    {historyDates.length > 0 && <section className="question-history stack"><h2>Little things we’ve learned</h2><div className="grid-2">{historyDates.slice(0, historyLimit).map(date => {
      const dayAnswers = conversation.filter(answer => answer.data.date === date);
      const pastQuestion = questionById(dayAnswers[0]?.data.questionId ?? '');
      if (!pastQuestion) return null;
      return <article className="card question-history-card" key={date}><p className="eyebrow">{formatDate(date)}</p><h3>{pastQuestion.prompt}</h3>{dayAnswers.map(answer => {
        const originalPairActive = paired && sameQuestionPair(answer.data.participantIds, questionPair);
        const complete = answerPairComplete(answer, answers, questionPair);
        return <div key={answer.id} className="question-history-answer"><p><strong>{answer.ownerId === user.id ? 'You' : members.find(member => member.id === answer.ownerId)?.name ?? 'Family member'}:</strong> {questionById(answer.data.questionId)?.choices[answer.data.choice]}</p>{answer.ownerId === user.id && <><p className="muted">{!answer.data.participantIds ? 'Saved before pairing · private to you.' : !originalPairActive ? 'Previous pairing · private to you.' : !complete ? 'Private until you both answer.' : answer.data.shareToProfile ? 'Shared on your family profile.' : 'Visible to your partner.'}</p><div className="wellness-actions">{(originalPairActive || answer.data.shareToProfile) && <Button variant="ghost" size="sm" disabled={busy} aria-label={`${answer.data.shareToProfile ? 'Remove answer from profile' : 'Add answer to profile'} for ${formatDate(date)}`} onClick={() => void togglePreference(answer)}>{answer.data.shareToProfile ? 'Remove from profile' : 'Add to my profile'}</Button>}<Button variant="ghost" size="sm" disabled={busy} aria-label={`Delete my answer for ${formatDate(date)}`} onClick={() => { setError(''); setDeleting(answer); }}><Trash2 size={13} aria-hidden="true" />Delete</Button></div></>}</div>;
      })}</article>;
    })}</div>{historyDates.length > historyLimit && <Button variant="secondary" onClick={() => setHistoryLimit(limit => limit + 20)}>Show older questions</Button>}</section>}
    <Modal open={Boolean(deleting)} onClose={() => { if (!busy) setDeleting(null); }} title="Delete your answer?" description="This removes your choice and profile preference. Your partner’s answer becomes private again for this question.">{error && <p className="wellness-error" role="alert">{error}</p>}<div className="wellness-actions"><Button variant="secondary" disabled={busy} onClick={() => setDeleting(null)}>Keep answer</Button><Button variant="danger" busy={busy} onClick={() => void confirmDelete()}>Delete answer</Button></div></Modal>
  </div>;
}
