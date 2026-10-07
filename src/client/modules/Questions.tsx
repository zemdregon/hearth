import { useEffect, useRef, useState } from 'react';
import { Check, HeartHandshake, LockKeyhole, RefreshCw, Sparkles, Users } from 'lucide-react';
import { useFamily, useRecords } from '../store';
import { Badge, Button, SectionHeader } from '../components/ui';
import { formatDate, todayInTimezone } from '../../shared/calendar';
import { questionById, questionForDate } from '../../shared/questions';
import type { FamilyRecord } from '../../shared/types';
import './wellness.css';

export function Questions() {
  const { user, members, timezone, addRecord, updateRecord, refresh } = useFamily();
  const answers = useRecords('answer');
  const today = todayInTimezone(timezone);
  const question = questionForDate(today);
  const todayAnswers = answers.filter(record => record.data.date === today && record.data.questionId === question.id);
  const ownAnswer = todayAnswers.find(record => record.ownerId === user?.id);
  const allAnswered = members.length > 0 && members.every(member => todayAnswers.some(record => record.ownerId === member.id));
  const [choice, setChoice] = useState<number | null>(ownAnswer?.data.choice ?? null);
  const [shareToProfile, setShareToProfile] = useState(ownAnswer?.data.shareToProfile ?? false);
  const [editing, setEditing] = useState<FamilyRecord<'answer'> | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [historyLimit, setHistoryLimit] = useState(20);
  const previousDay = useRef(today);
  const familyWord = members.length === 2 ? 'both of you' : 'everyone';
  useEffect(() => {
    const newDay = previousDay.current !== today;
    previousDay.current = today;
    // Keep an edit tied to the version the member actually opened. Background
    // refreshes must not discard their draft or silently overwrite another tab.
    if ((editing || drafting) && !newDay) return;
    setChoice(ownAnswer?.data.choice ?? null); setShareToProfile(ownAnswer?.data.shareToProfile ?? false);
    if (newDay) { setEditing(null); setDrafting(false); setError(''); setNotice('A new day, a new question. Choose the answer that feels right today.'); }
  }, [today, ownAnswer?.id, ownAnswer?.version, editing, drafting]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (choice === null || busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const data = { questionId: question.id, date: today, choice, shareToProfile };
      const original = editing ?? (drafting ? undefined : ownAnswer);
      if (original) await updateRecord(original, data); else await addRecord('answer', data);
      setEditing(null); setDrafting(false); setNotice('Your answer is saved.');
      try { await refresh(); } catch { setNotice('Your answer is saved. Refresh to check for the other answers.'); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Your answer could not be saved. Please try again.'); }
    finally { setBusy(false); }
  }
  async function checkAnswers() {
    setBusy(true); setError(''); setNotice('');
    try { await refresh(); setNotice('Answers refreshed.'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not refresh answers. Please try again.'); }
    finally { setBusy(false); }
  }
  async function togglePastPreference(answer: FamilyRecord<'answer'>) {
    setBusy(true); setError(''); setNotice('');
    try {
      await updateRecord(answer, { ...answer.data, shareToProfile: !answer.data.shareToProfile });
      setNotice(answer.data.shareToProfile ? 'That answer has been removed from your profile.' : 'Profile sharing is on for that answer. It becomes visible after everyone has answered.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Your preference could not be updated. Please try again.'); }
    finally { setBusy(false); }
  }

  const previousDays = [...new Set(answers.filter(record => record.data.date < today).map(record => record.data.date))].sort().reverse();

  return <div className="wellness-page questions-page stack">
    <SectionHeader eyebrow="Stay curious about each other" title="A small question. A closer connection." description="One thoughtful prompt each day. A little more understanding, one conversation at a time." />
    <div className="questions-layout">
      <section className="card question-card stack" aria-label="Today’s question">
        <div className="wellness-row"><Badge tone="green"><Sparkles size={13} aria-hidden="true" />Today’s question</Badge><span className="muted">{formatDate(today, { month: 'short', day: 'numeric' })}</span></div>
        <h2 className="daily-question">{question.prompt}</h2>
        {(!ownAnswer || editing || drafting) ? <form onSubmit={event => void save(event)} className="stack"><fieldset className="wellness-form-fields stack" disabled={busy}><fieldset className="wellness-fieldset"><legend className="sr-only">Choose your answer</legend><div className="question-choices">{question.choices.map((text, index) => <label key={text} className={`question-choice ${choice === index ? 'is-selected' : ''}`}><input type="radio" required name="daily-answer" value={index} checked={choice === index} onChange={() => { setChoice(index); if (!editing) setDrafting(true); }} /><span className="question-letter" aria-hidden="true">{String.fromCharCode(65 + index)}</span><span>{text}</span>{choice === index && <Check size={18} aria-hidden="true" />}</label>)}</div></fieldset>
          <label className="mood-sharing"><input type="checkbox" checked={shareToProfile} onChange={event => { setShareToProfile(event.target.checked); if (!editing) setDrafting(true); }} /><span><strong>Add this preference to my profile</strong><span>Optional. Your family can see it on your profile after {familyWord} answer.</span></span></label>
          {drafting && ownAnswer && !editing && <p className="wellness-notice">An answer was saved in another window. Your unsaved choice is kept here.</p>}
          <div className="wellness-actions"><Button type="submit" busy={busy} disabled={choice === null}>{editing ? 'Save changes' : 'Save my answer'}</Button>{(editing || (drafting && ownAnswer)) && <Button variant="ghost" disabled={busy} onClick={() => { setEditing(null); setDrafting(false); setError(''); setChoice(ownAnswer?.data.choice ?? null); setShareToProfile(ownAnswer?.data.shareToProfile ?? false); }}>{editing ? 'Cancel edit' : 'Review saved answer'}</Button>}</div>
        </fieldset></form> : <div className="question-own-answer"><div><span className="eyebrow">Your answer</span><p>{question.choices[ownAnswer.data.choice]}</p><span className="muted">{ownAnswer.data.shareToProfile ? 'Profile sharing is on for this answer.' : 'This answer will stay off your profile.'}</span></div><Button variant="secondary" size="sm" disabled={busy} onClick={() => { setChoice(ownAnswer.data.choice); setShareToProfile(ownAnswer.data.shareToProfile); setDrafting(false); setEditing(ownAnswer); setError(''); setNotice(''); }}>Edit answer</Button></div>}
        {error && <p className="wellness-error" role="alert">{error}</p>}{notice && <p className="wellness-success" role="status">{notice}</p>}
        <p className="question-privacy"><LockKeyhole size={16} aria-hidden="true" /><span>Answers stay private until {familyWord} have answered. A new question arrives each day in {timezone.replaceAll('_', ' ')}.</span></p>
      </section>
      <aside className="stack question-aside">
        <section className="card question-reveal"><div className="question-reveal-icon"><HeartHandshake size={28} aria-hidden="true" /></div><h2>{allAnswered ? 'A little more understood.' : ownAnswer ? 'Your answer is tucked away.' : 'A moment to meet each other.'}</h2>
          {allAnswered ? <><p className="muted">Everyone has answered. Different choices can be a lovely place to start a conversation.</p><div className="question-results">{members.map(member => {
            const answer = todayAnswers.find(record => record.ownerId === member.id);
            return <div className="question-result" key={member.id}><span className="question-avatar" style={{ backgroundColor: member.color }}>{member.name.slice(0, 1)}</span><div><strong>{member.id === user?.id ? 'You' : member.name}</strong><p>{answer && question.choices[answer.data.choice]}</p></div></div>;
          })}</div></> : <><p className="muted">{ownAnswer ? `Once ${familyWord} have answered, your choices will appear here together.` : 'Choose what feels most like you. You can see each other’s answers once everyone has joined in.'}</p><div className="question-waiting"><Users size={17} aria-hidden="true" /><span>{ownAnswer ? 'Your answer is saved' : 'Your answer is still to come'}</span>{ownAnswer && <Check size={17} aria-hidden="true" />}</div>{ownAnswer && <Button variant="secondary" busy={busy} onClick={() => void checkAnswers()}><RefreshCw size={15} aria-hidden="true" />Check for answers</Button>}</>}
        </section>
        <div className="question-conversation"><span className="eyebrow">Let curiosity lead</span><p>“What made you choose that?” is a lovely place to begin.</p></div>
      </aside>
    </div>
    {previousDays.length > 0 && <section className="question-history stack"><h2>Little things we’ve learned</h2><div className="grid-2">{previousDays.slice(0, historyLimit).map(date => {
      const dayAnswers = answers.filter(record => record.data.date === date);
      const pastQuestion = questionById(dayAnswers[0]?.data.questionId ?? '');
      if (!pastQuestion) return null;
      const revealed = members.every(member => dayAnswers.some(answer => answer.ownerId === member.id));
      return <article className="card question-history-card" key={date}><p className="eyebrow">{formatDate(date)}</p><h3>{pastQuestion.prompt}</h3>{dayAnswers.map(answer => <div key={answer.id} className="question-history-answer"><p><strong>{answer.ownerId === user?.id ? 'You' : members.find(member => member.id === answer.ownerId)?.name ?? 'Family member'}:</strong> {pastQuestion.choices[answer.data.choice]}</p>{answer.ownerId === user?.id && <Button variant="ghost" size="sm" disabled={busy} aria-label={`${answer.data.shareToProfile ? 'Remove answer from profile' : 'Add answer to profile'} for ${formatDate(date)}`} onClick={() => void togglePastPreference(answer)}>{answer.data.shareToProfile ? 'Remove from profile' : 'Add to my profile'}</Button>}</div>)}{!revealed && <p className="muted"><LockKeyhole size={13} aria-hidden="true" /> Other answers remain private.</p>}</article>;
    })}</div>{previousDays.length > historyLimit && <Button variant="secondary" onClick={() => setHistoryLimit(limit => limit + 20)}>Show older questions</Button>}</section>}
  </div>;
}
