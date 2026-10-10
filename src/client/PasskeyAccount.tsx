import { useEffect, useRef, useState } from 'react';
import { ArrowRight, KeyRound, LockKeyhole, ShieldCheck } from 'lucide-react';
import type { InternalMember } from '../shared/members';
import { Button, Field, Modal } from './components/ui';
import { forgetInitialInvitation, initialInvitation } from './passkeys';
import { useFamily } from './store';

function message(error: unknown) { return error instanceof Error ? error.message : 'This request couldn’t finish. Please try again.'; }

export function PasskeySignIn() {
  const { signIn, enroll, authBusy, captureAuthCancellation } = useFamily();
  const [invitation, setInvitation] = useState(initialInvitation);
  const [name, setName] = useState('');
  const [error, setError] = useState<string|null>(null);
  const [registered, setRegistered] = useState(false);
  const alive = useRef(true);
  const cancel = useRef<() => void>(() => undefined);
  useEffect(() => {
    alive.current = true;forgetInitialInvitation();
    return () => { alive.current = false;cancel.current(); };
  }, []);
  async function authenticate() {
    setError(null);
    try { const pending=signIn();cancel.current=captureAuthCancellation();await pending; } catch (error) { if (alive.current) setError(message(error)); }
  }
  async function register() {
    if (!invitation.token) return;
    setError(null);
    try {
      const pending=enroll(invitation.token, name);cancel.current=captureAuthCancellation();await pending;
      if (alive.current) { setInvitation({ token: null, invalid: false });setRegistered(true);setName(''); }
    } catch (error) { if (alive.current) setError(message(error)); }
  }
  return <div className="stack">
    {invitation.invalid && <p role="alert" className="field-error">This invitation link is incomplete. Ask your family administrator for a new enrollment link.</p>}
    {invitation.token ? <>
      <h3>Set up your passkey</h3>
      <p>This invitation lets you register a passkey for your assigned family account. You’ll then sign in with that passkey.</p>
      <Field label="Passkey name" hint="Optional. For example, your phone or security key."><input className="input" value={name} onChange={event => setName(event.target.value)} maxLength={64} autoComplete="off" disabled={authBusy}/></Field>
      <Button className="gate-signin" busy={authBusy} onClick={() => void register()}><KeyRound size={16}/> Create your passkey</Button>
      <Button variant="ghost" disabled={authBusy} onClick={() => {setInvitation({token:null,invalid:false});setError(null);}}>Discard invitation</Button>
    </> : <>
      {registered && <p role="status">Your passkey is registered. Sign in with it to open your family space.</p>}
      <Button className="gate-signin" busy={authBusy} onClick={() => void authenticate()}><LockKeyhole size={16}/> Sign in with a passkey <ArrowRight size={17}/></Button>
    </>}
    {error && <p className="field-error" role="alert">{error}</p>}
    <p className="field-hint">Use your device’s unlock, a saved passkey, or a security key. If you’ve lost every passkey, ask a family administrator to verify your identity and arrange recovery.</p>
  </div>;
}

type Credential = { id: string; name: string; createdAt: number; lastUsedAt: number | null; current?: boolean };
const memberColors = ['#38634A', '#A96743', '#557461', '#5B6FA6', '#9A5B8C', '#8A6D2F', '#4F7F8C', '#A4524F'];
/** A fresh invitee gets a colour no current member already wears, so avatars stay distinguishable. */
function nextMemberColor(members: { color: string }[]) {
  const used = new Set(members.map(member => member.color.toLowerCase()));
  return memberColors.find(color => !used.has(color.toLowerCase())) ?? memberColors[members.length % memberColors.length];
}
function credentialLabel(credential: Credential) {
  const added = new Date(credential.createdAt * 1000);
  const when = Number.isNaN(added.valueOf()) ? '' : ` (added ${added.toLocaleString()})`;
  return `${credential.name || 'Unnamed passkey'}${when}`;
}
type Invitation = { token: string; expiresAt: number; memberId: string };
type MemberAction = { member: InternalMember; kind: 'recover' | 'suspend' | 'revoke' };
function displayDate(value: number | null) {
  if (!value) return 'Not used yet';
  const date = new Date(value * 1000);
  return Number.isNaN(date.valueOf()) ? 'Date unavailable' : date.toLocaleDateString();
}

export function PasskeyAccount() {
  const [open, setOpen] = useState(false);
  if (open) return <PasskeyAccountDetails close={()=>setOpen(false)}/>;
  return <section className="card stack" style={{padding:'1.5rem',marginTop:'1.5rem'}}>
    <h2>Your passkeys & account</h2>
    <p>Add a backup passkey, manage signed-in devices, and review family access.</p>
    <Button variant="secondary" onClick={()=>setOpen(true)}>Manage passkeys and account</Button>
  </section>;
}

function PasskeyAccountDetails({ close }: { close: () => void }) {
  const { user, accountRequest: requestAccount, registerPasskey, revokeAllSessions, captureAuthCancellation, authBusy, refresh } = useFamily();
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [members, setMembers] = useState<InternalMember[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string|null>(null);
  const [notice, setNotice] = useState<string|null>(null);
  const [passkeyName, setPasskeyName] = useState('');
  const [inviteName, setInviteName] = useState('');
  const [inviteRole, setInviteRole] = useState<'member'|'admin'>('member');
  const [invitation, setInvitation] = useState<Invitation|null>(null);
  const [action, setAction] = useState<MemberAction|null>(null);
  const [remove, setRemove] = useState<Credential|null>(null);
  const [revokeSessions, setRevokeSessions] = useState(false);
  const alive = useRef(true);
  const cancel = useRef<() => void>(() => undefined);
  const isAdmin = user.role === 'admin';
  const requests = useRef({ requestAccount, refresh, captureAuthCancellation });
  requests.current = { requestAccount, refresh, captureAuthCancellation };
  function accountRequest<T>(path:string,body?:unknown):Promise<T> {
    const pending=requests.current.requestAccount<T>(path,body);
    cancel.current=requests.current.captureAuthCancellation();
    return pending;
  }
  async function load() {
    const credentialResult = await accountRequest<{ credentials: Credential[] }>('/api/auth/credentials');
    if (!alive.current) return;
    setCredentials(credentialResult.credentials);
    if (isAdmin) {
      const memberResult = await accountRequest<{ members: InternalMember[] }>('/api/auth/members');
      if (!alive.current) return;
      setMembers(memberResult.members);
    }
    setLoaded(true);
  }
  useEffect(() => {
    alive.current = true;
    let current = true;
    void load().catch(error => {if(current && alive.current) setError(message(error));});
    return () => {current = false;alive.current = false;cancel.current();};
  }, [user.id]);
  async function perform(work: () => Promise<void>) {
    setError(null);setNotice(null);
    try {await work();} catch (error) {if(alive.current) setError(message(error));}
  }
  async function addPasskey() {
    const pending=registerPasskey(passkeyName);cancel.current=captureAuthCancellation();await pending;
    if (!alive.current) return;
    setPasskeyName('');setNotice('Passkey added. Keep your backup device or security key somewhere safe.');
    await load();
  }
  async function invite() {
    const memberId = crypto.randomUUID();
    const result = await accountRequest<{token:string;expiresAt:number}>('/api/auth/members',{id:memberId,name:inviteName.trim(),role:inviteRole,color:nextMemberColor(members)});
    if (!alive.current) return;
    setInvitation({...result,memberId});setInviteName('');setInviteRole('member');await load();
  }
  async function memberAction() {
    if (!action) return;
    const {member,kind} = action;
    if (kind === 'recover') {
      const result = await accountRequest<{token:string;expiresAt:number}>(`/api/auth/members/${encodeURIComponent(member.id)}/recover`,{});
      if (!alive.current) return;
      setInvitation({...result,memberId:member.id});setNotice('Old passkeys and sessions were revoked. Share the new enrollment link only after verifying this person’s identity.');
    } else {
      await accountRequest(kind === 'suspend' ? `/api/auth/members/${encodeURIComponent(member.id)}/suspend` : '/api/auth/invitations/revoke',kind === 'suspend' ? {} : {memberId:member.id});
      if (!alive.current) return;
      if (invitation?.memberId === member.id) setInvitation(null);
      setNotice(kind === 'suspend' ? 'Membership suspended. Saved family records are preserved.' : 'Outstanding enrollment invitations revoked.');
    }
    setAction(null);await load();await refresh().catch(()=>undefined);
  }
  const invitationLink = invitation ? `${window.location.origin}/#enroll=${invitation.token}` : '';
  return <section className="card stack" aria-labelledby="passkey-account-heading" style={{padding:'1.5rem',marginTop:'1.5rem'}}>
    <div><h2 id="passkey-account-heading"><KeyRound size={21}/> Your passkeys & account</h2><p>Add a second passkey on another device or a hardware security key so you have a way back in. Changes require fresh passkey verification.</p></div>
    <Button variant="ghost" onClick={close}>Close account controls</Button>
    {error && !invitation && !action && !remove && !revokeSessions && <p className="field-error" role="alert">{error}</p>}
    {notice && !invitation && <p role="status">{notice}</p>}
    {!loaded && <Button variant="secondary" disabled={authBusy} onClick={()=>void perform(load)}>{authBusy ? 'Loading account…' : 'Reload account'}</Button>}
    {credentials.map(credential=><div className="card stack" style={{padding:'1rem'}} key={credential.id}>
      <strong>{credential.name || 'Unnamed passkey'}{credential.current ? ' · Used to sign in here' : ''}</strong><span className="field-hint">Added {displayDate(credential.createdAt)} · Last used {displayDate(credential.lastUsedAt)}</span>
      <Button variant="ghost" size="sm" disabled={authBusy || credentials.length < 2} aria-label={`Remove ${credentialLabel(credential)}`} onClick={()=>setRemove(credential)}>Remove{credential.name ? ` ${credential.name}` : ' passkey'}</Button>
    </div>)}
    {loaded && credentials.length < 2 && <p className="field-hint">Keep at least one passkey. Add a backup before removing your only passkey.</p>}
    <form className="stack" onSubmit={event=>{event.preventDefault();void perform(addPasskey);}}>
      <Field label="New passkey name" hint="For example, backup security key."><input className="input" value={passkeyName} onChange={event=>setPasskeyName(event.target.value)} maxLength={64} disabled={authBusy} autoComplete="off"/></Field>
      <Button type="submit" disabled={!loaded || authBusy}>Add another passkey</Button>
    </form>
    <Button variant="secondary" disabled={!loaded || authBusy} onClick={()=>setRevokeSessions(true)}>Sign out all devices</Button>
    {isAdmin && <section className="stack" aria-labelledby="member-access-heading">
      <h2 id="member-access-heading"><ShieldCheck size={21}/> Family membership</h2>
      <p>Administrators have account-recovery authority: after verifying someone’s identity in person or through a trusted channel, an administrator can replace their lost passkeys. This does not grant a direct way to browse their private records.</p>
      <form className="stack" onSubmit={event=>{event.preventDefault();void perform(invite);}}>
        <Field label="New member’s display name"><input className="input" required maxLength={80} value={inviteName} onChange={event=>setInviteName(event.target.value)} disabled={authBusy} autoComplete="off"/></Field>
        <Field label="New member’s role"><select className="input" value={inviteRole} onChange={event=>setInviteRole(event.target.value as 'admin'|'member')} disabled={authBusy}><option value="member">Family member</option><option value="admin">Administrator — includes account recovery</option></select></Field>
        <Button type="submit" disabled={!loaded || authBusy || !inviteName.trim()}>Create enrollment invitation</Button>
      </form>
      {members.map(member=><div className="card stack" style={{padding:'1rem'}} key={member.id}>
        <strong>{member.name}{member.id===user.id?' · You':''}</strong><span className="field-hint">{member.role==='admin'?'Administrator':'Family member'} · {member.status}</span>
        <div className="section-actions" style={{flexWrap:'wrap'}}>
          <Button size="sm" variant="secondary" disabled={authBusy || member.id===user.id} onClick={()=>setAction({member,kind:'recover'})}>{member.status==='pending'?'Replace enrollment invitation':member.status==='suspended'?'Restore with a new passkey':'Recover account'}</Button>
          <Button size="sm" variant="ghost" disabled={authBusy} onClick={()=>setAction({member,kind:'revoke'})}>Revoke invitations</Button>
          {member.status!=='suspended' && <Button size="sm" variant="danger" disabled={authBusy || member.id===user.id} onClick={()=>setAction({member,kind:'suspend'})}>Suspend membership</Button>}
        </div>
      </div>)}
    </section>}
    <Modal open={!!invitation} onClose={()=>setInvitation(null)} title="Share this enrollment link privately" description="Give this link directly to the intended person. Anyone who receives it can register a passkey for that member until it expires or is used.">
      <div className="stack"><Field label="Enrollment link"><textarea className="input" readOnly rows={4} value={invitationLink}/></Field>
        {error && <p className="field-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
        <p>Expires {invitation ? new Date(invitation.expiresAt * 1000).toLocaleString() : ''}. Hearth does not send this link. Closing this dialog discards your copy; an administrator can replace or revoke it.</p>
        <Button onClick={()=>void perform(async()=>{try {await navigator.clipboard.writeText(invitationLink);if(alive.current) setNotice('Enrollment link copied. Share it only with the intended person.');} catch {throw new Error('Copy was unavailable. Select and copy the displayed link yourself.');}})}>Copy enrollment link</Button>
        <Button variant="secondary" onClick={()=>setInvitation(null)}>Done</Button>
      </div>
    </Modal>
    <Modal open={!!action} onClose={()=>{if(!authBusy)setAction(null);}} title={action?.kind==='suspend'?'Suspend this membership?':action?.kind==='revoke'?'Revoke enrollment invitations?':'Authorize account recovery?'}>
      {error && <p className="field-error" role="alert">{error}</p>}
      <p>{action?.kind==='recover'?`Verify ${action.member.name}’s identity before continuing. This revokes their old passkeys, sessions and invitations, then provides a new enrollment link for the same permanent account. Their saved records remain attached to that account.`:action?.kind==='suspend'?`Suspend ${action.member.name} and revoke their access. Their saved records are preserved.`:`Revoke every outstanding enrollment link for ${action?.member.name}. Existing passkeys remain usable.`}</p>
      <Button busy={authBusy} onClick={()=>void perform(memberAction)}>{action?.kind==='recover'?'Identity verified — authorize recovery':action?.kind==='suspend'?'Verify passkey and suspend':'Verify passkey and revoke invitations'}</Button>
    </Modal>
    <Modal open={!!remove} onClose={()=>{if(!authBusy)setRemove(null);}} title="Remove this passkey?">
      {error && <p className="field-error" role="alert">{error}</p>}
      <p>You will need another registered passkey to sign in.{remove?.current ? ' This is the passkey you used to sign in on this device, so removing it signs you out here.' : ' Your current session keeps working.'}</p>
      <Button busy={authBusy} variant="danger" onClick={()=>void perform(async()=>{if(!remove)return;await accountRequest('/api/auth/credentials/revoke',{id:remove.id});if(!alive.current)return;setRemove(null);setNotice('Passkey removed.');await load();})}>Verify and remove passkey</Button>
    </Modal>
    <Modal open={revokeSessions} onClose={()=>{if(!authBusy)setRevokeSessions(false);}} title="Sign out all devices?">
      {error && <p className="field-error" role="alert">{error}</p>}
      <p>This ends every session, including this one. Your passkeys remain available to sign in again.</p>
      <Button busy={authBusy} onClick={()=>void perform(async()=>{const pending=revokeAllSessions();cancel.current=captureAuthCancellation();await pending;})}>Verify passkey and sign out all devices</Button>
    </Modal>
  </section>;
}
