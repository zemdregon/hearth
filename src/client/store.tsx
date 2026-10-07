import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { ReactNode } from 'react';
import type { Bootstrap, FamilyExport, FamilyRecord, ModuleConfig, ModuleId, RecordDataMap, RecordKind, User } from '../shared/types';
import { kindModule } from '../shared/types';
import { createDemo, demoMembers, prepareDemoAnswer, visibleDemo } from './demo';
import { sameQuestionPair } from '../shared/question-pairing';

const anonymous: User = { id: '', name: '', email: '', role: 'member', color: '#557461' };
class ApiError extends Error { constructor(message: string, public status: number) { super(message); } }
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try { response = await fetch(path, { ...init, credentials:'same-origin', headers:{'Content-Type':'application/json',...init?.headers} }); }
  catch { throw new ApiError('We couldn’t reach your family space. Check your connection and try again.',0); }
  if (response.redirected || !(response.headers.get('content-type') || '').includes('application/json')) throw new ApiError('Your session needs a fresh sign-in. Please sign in again.',401);
  const body = await response.json();
  if(!response.ok) throw new ApiError(typeof body==='object' && body!==null && 'error' in body && typeof body.error==='string' ? body.error : 'Something went wrong. Please try again.',response.status);
  return body as T;
}
type FamilyContext = Bootstrap & {
  authenticated: boolean; loading: boolean; error: string | null; errorStatus: number | null;
  addRecord<K extends RecordKind>(kind: K, data: RecordDataMap[K]): Promise<FamilyRecord<K>>;
  updateRecord<K extends RecordKind>(record: FamilyRecord<K>, data: RecordDataMap[K]): Promise<FamilyRecord<K>>;
  deleteRecord(record: FamilyRecord): Promise<void>;
  setModule(id: ModuleId, enabled: boolean): Promise<void>;
  exportData(): Promise<FamilyExport>;
  refresh(): Promise<void>; enterDemo(): void; leaveDemo(): void; switchDemoUser(id: string): void; signOut(): void;
};
const Context = createContext<FamilyContext | null>(null);
const empty: Bootstrap = {user:anonymous,members:[],modules:[],records:[],timezone:'UTC',questionPair:null};
export function FamilyProvider({children}:{children:ReactNode}) {
  const [state,setState] = useState<Bootstrap>(empty);
  const [authenticated,setAuthenticated] = useState(false);
  const [loading,setLoading] = useState(true);
  const [error,setError] = useState<string|null>(null);
  const [errorStatus,setErrorStatus] = useState<number|null>(null);
  const demoRef = useRef<Bootstrap|null>(null);
  const requestGeneration = useRef(0);
  const sessionEpoch = useRef(0);
  const activeUserId = useRef('');
  const mounted = useRef(true);
  const suspended = useRef(false);
  const logoutChannel = useRef<BroadcastChannel|null>(null);
  const clearSession = useCallback(()=>{
    ++requestGeneration.current; ++sessionEpoch.current; activeUserId.current=''; suspended.current=true; demoRef.current=null;
    setState(empty);setAuthenticated(false);setLoading(false);setError(null);setErrorStatus(401);
  },[]);
  const refresh = useCallback(async()=>{
    if(suspended.current) return;
    if(demoRef.current) { setState(visibleDemo(demoRef.current)); return; }
    const generation=++requestGeneration.current;
    try {
      const result=await api<Bootstrap>('/api/bootstrap');
      if(!mounted.current || generation!==requestGeneration.current || demoRef.current) return;
      if(activeUserId.current!==result.user.id) {++sessionEpoch.current;activeUserId.current=result.user.id;}
      setState(result);setAuthenticated(true);setError(null);setErrorStatus(null);
    } catch(e) {
      if(!mounted.current || generation!==requestGeneration.current || demoRef.current) return;
      const failure=e instanceof Error ? e.message : 'Unable to load your family space.';
      const status=e instanceof ApiError?e.status:0;
      setError(failure);setErrorStatus(status);
      if(status===401 || status===403 || status===503) {++sessionEpoch.current;activeUserId.current='';setState(empty);setAuthenticated(false);}
      throw e;
    } finally { if(mounted.current && generation===requestGeneration.current) setLoading(false); }
  },[]);
  useEffect(()=>{
    mounted.current=true; void refresh().catch(()=>undefined);
    const onVisible=()=>{if(document.visibilityState==='visible') void refresh().catch(()=>undefined);};
    const interval=window.setInterval(onVisible,30000);
    const onHide=()=>{flushSync(clearSession);};
    const onShow=(event:PageTransitionEvent)=>{if(event.persisted) {flushSync(clearSession);suspended.current=false;setLoading(true);void refresh().catch(()=>undefined);}};
    const channel=typeof BroadcastChannel==='function'?new BroadcastChannel('hearth-session'):null;
    logoutChannel.current=channel;
    if(channel) channel.onmessage=event=>{if(event.data==='logout') clearSession();};
    document.addEventListener('visibilitychange',onVisible);window.addEventListener('online',onVisible);window.addEventListener('pagehide',onHide);window.addEventListener('pageshow',onShow);
    return ()=>{mounted.current=false;clearInterval(interval);channel?.close();logoutChannel.current=null;document.removeEventListener('visibilitychange',onVisible);window.removeEventListener('online',onVisible);window.removeEventListener('pagehide',onHide);window.removeEventListener('pageshow',onShow);};
  },[refresh,clearSession]);
  function displayDemo(next:Bootstrap) {if(activeUserId.current!==next.user.id) {++sessionEpoch.current;activeUserId.current=next.user.id;} demoRef.current=next;setState(visibleDemo(next));setAuthenticated(true);setLoading(false);setError(null);setErrorStatus(null); }
  function enterDemo() { ++requestGeneration.current;++sessionEpoch.current;suspended.current=false;displayDemo(createDemo()); }
  function leaveDemo() {++requestGeneration.current;++sessionEpoch.current;activeUserId.current='';suspended.current=false;demoRef.current=null;setState(empty);setAuthenticated(false);setLoading(true);void refresh().catch(()=>undefined);}
  function signOut() {logoutChannel.current?.postMessage('logout');flushSync(clearSession);window.location.assign('/cdn-cgi/access/logout');}
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
      setState(current=>epoch===sessionEpoch.current?apply(current,result):current);
      await refresh().catch(()=>undefined);return result;
    }
    catch(e) {if(epoch===sessionEpoch.current && e instanceof ApiError && [401,403,409].includes(e.status)) await refresh().catch(()=>undefined);throw e;}
  }
  function storeRecord<K extends RecordKind>(current:Bootstrap,record:FamilyRecord<K>):Bootstrap {return {...current,records:[...current.records.filter(r=>r.id!==record.id),record]};}
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
  async function deleteRecord(record:FamilyRecord) {
    if(!demoRef.current) {await mutate(`/api/records/${encodeURIComponent(record.id)}`,{method:'DELETE',body:JSON.stringify({version:record.version})},current=>({...current,records:current.records.filter(r=>r.id!==record.id&&!(record.kind==='habit'&&r.kind==='habitLog'&&r.data.habitId===record.id)&&!(record.kind==='answer'&&r.kind==='answer'&&r.ownerId!==current.user.id&&r.data.date===record.data.date&&r.data.questionId===record.data.questionId&&sameQuestionPair(r.data.participantIds,record.data.participantIds)))}));return;}
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
  return <Context.Provider value={{...state,authenticated,loading,error,errorStatus,refresh,enterDemo,leaveDemo,switchDemoUser,signOut,addRecord,updateRecord,deleteRecord,setModule,exportData}}>{children}</Context.Provider>;
}
export function useFamily() {const context=useContext(Context);if(!context) throw new Error('FamilyProvider is required.');return context;}
export function useRecords<K extends RecordKind>(kind:K):FamilyRecord<K>[] {return useFamily().records.filter(r=>r.kind===kind) as FamilyRecord<K>[];}
