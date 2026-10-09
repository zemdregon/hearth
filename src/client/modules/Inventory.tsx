import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type MutableRefObject, type ReactNode } from 'react';
import { Archive, CalendarDays, ClipboardCheck, History, MapPin, Minus, Package, Pencil, Plus, RefreshCw } from 'lucide-react';
import { formatDate, todayInTimezone } from '../../shared/calendar';
import { measurementProfiles, stockQuantity } from '../../shared/inventory/stock';
import type { StockDimension } from '../../shared/inventory/stock';
import { resolveUnit } from '../../shared/inventory/units';
import type { MeasurementProfile } from '../../shared/inventory/units';
import type { InvItem, InvLedgerEntry, InvLocation, InvLocationKind, InvLot, InventoryState } from '../../shared/inventory/wire';
import { api, useFamily } from '../store';
import { Badge, Button, EmptyState, Modal, SectionHeader } from '../components/ui';
import { FamilyFeedback } from './family-ui';
import './family-modules.css';
import './inventory.css';

/* ------------------------------------------------------------------ display helpers */

const COUNT_PLURALS: Readonly<Record<string, string>> = { piece: 'pieces', egg: 'eggs', clove: 'cloves', head: 'heads', bunch: 'bunches', slice: 'slices', sprig: 'sprigs' };
const DIMENSION_LABELS: Readonly<Record<StockDimension, string>> = {
  mass: 'Weight (grams, ounces, pounds)', volume: 'Volume (millilitres, cups, spoons)', 'count:piece': 'Pieces', 'count:egg': 'Eggs', 'count:clove': 'Cloves',
  'count:head': 'Heads', 'count:bunch': 'Bunches', 'count:slice': 'Slices', 'count:sprig': 'Sprigs',
};
const LOCATION_KINDS: readonly { value: InvLocationKind; label: string }[] = [
  { value: 'pantry', label: 'Pantry' }, { value: 'fridge', label: 'Fridge' }, { value: 'freezer', label: 'Freezer' }, { value: 'other', label: 'Somewhere else' },
];
const PROFILE_LABELS: Readonly<Record<MeasurementProfile, string>> = { 'us-customary': 'US customary', 'us-label': 'US nutrition label', 'metric-250': 'Metric (250 mL cup)' };
const CONVENTION_UNITS: ReadonlySet<string> = new Set(['tsp', 'tbsp', 'fl oz', 'cup', 'pint', 'quart', 'gallon']);
const MASS_UNITS: readonly (readonly [string, string])[] = [['g', 'g'], ['kg', 'kg'], ['oz-mass', 'oz (weight)'], ['lb', 'lb'], ['mg', 'mg']];
const VOLUME_UNITS: readonly (readonly [string, string])[] = [['ml', 'mL'], ['l', 'L'], ['tsp', 'tsp'], ['tbsp', 'tbsp'], ['fl oz', 'fl oz'], ['cup', 'cup'], ['pint', 'pint'], ['quart', 'quart'], ['gallon', 'gallon']];
const ESTIMATE_STEPS: readonly (readonly [number, string])[] = [[500, 'Very close (give or take 5%)'], [1000, 'Close (give or take 10%)'], [2500, 'A rough guess (give or take 25%)'], [5000, 'A very rough guess (give or take 50%)']];
const HISTORY_PAGE = 20;
const KIND_LABELS: Readonly<Record<InvLedgerEntry['kind'], string>> = { add: 'Added', adjust: 'Changed', count: 'Recounted', archive: 'Archived' };
const CONVENTION_MESSAGE = 'Cups, spoons and fluid ounces differ by region. Choose a measuring convention first.';

const plural = (name: string, count: number) => count === 1 ? name : COUNT_PLURALS[name] ?? `${name}s`;
function unitsFor(dimension: StockDimension): readonly (readonly [string, string])[] {
  if (dimension === 'mass') return MASS_UNITS;
  if (dimension === 'volume') return VOLUME_UNITS;
  const name = dimension.slice(6);
  return [[name, COUNT_PLURALS[name] ?? `${name}s`]];
}
const needsConvention = (unit: string) => CONVENTION_UNITS.has(unit);
const conventionsFor = (unit: string) => measurementProfiles.filter(profile => resolveUnit(unit, profile).ok);

/** Quantities are stored as tiny integers; people only ever see grams, millilitres or counts. */
function show(qty: number, dimension: StockDimension): string {
  if (dimension.startsWith('count:')) return `${qty.toLocaleString('en')} ${plural(dimension.slice(6), qty)}`;
  const steps = dimension === 'mass' ? [['kg', 1e12], ['g', 1e9], ['mg', 1e6], ['µg', 1e3], ['ng', 1]] as const : [['L', 1e9], ['mL', 1e6], ['µL', 1e3], ['nL', 1]] as const;
  if (qty === 0) return dimension === 'mass' ? '0 g' : '0 mL';
  const [name, factor] = steps.find(([, size]) => qty >= size) ?? steps[steps.length - 1];
  return `${Math.round(qty / factor * 1000) / 1000} ${name}`;
}
const statusOf = (error: unknown) => typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number' ? error.status : 0;
const messageOf = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Please try again.';
const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

/* ------------------------------------------------------------------ shared form pieces */

type FieldProps = { id: string; 'aria-describedby'?: string; 'aria-invalid'?: true };
function Fld({ id, label, hint, error, children }: { id: string; label: string; hint?: string; error?: string | null; children: (props: FieldProps) => ReactNode }) {
  const describedBy = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ') || undefined;
  return <div className={`field ${error ? 'has-error' : ''}`}>
    <label htmlFor={id}>{label}</label>
    {children({ id, 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined })}
    {hint && <span id={`${id}-hint`} className="field-hint">{hint}</span>}
    {error && <span id={`${id}-error`} className="field-error" role="alert">{error}</span>}
  </div>;
}

type Amount = { amount: string; unit: string; profile: MeasurementProfile | '' };
type Memory = MutableRefObject<MeasurementProfile | ''>;
type AmountProblem = { field: 'amount' | 'profile'; message: string };

function checkAmount(value: Amount, dimension: StockDimension, options: { allowZero?: boolean }): AmountProblem | null {
  try {
    const result = stockQuantity({ amount: value.amount, unit: value.unit, profile: value.profile || undefined }, dimension, options);
    if (result.ok) return null;
    return { field: needsConvention(value.unit) && !value.profile && result.message === CONVENTION_MESSAGE ? 'profile' : 'amount', message: result.message };
  } catch { return { field: 'amount', message: 'Enter one exact amount such as 2, 1/2 or 1.5.' }; }
}

function quantityOf(value: Amount, dimension: StockDimension, options: { allowZero?: boolean }): number {
  const result = stockQuantity({ amount: value.amount, unit: value.unit, profile: value.profile || undefined }, dimension, options);
  return result.ok ? result.qty : 0;
}

function AmountInputs({ uid, dimension, value, memory, problem, onChange, label = 'Amount' }: { uid: string; dimension: StockDimension; value: Amount; memory: Memory; problem: AmountProblem | null; onChange: (next: Amount) => void; label?: string }) {
  const options = conventionsFor(value.unit);
  function changeUnit(unit: string) {
    const wanted = value.profile || memory.current;
    onChange({ ...value, unit, profile: needsConvention(unit) && wanted && conventionsFor(unit).includes(wanted) ? wanted : '' });
  }
  return <>
    <div className="inventory-amount-row">
      <Fld id={`${uid}-amount`} label={label} hint="For example 2, 1 1/2 or 0.5" error={problem?.field === 'amount' ? problem.message : null}>
        {props => <input {...props} className="input" value={value.amount} maxLength={64} autoComplete="off" required onChange={event => onChange({ ...value, amount: event.target.value })} />}
      </Fld>
      <Fld id={`${uid}-unit`} label="Unit">
        {props => <select {...props} className="input" value={value.unit} onChange={event => changeUnit(event.target.value)}>{unitsFor(dimension).map(([unit, name]) => <option key={unit} value={unit}>{name}</option>)}</select>}
      </Fld>
    </div>
    {needsConvention(value.unit) && <Fld id={`${uid}-profile`} label="Measuring convention" hint="Cups and spoons differ by region, so pick the one your measuring set follows." error={problem?.field === 'profile' ? problem.message : null}>
      {props => <select {...props} className="input" value={value.profile} required onChange={event => { const profile = event.target.value as MeasurementProfile | ''; memory.current = profile; onChange({ ...value, profile }); }}>
        <option value="">Choose one…</option>{options.map(profile => <option key={profile} value={profile}>{PROFILE_LABELS[profile]}</option>)}
      </select>}
    </Fld>}
  </>;
}

function Precision({ uid, precision, step, onChange, current }: { uid: string; precision: 'exact' | 'estimated'; step: number; onChange: (precision: 'exact' | 'estimated', step: number) => void; current?: number }) {
  const steps = current && !ESTIMATE_STEPS.some(([value]) => value === current) ? [...ESTIMATE_STEPS, [current, `Give or take ${Math.round(current / 100)}%`] as const].sort((a, b) => a[0] - b[0]) : ESTIMATE_STEPS;
  return <>
    <fieldset className="inventory-choice">
      <legend>How sure are you of this amount?</legend>
      <label><input type="radio" name={`${uid}-precision`} checked={precision === 'exact'} onChange={() => onChange('exact', step)} /><span>I measured it</span></label>
      <label><input type="radio" name={`${uid}-precision`} checked={precision === 'estimated'} onChange={() => onChange('estimated', step)} /><span>It’s an estimate</span></label>
    </fieldset>
    {precision === 'estimated' && <Fld id={`${uid}-step`} label="How close is your guess?" hint="Estimated stock is always shown as “about” so nobody mistakes it for an exact count.">
      {props => <select {...props} className="input" value={step} onChange={event => onChange('estimated', Number(event.target.value))}>{steps.map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select>}
    </Fld>}
  </>;
}

/** Dialog content mounts after the shell opens it, so move focus to the first field on the next frame. */
function useFocusFirst(id: string) {
  useEffect(() => { const frame = requestAnimationFrame(() => document.getElementById(id)?.focus()); return () => cancelAnimationFrame(frame); }, [id]);
}

/** One write at a time. The same request id is reused while the same request is retried, and dropped once it changes. */
function useWrite(onConflict: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const flight = useRef(false);
  const mounted = useRef(true);
  const txn = useRef<{ signature: string; id: string } | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const txnFor = (signature: string) => {
    if (txn.current?.signature !== signature) txn.current = { signature, id: crypto.randomUUID() };
    return txn.current.id;
  };
  async function run(action: () => Promise<void>): Promise<boolean> {
    if (flight.current) return false;
    flight.current = true;
    setBusy(true);
    setError(null);
    try { await action(); txn.current = null; return true; }
    catch (cause) {
      const status = statusOf(cause);
      if (status === 409 || status === 404 || status === 403) onConflict();
      if (mounted.current) setError(status === 409 || status === 404 ? `${messageOf(cause)} We refreshed your list; your entries are still here.` : messageOf(cause));
      return false;
    } finally { flight.current = false; if (mounted.current) setBusy(false); }
  }
  return { busy, error, setError, run, txnFor };
}

type Ctx = {
  state: InventoryState; today: string; timezone: string; memory: Memory;
  refreshNow: () => Promise<void>; quietReload: () => void; announce: (message: string, focusId?: string | null) => void; close: () => void;
};
const focusSoon = (id: string) => requestAnimationFrame(() => document.getElementById(id)?.focus());

/* ------------------------------------------------------------------ dialogs */

function ItemDialog({ ctx, item }: { ctx: Ctx; item?: InvItem }) {
  const uid = useId();
  const write = useWrite(ctx.quietReload);
  const [name, setName] = useState(item?.name ?? '');
  const [dim, setDim] = useState<StockDimension>(item?.dim ?? 'mass');
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useFocusFirst(`${uid}-name`);
  const current = item ? ctx.state.items.find(candidate => candidate.id === item.id) : undefined;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) { setProblem('Give this item a name.'); focusSoon(`${uid}-name`); return; }
    setProblem(null);
    let createdId: string | null = null;
    const ok = await write.run(async () => {
      if (item) {
        if (!current) throw Object.assign(new Error('This item no longer exists.'), { status: 404 });
        await api<InvItem>(`/api/inventory/items/${item.id}`, { method: 'PATCH', body: JSON.stringify({ name: name.trim(), version: current.version }) });
      } else createdId = (await api<InvItem>('/api/inventory/items', post({ name: name.trim(), dim }))).id;
      await ctx.refreshNow();
    });
    if (ok) { ctx.announce(item ? `Renamed to ${name.trim()}.` : `Added ${name.trim()}. Now add some stock.`, `inventory-item-${createdId ?? item?.id}`); ctx.close(); }
  }
  async function archive() {
    if (!current) return;
    const ok = await write.run(async () => { await api(`/api/inventory/items/${current.id}/archive`, post({ version: current.version })); await ctx.refreshNow(); });
    if (ok) { ctx.announce(`Archived ${current.name}.`, 'inventory-add-item'); ctx.close(); }
  }
  return <Modal open onClose={() => { if (!write.busy) ctx.close(); }} title={item ? 'Edit this item' : 'Add an item'} description={item ? 'Rename it, or archive it once you no longer keep it at home.' : 'Something you keep at home. You can add how much you have next.'}>
    <form className="stack" onSubmit={submit} noValidate>
      <FamilyFeedback error={write.error} />
      <fieldset className="family-form-fields stack" disabled={write.busy}>
        <Fld id={`${uid}-name`} label="Name" error={problem}>{props => <input {...props} className="input" value={name} maxLength={200} required autoComplete="off" placeholder="Plain flour" onChange={event => setName(event.target.value)} />}</Fld>
        {!item && <Fld id={`${uid}-dim`} label="How do you measure it?" hint="This can’t be changed later, so every amount of it stays comparable.">
          {props => <select {...props} className="input" value={dim} onChange={event => setDim(event.target.value as StockDimension)}>{(Object.keys(DIMENSION_LABELS) as StockDimension[]).map(value => <option key={value} value={value}>{DIMENSION_LABELS[value]}</option>)}</select>}
        </Fld>}
        <div className="family-form-actions">
          <Button type="button" variant="secondary" onClick={ctx.close}>Cancel</Button>
          <Button type="submit" busy={write.busy}>{item ? 'Save name' : 'Add item'}</Button>
        </div>
      </fieldset>
    </form>
    {item && <div className="inventory-danger">
      {confirming ? <><p role="status">Archive {item.name}? It leaves your list. Its history is kept, and you can’t archive it while it still has stock.</p>
        <div className="inventory-row-actions"><Button variant="secondary" onClick={() => setConfirming(false)} disabled={write.busy}>Keep it</Button><Button variant="danger" onClick={() => void archive()} busy={write.busy}>Yes, archive {item.name}</Button></div></>
        : <Button variant="ghost" onClick={() => setConfirming(true)} disabled={write.busy}><Archive size={16} aria-hidden="true" />Archive this item</Button>}
    </div>}
  </Modal>;
}

function StockDialog({ ctx, item }: { ctx: Ctx; item: InvItem }) {
  const uid = useId();
  const write = useWrite(ctx.quietReload);
  const [amount, setAmount] = useState<Amount>({ amount: '', unit: unitsFor(item.dim)[0][0], profile: '' });
  const [precision, setPrecision] = useState<'exact' | 'estimated'>('exact');
  const [step, setStep] = useState(1000);
  const [locationId, setLocationId] = useState('');
  const [dateKind, setDateKind] = useState<'' | 'best_by' | 'use_by'>('');
  const [date, setDate] = useState('');
  const [note, setNote] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  useFocusFirst(`${uid}-amount`);
  const problem = checkAmount(amount, item.dim, {});
  const dateProblem = dateKind && !date ? 'Choose the date, or pick “No date”.' : null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setShowErrors(true);
    if (problem) { focusSoon(`${uid}-${problem.field}`); return; }
    if (dateProblem) { focusSoon(`${uid}-date`); return; }
    const body = {
      itemId: item.id, locationId: locationId || null, amount: amount.amount.trim(), unit: amount.unit, profile: needsConvention(amount.unit) ? amount.profile || undefined : undefined,
      precision, estBp: precision === 'estimated' ? step : undefined, dateKind: dateKind || undefined, date: dateKind ? date : undefined, note: note.trim(),
    };
    const ok = await write.run(async () => {
      await api('/api/inventory/lots', post({ txnId: write.txnFor(JSON.stringify(body)), ...body }));
      await ctx.refreshNow();
    });
    if (ok) { ctx.announce(`Added ${show(quantityOf(amount, item.dim, {}), item.dim)} of ${item.name}${precision === 'estimated' ? ' (estimated)' : ''}.`); ctx.close(); }
  }
  return <Modal open onClose={() => { if (!write.busy) ctx.close(); }} title={`Add stock: ${item.name}`} description="Note how much you have and where it lives.">
    <form className="stack" onSubmit={submit} noValidate>
      <FamilyFeedback error={write.error} />
      <fieldset className="family-form-fields stack" disabled={write.busy}>
        <AmountInputs uid={uid} dimension={item.dim} value={amount} memory={ctx.memory} problem={showErrors ? problem : null} onChange={setAmount} />
        <Precision uid={uid} precision={precision} step={step} onChange={(next, nextStep) => { setPrecision(next); setStep(nextStep); }} />
        <Fld id={`${uid}-location`} label="Where is it?">
          {props => <select {...props} className="input" value={locationId} onChange={event => setLocationId(event.target.value)}><option value="">No set place</option>{ctx.state.locations.map(place => <option key={place.id} value={place.id}>{place.name}</option>)}</select>}
        </Fld>
        <div className="inventory-amount-row">
          <Fld id={`${uid}-datekind`} label="Date on the package">
            {props => <select {...props} className="input" value={dateKind} onChange={event => setDateKind(event.target.value as '' | 'best_by' | 'use_by')}><option value="">No date</option><option value="best_by">Best by</option><option value="use_by">Use by</option></select>}
          </Fld>
          {dateKind && <Fld id={`${uid}-date`} label="Date" error={showErrors ? dateProblem : null}>{props => <input {...props} className="input" type="date" value={date} required onChange={event => setDate(event.target.value)} />}</Fld>}
        </div>
        <Fld id={`${uid}-note`} label="A note" hint="Optional, such as “opened last week”.">{props => <input {...props} className="input" value={note} maxLength={500} autoComplete="off" onChange={event => setNote(event.target.value)} />}</Fld>
        <div className="family-form-actions"><Button type="button" variant="secondary" onClick={ctx.close}>Cancel</Button><Button type="submit" busy={write.busy}>Add stock</Button></div>
      </fieldset>
    </form>
  </Modal>;
}

type Mode = 'add' | 'remove' | 'set';
const MODE_TEXT: Readonly<Record<Mode, { title: string; description: string; button: string }>> = {
  add: { title: 'Add more', description: 'You bought more, or topped this up.', button: 'Add to stock' },
  remove: { title: 'Use some', description: 'You used some, or it went off.', button: 'Remove from stock' },
  set: { title: 'Recount', description: 'Check the shelf and set what is really there.', button: 'Save recount' },
};

function AdjustDialog({ ctx, lot, item, mode }: { ctx: Ctx; lot: InvLot; item: InvItem; mode: Mode }) {
  const uid = useId();
  const write = useWrite(ctx.quietReload);
  const latest = ctx.state.lots.find(candidate => candidate.id === lot.id);
  const entered = lot.enteredText.split(' ').slice(1).join(' ');
  const defaultUnit = unitsFor(item.dim).find(([unit]) => unit === entered)?.[0] ?? unitsFor(item.dim)[0][0];
  const [amount, setAmount] = useState<Amount>({ amount: '', unit: defaultUnit, profile: '' });
  const [precision, setPrecision] = useState<'exact' | 'estimated'>(lot.precision);
  const [step, setStep] = useState(lot.estBp || 1000);
  const [reason, setReason] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  useFocusFirst(`${uid}-amount`);
  const text = MODE_TEXT[mode];
  const parsed = useMemo(() => {
    try { return stockQuantity({ amount: amount.amount, unit: amount.unit, profile: amount.profile || undefined }, item.dim, { allowZero: mode === 'set' }); } catch { return null; }
  }, [amount, item.dim, mode]);
  let problem = checkAmount(amount, item.dim, { allowZero: mode === 'set' });
  if (!problem && mode === 'remove' && parsed?.ok && latest && parsed.qty > latest.qty) problem = { field: 'amount', message: 'There is less than that recorded. Use a recount if the shelf differs.' };

  async function submit(event: FormEvent) {
    event.preventDefault();
    setShowErrors(true);
    if (!latest) return;
    if (problem) { focusSoon(`${uid}-${problem.field}`); return; }
    const body = {
      version: latest.version, mode, amount: amount.amount.trim(), unit: amount.unit, profile: needsConvention(amount.unit) ? amount.profile || undefined : undefined,
      precision: mode === 'set' ? precision : undefined, estBp: mode === 'set' && precision === 'estimated' ? step : undefined, reason: reason.trim(),
    };
    const ok = await write.run(async () => {
      await api(`/api/inventory/lots/${lot.id}/adjust`, post({ txnId: write.txnFor(JSON.stringify(body)), ...body }));
      await ctx.refreshNow();
    });
    if (ok) {
      const qty = show(quantityOf(amount, item.dim, { allowZero: true }), item.dim);
      ctx.announce(mode === 'set' ? `Recounted ${item.name}: ${precision === 'estimated' ? 'about ' : ''}${qty}.` : mode === 'add' ? `Added ${qty} to ${item.name}.` : `Removed ${qty} from ${item.name}.`);
      ctx.close();
    }
  }
  return <Modal open onClose={() => { if (!write.busy) ctx.close(); }} title={`${text.title}: ${item.name}`} description={latest ? `Currently ${latest.precision === 'estimated' ? 'about ' : ''}${show(latest.qty, item.dim)}. ${text.description}` : text.description}>
    <form className="stack" onSubmit={submit} noValidate>
      {!latest && <div className="family-error" role="alert"><span>This stock is no longer on your list. Close this to see the latest.</span></div>}
      <FamilyFeedback error={write.error} />
      <fieldset className="family-form-fields stack" disabled={write.busy || !latest}>
        <AmountInputs uid={uid} dimension={item.dim} value={amount} memory={ctx.memory} problem={showErrors ? problem : null} onChange={setAmount} label={mode === 'set' ? 'What is there now?' : mode === 'add' ? 'How much more?' : 'How much did you use?'} />
        {mode === 'set' && <Precision uid={uid} precision={precision} step={step} current={lot.estBp || undefined} onChange={(next, nextStep) => { setPrecision(next); setStep(nextStep); }} />}
        <Fld id={`${uid}-reason`} label="Why? (optional)" hint="Shown in the history, such as “Made soup”.">{props => <input {...props} className="input" value={reason} maxLength={200} autoComplete="off" onChange={event => setReason(event.target.value)} />}</Fld>
        <div className="family-form-actions"><Button type="button" variant="secondary" onClick={ctx.close}>Cancel</Button><Button type="submit" busy={write.busy}>{text.button}</Button></div>
      </fieldset>
    </form>
  </Modal>;
}

function ArchiveLotDialog({ ctx, lot, item }: { ctx: Ctx; lot: InvLot; item: InvItem }) {
  const uid = useId();
  const write = useWrite(ctx.quietReload);
  const latest = ctx.state.lots.find(candidate => candidate.id === lot.id);
  const [reason, setReason] = useState('');
  useFocusFirst(`${uid}-reason`);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!latest) return;
    const body = { version: latest.version, reason: reason.trim() };
    const ok = await write.run(async () => {
      await api(`/api/inventory/lots/${lot.id}/archive`, post({ txnId: write.txnFor(JSON.stringify(body)), ...body }));
      await ctx.refreshNow();
    });
    if (ok) { ctx.announce(`Archived ${show(lot.qty, item.dim)} of ${item.name}.`, `inventory-item-${item.id}`); ctx.close(); }
  }
  return <Modal open onClose={() => { if (!write.busy) ctx.close(); }} title={`Archive this ${item.name}?`} description="It leaves your shelves. The history keeps a record of it.">
    <form className="stack" onSubmit={submit} noValidate>
      {!latest && <div className="family-error" role="alert"><span>This stock is already gone from your list.</span></div>}
      <FamilyFeedback error={write.error} />
      <p className="inventory-confirm-line"><strong>{latest ? show(latest.qty, item.dim) : show(lot.qty, item.dim)}</strong> of {item.name}{latest?.precision === 'estimated' ? ' (estimated)' : ''}</p>
      <fieldset className="family-form-fields stack" disabled={write.busy || !latest}>
        <Fld id={`${uid}-reason`} label="Why? (optional)" hint="For example “Finished it” or “Past its date”.">{props => <input {...props} className="input" value={reason} maxLength={200} autoComplete="off" onChange={event => setReason(event.target.value)} />}</Fld>
        <div className="family-form-actions"><Button type="button" variant="secondary" onClick={ctx.close}>Keep it</Button><Button type="submit" variant="danger" busy={write.busy}>Archive stock</Button></div>
      </fieldset>
    </form>
  </Modal>;
}

function LocationsDialog({ ctx }: { ctx: Ctx }) {
  const uid = useId();
  const write = useWrite(ctx.quietReload);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<InvLocationKind>('pantry');
  const [problem, setProblem] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  useFocusFirst(`${uid}-name`);
  async function add(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) { setProblem('Give this place a name.'); focusSoon(`${uid}-name`); return; }
    setProblem(null);
    if (await write.run(async () => { await api<InvLocation>('/api/inventory/locations', post({ name: name.trim(), kind })); await ctx.refreshNow(); })) {
      setMessage(`Added ${name.trim()}.`); setName(''); focusSoon(`${uid}-name`);
    }
  }
  async function archive(place: InvLocation) {
    const latest = ctx.state.locations.find(candidate => candidate.id === place.id);
    if (!latest) return;
    if (await write.run(async () => { await api(`/api/inventory/locations/${place.id}/archive`, post({ version: latest.version })); await ctx.refreshNow(); })) {
      setConfirming(null); setMessage(`Archived ${place.name}.`); focusSoon(`${uid}-name`);
    }
  }
  return <Modal open onClose={() => { if (!write.busy) ctx.close(); }} title="Where things live" description="Pantry shelves, the fridge, a freezer drawer. Archiving a place keeps its history.">
    <div className="stack">
      <p className="inventory-live" role="status">{message}</p>
      <FamilyFeedback error={write.error} />
      {ctx.state.locations.length ? <ul className="inventory-places" aria-label="Your places">
        {ctx.state.locations.map(place => <li key={place.id}>
          <span className="inventory-place-name"><MapPin size={16} aria-hidden="true" /><span><strong>{place.name}</strong><small>{LOCATION_KINDS.find(option => option.value === place.kind)?.label}</small></span></span>
          {confirming === place.id
            ? <span className="inventory-row-actions"><Button size="sm" variant="secondary" onClick={() => setConfirming(null)} disabled={write.busy}>Keep<span className="sr-only"> {place.name}</span></Button><Button size="sm" variant="danger" busy={write.busy} onClick={() => void archive(place)}>Yes, archive<span className="sr-only"> {place.name}</span></Button></span>
            : <Button size="sm" variant="ghost" disabled={write.busy} onClick={() => { setConfirming(place.id); setMessage(''); write.setError(null); }}>Archive<span className="sr-only"> {place.name}</span></Button>}
        </li>)}
      </ul> : <p className="muted">No places yet. Add one below.</p>}
      <form className="stack inventory-add-place" onSubmit={add} noValidate>
        <fieldset className="family-form-fields stack" disabled={write.busy}>
          <legend>Add a place</legend>
          <Fld id={`${uid}-name`} label="Name" error={problem}>{props => <input {...props} className="input" value={name} maxLength={100} autoComplete="off" required placeholder="Pantry shelf" onChange={event => setName(event.target.value)} />}</Fld>
          <Fld id={`${uid}-kind`} label="Kind of place">{props => <select {...props} className="input" value={kind} onChange={event => setKind(event.target.value as InvLocationKind)}>{LOCATION_KINDS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>}</Fld>
          <div className="family-form-actions"><Button type="button" variant="secondary" onClick={ctx.close}>Done</Button><Button type="submit" busy={write.busy}>Add place</Button></div>
        </fieldset>
      </form>
    </div>
  </Modal>;
}

function HistoryDialog({ ctx }: { ctx: Ctx }) {
  const { members } = useFamily();
  const [entries, setEntries] = useState<InvLedgerEntry[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);
  const mounted = useRef(true);
  const flight = useRef(false);
  const endRef = useRef<HTMLParagraphElement>(null);
  const more = useCallback(async (cursor: number | null, append: boolean) => {
    if (flight.current) return;
    flight.current = true;
    setLoading(true);
    setError(null);
    try {
      const page = await api<{ entries: InvLedgerEntry[]; next: number | null }>(`/api/inventory/ledger?limit=${HISTORY_PAGE}${cursor ? `&before=${cursor}` : ''}`);
      if (!mounted.current) return;
      setEntries(previous => append ? [...previous, ...page.entries.filter(entry => !previous.some(old => old.seq === entry.seq))] : page.entries);
      setNext(page.next);
      if (page.next === null) setFinished(true);
    } catch (cause) { if (mounted.current) setError(messageOf(cause)); }
    finally { flight.current = false; if (mounted.current) setLoading(false); }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void more(null, false);
    return () => { mounted.current = false; };
  }, [more]);
  const wasLoadingMore = useRef(false);
  useEffect(() => { if (finished && wasLoadingMore.current) endRef.current?.focus(); }, [finished]);
  const when = (seconds: number) => new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: ctx.timezone }).format(new Date(seconds * 1000));
  return <Modal open onClose={ctx.close} title="History" description="Every change to your stock, newest first.">
    <div className="stack">
      <FamilyFeedback error={error} />
      {entries.length > 0 && <ol className="inventory-history" aria-label="Stock history">
        {entries.map(entry => {
          const item = ctx.state.items.find(candidate => candidate.id === entry.itemId);
          const who = members.find(member => member.id === entry.memberId)?.name ?? 'Someone';
          const change = !item ? null : entry.delta === 0 ? 'No change' : `${entry.delta > 0 ? '+' : '−'}${show(Math.abs(entry.delta), item.dim)}`;
          return <li key={entry.seq}>
            <div className="inventory-history-top"><strong>{item?.name ?? 'An item you archived'}</strong><Badge tone="neutral">{KIND_LABELS[entry.kind]}</Badge></div>
            <p className="inventory-history-line">{change && <span className="inventory-delta">{change}</span>}{item && <span> · now {show(entry.qtyAfter, item.dim)}</span>}{entry.reason && <span> · {entry.reason}</span>}</p>
            <p className="inventory-history-meta">{who} · {when(entry.createdAt)}</p>
          </li>;
        })}
      </ol>}
      {loading && <p role="status" className="muted">Loading history…</p>}
      {!loading && !error && entries.length === 0 && <p className="muted" role="status">Nothing has changed yet. Add some stock and it will show up here.</p>}
      {!loading && next !== null && <Button variant="secondary" onClick={() => { wasLoadingMore.current = true; void more(next, true); }}>Load more</Button>}
      {!loading && error && <Button variant="secondary" onClick={() => void more(next, entries.length > 0)}>Try again</Button>}
      {finished && entries.length > 0 && <p ref={endRef} tabIndex={-1} className="muted inventory-end">That’s everything so far.</p>}
      <div className="family-form-actions"><Button type="button" variant="secondary" onClick={ctx.close}>Close</Button></div>
    </div>
  </Modal>;
}

/* ------------------------------------------------------------------ page */

type DialogState =
  | { kind: 'item'; item?: InvItem } | { kind: 'stock'; item: InvItem } | { kind: 'adjust'; lot: InvLot; item: InvItem; mode: Mode }
  | { kind: 'archive'; lot: InvLot; item: InvItem } | { kind: 'locations' } | { kind: 'history' };

function LotRow({ lot, item, place, today, onOpen }: { lot: InvLot; item: InvItem; place: string; today: string; onOpen: (dialog: DialogState) => void }) {
  const estimated = lot.precision === 'estimated';
  const past = lot.date !== null && lot.date < today;
  const amount = `${estimated ? 'about ' : ''}${show(lot.qty, item.dim)}`;
  return <li className="inventory-lot">
    <div className="inventory-lot-top">
      <strong className="inventory-qty">{estimated ? 'About ' : ''}{show(lot.qty, item.dim)}</strong>
      {estimated && <Badge tone="amber">Estimated{lot.estBp ? `, give or take ${Math.round(lot.estBp / 100)}%` : ''}</Badge>}
      {past && <Badge tone="rose">Past date</Badge>}
    </div>
    <p className="inventory-meta">
      <span><MapPin size={14} aria-hidden="true" />{place}</span>
      {lot.date && lot.dateKind && <span><CalendarDays size={14} aria-hidden="true" />{lot.dateKind === 'use_by' ? 'Use by' : 'Best by'} {formatDate(lot.date)}</span>}
    </p>
    {lot.note && <p className="inventory-note">{lot.note}</p>}
    <div className="inventory-lot-actions" role="group" aria-label={`Actions for ${amount} of ${item.name}`}>
      <Button size="sm" variant="secondary" onClick={() => onOpen({ kind: 'adjust', lot, item, mode: 'add' })}><Plus size={15} aria-hidden="true" />Add<span className="sr-only"> to {amount} of {item.name}</span></Button>
      <Button size="sm" variant="secondary" onClick={() => onOpen({ kind: 'adjust', lot, item, mode: 'remove' })}><Minus size={15} aria-hidden="true" />Remove<span className="sr-only"> from {amount} of {item.name}</span></Button>
      <Button size="sm" variant="secondary" onClick={() => onOpen({ kind: 'adjust', lot, item, mode: 'set' })}><ClipboardCheck size={15} aria-hidden="true" />Recount<span className="sr-only"> {amount} of {item.name}</span></Button>
      <Button size="sm" variant="ghost" onClick={() => onOpen({ kind: 'archive', lot, item })}><Archive size={15} aria-hidden="true" />Archive<span className="sr-only"> {amount} of {item.name}</span></Button>
    </div>
  </li>;
}

function totalFor(lots: InvLot[], item: InvItem): string {
  const sum = lots.reduce((total, lot) => total + BigInt(lot.qty), 0n);
  const estimated = lots.some(lot => lot.precision === 'estimated');
  return estimated ? `About ${show(Number(sum), item.dim)} in total (estimated)` : `${show(Number(sum), item.dim)} in total`;
}

export function Inventory() {
  const { demo } = useFamily();
  return demo ? <InventoryDemo /> : <InventoryLive />;
}

function InventoryDemo() {
  return <div className="family-module inventory-module stack">
    <SectionHeader eyebrow="WHAT’S AT HOME" title="Inventory" description="A calm look at what you have, where it lives and what to use soon." />
    <EmptyState icon={<Package size={30} />} title="Inventory needs your real family space" description="Stock counts aren’t stored in the demo. Sign in to your own family space to keep track of your kitchen." />
  </div>;
}

function InventoryLive() {
  const family = useFamily();
  const { user, timezone } = family;
  const refreshFamily = useRef(family.refresh);
  refreshFamily.current = family.refresh;
  const today = todayInTimezone(timezone);
  const alive = useRef(true);
  const loadSeq = useRef(0);
  const shared = useRef<Promise<void> | null>(null);
  const memory = useRef<MeasurementProfile | ''>('');
  const userId = useRef(user.id);
  const [state, setState] = useState<InventoryState | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [status, setStatus] = useState('');
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    const seq = ++loadSeq.current;
    const owner = userId.current;
    // Late answers are discarded by the guards below rather than by aborting the request: cancelling and
    // immediately repeating the same no-store fetch (React StrictMode's double mount) makes Chrome fail the repeat.
    try {
      const next = await api<InventoryState>('/api/inventory');
      if (!alive.current || seq !== loadSeq.current || owner !== userId.current) return;
      setState(next); setLoadError(null); setPaused(false);
    } catch (cause) {
      if (!alive.current || seq !== loadSeq.current || owner !== userId.current) return;
      if (statusOf(cause) === 403) { setPaused(true); setState(null); void refreshFamily.current().catch(() => undefined); }
      else setLoadError(messageOf(cause));
    } finally {
      if (alive.current && seq === loadSeq.current) setLoading(false);
    }
  }, []);

  /** Mount and tab-return refreshes share one request; writes always call `load` directly for fresh data. */
  const loadShared = useCallback(() => {
    shared.current ??= load().finally(() => { shared.current = null; });
    return shared.current;
  }, [load]);
  useEffect(() => {
    alive.current = true;
    void loadShared();
    const visible = () => { if (document.visibilityState === 'visible') void loadShared(); };
    document.addEventListener('visibilitychange', visible);
    return () => { alive.current = false; document.removeEventListener('visibilitychange', visible); };
  }, [loadShared]);
  useEffect(() => { if (focusId && !dialog) { document.getElementById(focusId)?.focus(); setFocusId(null); } }, [focusId, dialog]);

  const ctx: Ctx | null = state && {
    state, today, timezone, memory, refreshNow: load, quietReload: () => void load(), close: () => setDialog(null),
    announce: (message, target) => { setStatus(message); if (target) setFocusId(target); },
  };
  const lotsByItem = useMemo(() => {
    const groups = new Map<string, InvLot[]>();
    for (const lot of state?.lots ?? []) groups.set(lot.itemId, [...groups.get(lot.itemId) ?? [], lot]);
    return groups;
  }, [state]);
  const placeName = (id: string | null) => id ? state?.locations.find(place => place.id === id)?.name ?? 'A place you archived' : 'No set place';
  const open = (next: DialogState) => { setStatus(''); setDialog(next); };

  if (paused) return <div className="family-module inventory-module stack"><SectionHeader title="Inventory" /><EmptyState icon={<Package size={30} />} title="Inventory is paused" description="Your family administrator turned this module off. Everything you saved is still here when it comes back." /></div>;

  const lotCount = state?.lots.length ?? 0;
  const estimatedCount = state?.lots.filter(lot => lot.precision === 'estimated').length ?? 0;
  const pastCount = state?.lots.filter(lot => lot.date !== null && lot.date < today).length ?? 0;
  const summary = state && state.items.length ? [
    `${state.items.length} ${state.items.length === 1 ? 'item' : 'items'}`, `${lotCount} ${lotCount === 1 ? 'stock entry' : 'stock entries'}`,
    estimatedCount ? `${estimatedCount} estimated` : '', pastCount ? `${pastCount} past ${pastCount === 1 ? 'its date' : 'their dates'}` : '',
  ].filter(Boolean).join(' · ') : '';

  return <div className="family-module inventory-module stack">
    <SectionHeader eyebrow="WHAT’S AT HOME" title="Inventory" description="A calm look at what you have, where it lives and what to use soon."
      action={<><Button id="inventory-add-item" onClick={() => open({ kind: 'item' })} disabled={!state}><Plus size={17} aria-hidden="true" />Add an item</Button><Button variant="secondary" onClick={() => open({ kind: 'locations' })} disabled={!state}><MapPin size={16} aria-hidden="true" />Places</Button><Button variant="secondary" onClick={() => open({ kind: 'history' })} disabled={!state}><History size={16} aria-hidden="true" />History</Button></>} />
    <p className="inventory-live" role="status">{status}</p>
    {loadError && <div className="family-error" role="alert"><span>{loadError}</span><Button size="sm" variant="secondary" onClick={() => { setLoadError(null); void load(); }}><RefreshCw size={14} aria-hidden="true" />Try again</Button></div>}
    {loading && !state && !loadError && <p className="muted" role="status">Loading your inventory…</p>}
    {state && <>
      {summary && <p className="inventory-summary">{summary}</p>}
      {state.items.length === 0 ? <EmptyState icon={<Package size={30} />} title="Nothing on the shelves yet" description="Add the things you keep at home, then note how much you have and where it lives." action={<Button variant="secondary" onClick={() => open({ kind: 'item' })}><Plus size={16} aria-hidden="true" />Add your first item</Button>} />
        : <ul className="inventory-groups" aria-label="Your items">
          {state.items.map(item => {
            const lots = lotsByItem.get(item.id) ?? [];
            return <li key={item.id}><section className="card inventory-group" aria-labelledby={`inventory-item-${item.id}`}>
              <header className="inventory-group-head">
                <div><h2 id={`inventory-item-${item.id}`} tabIndex={-1}>{item.name}</h2><p className="inventory-total">{lots.length ? totalFor(lots, item) : 'No stock yet'}</p></div>
                <div className="inventory-group-actions">
                  <Button size="sm" variant="secondary" onClick={() => open({ kind: 'stock', item })}><Plus size={15} aria-hidden="true" />Add stock<span className="sr-only"> for {item.name}</span></Button>
                  <Button size="sm" variant="ghost" onClick={() => open({ kind: 'item', item })} aria-label={`Edit ${item.name}`}><Pencil size={15} aria-hidden="true" /></Button>
                </div>
              </header>
              {lots.length > 0 && <ul className="inventory-lots">{lots.map(lot => <LotRow key={lot.id} lot={lot} item={item} place={placeName(lot.locationId)} today={today} onOpen={open} />)}</ul>}
            </section></li>;
          })}
        </ul>}
    </>}
    {ctx && dialog?.kind === 'item' && <ItemDialog ctx={ctx} item={dialog.item} />}
    {ctx && dialog?.kind === 'stock' && <StockDialog ctx={ctx} item={dialog.item} />}
    {ctx && dialog?.kind === 'adjust' && <AdjustDialog ctx={ctx} lot={dialog.lot} item={dialog.item} mode={dialog.mode} />}
    {ctx && dialog?.kind === 'archive' && <ArchiveLotDialog ctx={ctx} lot={dialog.lot} item={dialog.item} />}
    {ctx && dialog?.kind === 'locations' && <LocationsDialog ctx={ctx} />}
    {ctx && dialog?.kind === 'history' && <HistoryDialog ctx={ctx} />}
  </div>;
}
