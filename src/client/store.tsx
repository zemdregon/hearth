import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { ReactNode } from 'react';
import type { Bootstrap, FamilyExport, FamilyRecord, ModuleConfig, ModuleId, RecordDataMap, RecordKind, User } from '../shared/types';
import { kindModule } from '../shared/types';
import { createDemo, demoMembers, prepareDemoAnswer, visibleDemo } from './demo';
import { sameQuestionPair } from '../shared/question-pairing';
import { backfillDates, todayInTimezone } from '../shared/calendar';
import { arrivedForEnrollment, cancelPasskeyCeremony, captureArrivalInvitation, createPasskey, verifyPasskey, type PasskeyRequest } from './passkeys';

const anonymous: User = { id: '', name: '', role: 'member', color: '#557461' };
class ApiError extends Error { constructor(message: string, public status: number) { super(message); } }
async function apiResponse(path: string, init?: RequestInit): Promise<Response> {
  const headers=new Headers(init?.headers);
  if(!headers.has('Content-Type')) headers.set('Content-Type','application/json');
  try { return await fetch(path, { ...init, cache:'no-store', credentials:'same-origin', headers }); }
  catch { throw new ApiError('We couldn’t reach your family space. Check your connection and try again.',0); }
}
async function apiBody<T>(response:Response):Promise<T> {
  if (!response.redirected && response.status>=500 && !(response.headers.get('content-type') || '').includes('application/json')) throw new ApiError('Something went wrong on our side. Please try again in a moment.',response.status);
  if (response.redirected || !(response.headers.get('content-type') || '').includes('application/json')) throw new ApiError('Your session needs a fresh sign-in. Please sign in again.',401);
  const body = await response.json();
  if(!response.ok) throw new ApiError(typeof body==='object' && body!==null && 'error' in body && typeof body.error==='string' ? body.error : 'Something went wrong. Please try again.',response.status);
  return body as T;
}
export async function api<T>(path: string, init?: RequestInit): Promise<T> { return apiBody<T>(await apiResponse(path,init)); }
type FamilyContext = Bootstrap & {
  authenticated: boolean; loading: boolean; authBusy: boolean; logoutFailed: boolean; enrollmentRevision: number; error: string | null; errorStatus: number | null;
  addRecord<K extends RecordKind>(kind: K, data: RecordDataMap[K]): Promise<FamilyRecord<K>>;
  updateRecord<K extends RecordKind>(record: FamilyRecord<K>, data: RecordDataMap[K]): Promise<FamilyRecord<K>>;
  /** Creates a habit; a past `startDate` also counts every day from then through yesterday, atomically. */
  createHabit(data: RecordDataMap['habit'], startDate?: string): Promise<FamilyRecord<'habit'>>;
  deleteRecord(record: FamilyRecord): Promise<void>;
  setModule(id: ModuleId, enabled: boolean): Promise<void>;
  exportData(): Promise<FamilyExport>;
  refresh(): Promise<void>; enterDemo(): void; leaveDemo(): void; switchDemoUser(id: string): void; signOut(): void;
  signIn(): Promise<void>; enroll(token: string, name: string): Promise<void>; registerPasskey(name: string): Promise<void>;
  accountRequest<T>(path: string, body?: unknown): Promise<T>; revokeAllSessions(): Promise<void>;
  captureAuthCancellation(): () => void;
};
const Context = createContext<FamilyContext | null>(null);
const empty: Bootstrap = {user:anonymous,members:[],modules:[],records:[],timezone:'UTC',questionPair:null};
export function FamilyProvider({children}:{children:ReactNode}) {
  const [state,setState] = useState<Bootstrap>(empty);
  const [authenticated,setAuthenticated] = useState(false);
  const [loading,setLoading] = useState(!arrivedForEnrollment);
  const [authBusy,setAuthBusy] = useState(false);
  const [logoutFailed,setLogoutFailed] = useState(false);
  const [enrollmentRevision,setEnrollmentRevision] = useState(0);
  const [error,setError] = useState<string|null>(null);
  const [errorStatus,setErrorStatus] = useState<number|null>(null);
  const [,setRefreshRevision] = useState(0);
  // A validator is useful only while this provider holds its complete server snapshot.
  // Neither the snapshot nor its validator belongs in browser persistence or HTTP caches.
  const bootstrapValidator = useRef<{etag:string;snapshot:Bootstrap}|null>(null);
  const demoRef = useRef<Bootstrap|null>(null);
  const requestGeneration = useRef(0);
  const sessionEpoch = useRef(0);
  const activeUserId = useRef('');
  const mounted = useRef(true);
  const suspended = useRef(arrivedForEnrollment);
  const authOperation = useRef<AbortController|null>(null);
  const logoutChannel = useRef<BroadcastChannel|null>(null);
  const cancelAuthentication=useCallback(()=>{authOperation.current?.abort();authOperation.current=null;cancelPasskeyCeremony();setAuthBusy(false);},[]);
  const captureAuthCancellation=useCallback(()=>{
    const operation=authOperation.current;
    return ()=>{if(operation && authOperation.current===operation) cancelAuthentication();};
  },[cancelAuthentication]);
  const clearSession = useCallback(()=>{
    cancelAuthentication();
    ++requestGeneration.current; ++sessionEpoch.current; activeUserId.current=''; suspended.current=true; demoRef.current=null;
    bootstrapValidator.current=null;
    setState(empty);setAuthenticated(false);setLoading(false);setError(null);setErrorStatus(401);
  },[cancelAuthentication]);
  const refresh = useCallback(async(completeSignIn=false)=>{
    if(suspended.current || (authOperation.current && !completeSignIn)) return;
    if(demoRef.current) { setState(visibleDemo(demoRef.current)); return; }
    const generation=++requestGeneration.current;
    const epoch=sessionEpoch.current;
    const validator=bootstrapValidator.current;
    const isCurrent=()=>mounted.current && generation===requestGeneration.current && epoch===sessionEpoch.current && !demoRef.current && !suspended.current;
    try {
      let response=await apiResponse('/api/bootstrap',validator?{headers:{'If-None-Match':validator.etag}}:undefined);
      if(!isCurrent()) return;
      if(response.status===304 && !response.redirected) {
        if(validator && bootstrapValidator.current===validator && activeUserId.current && activeUserId.current===validator.snapshot.user.id && response.headers.get('etag')===validator.etag) {
          // Date-dependent screens still advance at midnight, without replacing records.
          setRefreshRevision(revision=>revision+1);setError(null);setErrorStatus(null);return;
        }
        bootstrapValidator.current=null;
        response=await apiResponse('/api/bootstrap');
        if(!isCurrent()) return;
        if(response.status===304 && !response.redirected) throw new ApiError('We couldn’t verify your family space. Please refresh and try again.',0);
      }
      const result=await apiBody<Bootstrap>(response);
      if(!isCurrent()) return;
      if(activeUserId.current!==result.user.id) {++sessionEpoch.current;activeUserId.current=result.user.id;}
      const etag=response.headers.get('etag');
      bootstrapValidator.current=etag && /^W\/"hearth-[a-f0-9]{64}"$/.test(etag)?{etag,snapshot:result}:null;
      setState(result);setAuthenticated(true);setError(null);setErrorStatus(null);
    } catch(e) {
      if(!isCurrent()) return;
      const failure=e instanceof Error ? e.message : 'Unable to load your family space.';
      const status=e instanceof ApiError?e.status:0;
      setError(failure);setErrorStatus(status);
      if(status===401 || status===403 || status===503) {cancelAuthentication();bootstrapValidator.current=null;++sessionEpoch.current;activeUserId.current='';setState(empty);setAuthenticated(false);}
      throw e;
    } finally { if(mounted.current && generation===requestGeneration.current) setLoading(false); }
  },[]);
  useEffect(()=>{
    mounted.current=true; void refresh().catch(()=>undefined);
    const onVisible=()=>{if(document.visibilityState==='visible' && !authOperation.current) void refresh().catch(()=>undefined);};
    const interval=window.setInterval(onVisible,30000);
    const onHide=()=>{flushSync(clearSession);};
    const onEnrollment=()=>{
      if(captureArrivalInvitation()) flushSync(()=>{clearSession();setLogoutFailed(false);setEnrollmentRevision(revision=>revision+1);});
    };
    const onShow=(event:PageTransitionEvent)=>{if(event.persisted) {flushSync(clearSession);suspended.current=false;setLoading(true);void refresh().catch(()=>undefined);}};
    const channel=typeof BroadcastChannel==='function'?new BroadcastChannel('hearth-session'):null;
    logoutChannel.current=channel;
    if(channel) channel.onmessage=event=>{if(event.data==='logout') flushSync(clearSession);};
    document.addEventListener('visibilitychange',onVisible);window.addEventListener('online',onVisible);window.addEventListener('pagehide',onHide);window.addEventListener('pageshow',onShow);window.addEventListener('hashchange',onEnrollment,true);
    return ()=>{mounted.current=false;authOperation.current?.abort();authOperation.current=null;cancelPasskeyCeremony();bootstrapValidator.current=null;++requestGeneration.current;++sessionEpoch.current;clearInterval(interval);channel?.close();logoutChannel.current=null;document.removeEventListener('visibilitychange',onVisible);window.removeEventListener('online',onVisible);window.removeEventListener('pagehide',onHide);window.removeEventListener('pageshow',onShow);window.removeEventListener('hashchange',onEnrollment,true);};
  },[refresh,clearSession]);
  function displayDemo(next:Bootstrap) {bootstrapValidator.current=null;if(activeUserId.current!==next.user.id) {++sessionEpoch.current;activeUserId.current=next.user.id;} demoRef.current=next;setState(visibleDemo(next));setAuthenticated(true);setLoading(false);setError(null);setErrorStatus(null); }
  function enterDemo() {cancelAuthentication();++requestGeneration.current;++sessionEpoch.current;suspended.current=false;displayDemo(createDemo());}
  function leaveDemo() {bootstrapValidator.current=null;++requestGeneration.current;++sessionEpoch.current;activeUserId.current='';suspended.current=false;demoRef.current=null;setState(empty);setAuthenticated(false);setLoading(true);void refresh().catch(()=>undefined);}
  function signOut() {
    logoutChannel.current?.postMessage('logout');flushSync(clearSession);
    const epoch=sessionEpoch.current;
    const controller=new AbortController();authOperation.current=controller;setAuthBusy(true);setLogoutFailed(false);
    void api('/api/auth/logout',{method:'POST',body:'{}',signal:controller.signal}).catch(()=>{
      if(mounted.current && epoch===sessionEpoch.current) {setLogoutFailed(true);setError('Family information has been cleared from this screen, but server sign-out could not be confirmed. Reconnect and retry sign-out.');setErrorStatus(0);}
    }).finally(()=>{if(authOperation.current===controller) {authOperation.current=null;if(mounted.current) setAuthBusy(false);}});
  }
  async function authTask<T>(work:(request:PasskeyRequest)=>Promise<T>, allowSignedOut=false):Promise<T> {
    if(authOperation.current) throw new Error('Finish the current passkey request first.');
    const epoch=sessionEpoch.current;
    const controller=new AbortController();
    const assertCurrent=()=>{if(!mounted.current || epoch!==sessionEpoch.current || demoRef.current || controller.signal.aborted || (!allowSignedOut && (suspended.current || !activeUserId.current))) throw new ApiError('Your session changed. Start again to continue.',401);};
    assertCurrent();++requestGeneration.current;authOperation.current=controller;setAuthBusy(true);
    const request:PasskeyRequest=Object.assign(async<T,>(path:string,body?:unknown)=>{
      assertCurrent();
      const result=await api<T>(path,{method:body===undefined?'GET':'POST',...(body===undefined?{}:{body:JSON.stringify(body)}),signal:controller.signal});
      assertCurrent();return result;
    },{assertCurrent});
    try {return await work(request);}
    catch(error) {
      if(!allowSignedOut && !controller.signal.aborted && epoch===sessionEpoch.current && error instanceof ApiError && error.status===401) flushSync(clearSession);
      throw error;
    } finally {if(authOperation.current===controller) {authOperation.current=null;if(mounted.current) setAuthBusy(false);}}
  }
  async function signIn() {
    await authTask(async request=>{
      await verifyPasskey(request,'login');
      bootstrapValidator.current=null;suspended.current=false;setError(null);setErrorStatus(null);setLogoutFailed(false);setLoading(true);
      await refresh(true);
    },true);
  }
  async function enroll(token:string,name:string) {await authTask(request=>createPasskey(request,name,token),true);}
  async function registerPasskey(name:string) {await authTask(async request=>{await verifyPasskey(request,'reauth');await createPasskey(request,name);});}
  async function accountRequest<T>(path:string,body?:unknown):Promise<T> {
    return authTask(async request=>{if(body!==undefined) await verifyPasskey(request,'reauth');return request<T>(path,body);});
  }
  async function revokeAllSessions() {
    await accountRequest('/api/auth/sessions/revoke',{});
    logoutChannel.current?.postMessage('logout');flushSync(clearSession);setLogoutFailed(false);
  }
  function switchDemoUser(id:string) {const current=demoRef.current;const user=demoMembers.find(u=>u.id===id);if(current&&user) displayDemo({...current,user});}
  function assertDemoAccess(kind:RecordKind, record?:FamilyRecord) {
    const current=demoRef.current!;
    if(!current.modules.find(m=>m.id===kindModule[kind])?.enabled) throw new Error('Enable this module before making changes.');
    if(record && ['mood','profile','answer','habit','habitLog'].includes(kind) && record.ownerId!==current.user.id) throw new Error('Only the author can change this entry.');
    if(record && current.records.find(r=>r.id===record.id)?.version!==record.version) throw new Error('This entry changed. Please refresh and try again.');
  }
  async function mutate<T>(path:string,init:RequestInit,apply:(current:Bootstrap,result:T)=>Bootstrap):Promise<T> {
    const epoch=sessionEpoch.current;
    try {
      const result=await api<T>(path,init);
      if(epoch!==sessionEpoch.current || suspended.current || !mounted.current) throw new ApiError('Your session changed. Refresh before making another change.',401);
      bootstrapValidator.current=null;
      setState(current=>epoch===sessionEpoch.current?apply(current,result):current);
      await refresh().catch(()=>undefined);return result;
    }
    catch(e) {if(epoch===sessionEpoch.current && e instanceof ApiError && [401,403,409].includes(e.status)) await refresh().catch(()=>undefined);throw e;}
  }
  function storeRecord<K extends RecordKind>(current:Bootstrap,record:FamilyRecord<K>):Bootstrap {return {...current,capacity:undefined,records:[...current.records.filter(r=>r.id!==record.id),record]};}
  async function addRecord<K extends RecordKind>(kind:K,data:RecordDataMap[K]):Promise<FamilyRecord<K>> {
    if(!demoRef.current) return mutate<FamilyRecord<K>>('/api/records',{method:'POST',body:JSON.stringify({kind,data})},storeRecord);
    assertDemoAccess(kind);
    const current=demoRef.current;
    if(kind==='answer') data=prepareDemoAnswer(current,data as RecordDataMap['answer']) as RecordDataMap[K];
    if(kind==='habitLog') {const habit=current.records.find(r=>r.id===(data as RecordDataMap['habitLog']).habitId&&r.kind==='habit');if(!habit||habit.ownerId!==current.user.id) throw new Error('Only the person tracking this streak can check it in.');}
    const now=new Date().toISOString();
    const record={id:crypto.randomUUID(),kind,data,ownerId:current.user.id,version:1,createdAt:now,updatedAt:now} as FamilyRecord<K>;
    displayDemo({...current,records:[...current.records,record]});return record;
  }
  async function updateRecord<K extends RecordKind>(record:FamilyRecord<K>,data:RecordDataMap[K]):Promise<FamilyRecord<K>> {
    if(!demoRef.current) return mutate<FamilyRecord<K>>(`/api/records/${encodeURIComponent(record.id)}`,{method:'PATCH',body:JSON.stringify({data,version:record.version})},storeRecord);
    assertDemoAccess(record.kind,record);
    if(record.kind==='answer') data=prepareDemoAnswer(demoRef.current,data as RecordDataMap['answer'],record as FamilyRecord<'answer'>) as RecordDataMap[K];
    const next={...record,data,version:record.version+1,updatedAt:new Date().toISOString()} as FamilyRecord<K>;
    displayDemo({...demoRef.current,records:demoRef.current.records.map(r=>r.id===record.id?next:r)});return next;
  }
  async function createHabit(data:RecordDataMap['habit'],startDate?:string):Promise<FamilyRecord<'habit'>> {
    if(!demoRef.current) {
      if(startDate===undefined) return addRecord('habit',data);
      // The server returns only the habit; the refresh that follows every mutation loads its check-ins.
      return (await mutate<{habit:FamilyRecord<'habit'>}>('/api/habits',{method:'POST',body:JSON.stringify({data,startDate})},(current,result)=>storeRecord(current,result.habit))).habit;
    }
    assertDemoAccess('habit');
    const current=demoRef.current;
    let dates:string[]=[];
    if(startDate!==undefined) try {dates=backfillDates(startDate,todayInTimezone(current.timezone));} catch(e) {throw new Error(e instanceof RangeError?e.message:'Choose a valid start date.');}
    const now=new Date().toISOString();
    const habit={id:crypto.randomUUID(),kind:'habit',data,ownerId:current.user.id,version:1,createdAt:now,updatedAt:now} as FamilyRecord<'habit'>;
    const logs=dates.map(date=>({id:crypto.randomUUID(),kind:'habitLog',data:{habitId:habit.id,date},ownerId:current.user.id,version:1,createdAt:now,updatedAt:now}) as FamilyRecord<'habitLog'>);
    displayDemo({...current,records:[...current.records,habit,...logs]});return habit;
  }
  async function deleteRecord(record:FamilyRecord) {
    if(!demoRef.current) {await mutate(`/api/records/${encodeURIComponent(record.id)}`,{method:'DELETE',body:JSON.stringify({version:record.version})},current=>({...current,capacity:undefined,records:current.records.filter(r=>r.id!==record.id&&!(record.kind==='habit'&&r.kind==='habitLog'&&r.data.habitId===record.id)&&!(record.kind==='answer'&&r.kind==='answer'&&r.ownerId!==current.user.id&&r.data.date===record.data.date&&r.data.questionId===record.data.questionId&&sameQuestionPair(r.data.participantIds,record.data.participantIds)))}));return;}
    assertDemoAccess(record.kind,record);displayDemo({...demoRef.current,records:demoRef.current.records.filter(r=>r.id!==record.id&&!(record.kind==='habit'&&r.kind==='habitLog'&&r.data.habitId===record.id))});
  }
  async function setModule(id:ModuleId,enabled:boolean) {
    if(!demoRef.current) {await mutate<ModuleConfig>(`/api/modules/${id}`,{method:'PATCH',body:JSON.stringify({enabled})},(current,module)=>({...current,modules:current.modules.map(m=>m.id===id?module:m),records:module.enabled?current.records:current.records.filter(r=>kindModule[r.kind]!==id)}));return;}
    if(demoRef.current.user.role!=='admin') throw new Error('Only the family administrator can change modules.');
    displayDemo({...demoRef.current,modules:demoRef.current.modules.map(m=>m.id===id?{...m,enabled}:m)});
  }
  async function exportData():Promise<FamilyExport> {
    const epoch=sessionEpoch.current;
    if(suspended.current || !activeUserId.current) throw new ApiError('Sign in before exporting your family data.',401);
    try {
      const data=demoRef.current
        ? {...visibleDemo(demoRef.current),schemaVersion:1,exportedAt:new Date().toISOString(),scope:'Demo records visible to the selected member from enabled modules.'}
        : await api<FamilyExport>('/api/export');
      if(epoch!==sessionEpoch.current || suspended.current || !mounted.current) throw new ApiError('Your session changed. The export was canceled.',401);
      return data;
    } catch(e) {
      if(epoch===sessionEpoch.current && e instanceof ApiError && [401,403].includes(e.status)) await refresh().catch(()=>undefined);
      throw e;
    }
  }
  return <Context.Provider value={{...state,authenticated,loading,authBusy,logoutFailed,enrollmentRevision,error,errorStatus,refresh,enterDemo,leaveDemo,switchDemoUser,signOut,signIn,enroll,registerPasskey,accountRequest,revokeAllSessions,captureAuthCancellation,addRecord,updateRecord,createHabit,deleteRecord,setModule,exportData}}>{children}</Context.Provider>;
}
export function useFamily() {const context=useContext(Context);if(!context) throw new Error('FamilyProvider is required.');return context;}
export function useRecords<K extends RecordKind>(kind:K):FamilyRecord<K>[] {return useFamily().records.filter(r=>r.kind===kind) as FamilyRecord<K>[];}
