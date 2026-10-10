import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChefHat, CircleCheck, CircleHelp, ClipboardCopy, Link2, ListPlus, PackageSearch, Plus, RefreshCw, Scale, TriangleAlert, Undo2 } from 'lucide-react';
import { api, useFamily } from '../store';
import { Badge, Button, Modal } from '../components/ui';
import { FamilyFeedback } from './family-ui';
import { AmountInputs, DIMENSION_LABELS, Fld, MASS_UNITS, VOLUME_UNITS, amountHint, dimensionHint, messageOf, needsConvention, post, prettyEntered, sentence, statusOf, unitsFor, useFocusFirst, useWrite } from './Inventory';
import type { Amount, AmountProblem } from './Inventory';
import { ingredientAmount } from '../../shared/recipes';
import { compare, parseQuantity, ZERO } from '../../shared/inventory/quantity';
import { formatStock, stockQuantity } from '../../shared/inventory/stock';
import { formatDate, todayInTimezone } from '../../shared/calendar';
import type { StockDimension } from '../../shared/inventory/stock';
import { resolveUnit } from '../../shared/inventory/units';
import type { MeasurementProfile } from '../../shared/inventory/units';
import type { AvailabilityItem, AvailabilityResult, ConsumeAllocation, ConsumeLine, ConsumePreview, ConsumeResult, InvAlias, InvCalibration, InvRange, InvVerdict, InventoryState } from '../../shared/inventory/wire';
import type { FamilyRecord } from '../../shared/types';
import './inventory.css';
import './availability.css';

/* ------------------------------------------------------------------ copy */

/** Reasons that stop a firm answer, versus notes that only explain how the answer was reached. */
const NOTE_REASONS: ReadonlySet<string> = new Set(['ACCEPTED_CALIBRATION', 'RANGE_DEMAND', 'ESTIMATED_STOCK', 'OZ_ASSUMED_WEIGHT']);
const trackedAs = (dim: StockDimension) => dim === 'mass' ? 'weight' : dim === 'volume' ? 'volume' : `a count of ${DIMENSION_LABELS[dim].toLowerCase()}`;
const conversionExample = (dim: StockDimension) => dim === 'mass' ? '1 cup = 120 g' : dim === 'volume' ? '100 g = 1 cup' : '1 cup = 5 eggs';

export function reasonCopy(code: string, dim: StockDimension): string {
  switch (code) {
    case 'UNKNOWN_UNIT': return 'The recipe uses a unit we don’t recognise, so it can’t be compared. Edit the recipe to use g, mL, cups, spoons or a count.';
    case 'MEASURE_PROFILE_AMBIGUOUS': return 'Cups and spoons differ by region — choose your measuring convention in Inventory';
    case 'AMBIGUOUS_OUNCE': return '“oz” could mean weight or fluid ounces, and this item isn’t tracked in a way that decides it. Change the recipe line to “fl oz” for a liquid, or to grams or pounds, or skip the line.';
    case 'OZ_ASSUMED_WEIGHT': return 'Counted “oz” as weight because you track this by weight.';
    case 'UNQUANTIFIED': return 'No exact amount (e.g. ‘to taste’) — exclude it or it can’t be confirmed';
    case 'DIM_MISMATCH_NO_CONVERSION': return `The recipe measures this differently from how you track it (${trackedAs(dim)}) — add a conversion like ${conversionExample(dim)}`;
    case 'CALIBRATION_UNACCEPTED': return 'A conversion for this item exists but hasn’t been accepted yet, so it isn’t used.';
    case 'CALIBRATION_CONFLICT': return 'Two conversions for this item disagree. Remove the wrong one in Inventory, then check again.';
    case 'ACCEPTED_CALIBRATION': return 'Uses a conversion your household accepted.';
    case 'RANGE_DEMAND': return 'The recipe gives a range of amounts, so the check allows for the full range.';
    case 'ESTIMATED_STOCK': return 'Some of your stock is an estimate, so what you have is shown as a range.';
    case 'EXPIRED_STOCK_EXCLUDED': return 'Stock past its use-by date is left out, so it isn’t suggested.';
    case 'INTERVAL_OVERLAP': return 'What you have and what the recipe needs are too close to call.';
    default: return 'This one couldn’t be compared with confidence.';
  }
}

const VERDICT_TEXT: Readonly<Record<InvVerdict, string>> = { sufficient: 'Enough', insufficient: 'Not enough', unknown: 'Can’t confirm' };
const VERDICT_TONE = { sufficient: 'green', insufficient: 'rose', unknown: 'amber' } as const;
function VerdictIcon({ verdict, size = 16 }: { verdict: InvVerdict; size?: number }) {
  return verdict === 'sufficient' ? <CircleCheck size={size} aria-hidden="true" /> : verdict === 'insufficient' ? <TriangleAlert size={size} aria-hidden="true" /> : <CircleHelp size={size} aria-hidden="true" />;
}

/** Stock quantities are integer base units; only the shared formatter turns them into words. */
const sameAmount = (range: InvRange, dim: StockDimension) => range.lo === range.hi || formatStock(range.lo, dim) === formatStock(range.hi, dim);
function amountText(range: InvRange, dim: StockDimension, complete: boolean): string {
  const low = formatStock(range.lo, dim);
  if (!complete) return range.lo === 0 ? 'Amount unclear' : `at least ${low}`;
  return sameAmount(range, dim) ? low : `${low} to ${formatStock(range.hi, dim)}`;
}
/** A single amount when the shortage is known exactly; a range only when it really is one. */
function shortText(range: InvRange, dim: StockDimension, atLeast: boolean): string {
  const low = formatStock(range.lo, dim);
  if (atLeast) return `Short by at least ${low}`;
  if (sameAmount(range, dim)) return `Short by ${low}`;
  return range.lo === 0 ? `Short by up to ${formatStock(range.hi, dim)}` : `Short by between ${low} and ${formatStock(range.hi, dim)}`;
}
/** Shopping wording: a plain amount, or the range when the shortage itself is uncertain. */
function buyText(range: InvRange, dim: StockDimension): string {
  if (sameAmount(range, dim)) return formatStock(range.lo, dim);
  return range.lo === 0 ? `up to ${formatStock(range.hi, dim)}` : `${formatStock(range.lo, dim)} to ${formatStock(range.hi, dim)}`;
}
function taskTitle(item: AvailabilityItem): string {
  const suffix = ` (${buyText(item.short!, item.dim)})`;
  const room = 200 - 'Buy: '.length - suffix.length;
  const name = item.itemName.length > room ? `${item.itemName.slice(0, Math.max(1, room - 1))}…` : item.itemName;
  return `Buy: ${name}${suffix}`;
}

/** The server decides the verdict, but nothing short of every checked item being enough may read as enough. */
function wholeVerdict(result: AvailabilityResult): InvVerdict {
  if (result.verdict === 'insufficient') return 'insufficient';
  if (result.verdict === 'sufficient' && (result.items.length === 0 || result.unmapped.length > 0 || result.items.some(item => item.verdict !== 'sufficient'))) return 'unknown';
  return result.verdict;
}
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const looksValid = (value: unknown): value is AvailabilityResult => typeof value === 'object' && value !== null && Array.isArray((value as AvailabilityResult).items) && Array.isArray((value as AvailabilityResult).unmapped) && Array.isArray((value as AvailabilityResult).excluded);

/* ------------------------------------------------------------------ panel */

type Done = { data: AvailabilityResult; signature: string };
type PantryDialog = { kind: 'cook'; servings: number; exclude: number[] } | { kind: 'match'; name: string } | { kind: 'convert'; item: { id: string; name: string; dim: StockDimension } } | { kind: 'tasks' };

/** Shown on a recipe only when the inventory module is on and this is a real family space (never the demo). */
export function PantryCheck(props: { record: FamilyRecord<'recipe'>; servings: number; validServings: boolean }) {
  const { modules, demo } = useFamily();
  if (demo || !modules.some(module => module.id === 'inventory' && module.enabled)) return null;
  return <PantryPanel {...props} />;
}

function PantryPanel({ record, servings, validServings }: { record: FamilyRecord<'recipe'>; servings: number; validServings: boolean }) {
  const { modules, user, addRecord, refresh, records } = useFamily();
  const recipe = record.data;
  const uid = useId();
  const tasksOn = modules.some(module => module.id === 'tasks' && module.enabled);
  const alive = useRef(true);
  const seq = useRef(0);
  const owner = useRef(user.id);
  owner.current = user.id;
  const refreshFamily = useRef(refresh);
  refreshFamily.current = refresh;
  const heading = useRef<HTMLHeadingElement>(null);
  const focusResult = useRef(false);
  const [excluded, setExcluded] = useState<ReadonlySet<number>>(new Set());
  const [epoch, setEpoch] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [status, setStatus] = useState('');
  const [dialog, setDialog] = useState<PantryDialog | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  const [manualCopy, setManualCopy] = useState<string | null>(null);

  useEffect(() => { alive.current = true; return () => { alive.current = false; seq.current++; }; }, []);
  useEffect(() => { if (focusId && !dialog) { document.getElementById(focusId)?.focus(); setFocusId(null); } }, [focusId, dialog]);
  useEffect(() => { if (done && focusResult.current) { focusResult.current = false; heading.current?.focus(); } }, [done]);

  const exclude = useMemo(() => [...excluded].filter(index => index < recipe.ingredients.length).sort((a, b) => a - b), [excluded, recipe.ingredients.length]);
  const signature = JSON.stringify([servings, exclude, epoch]);
  const stale = done !== null && done.signature !== signature;
  const ratio = servings / recipe.servings;
  const lineText = (index: number) => {
    const ingredient = recipe.ingredients[index];
    if (!ingredient) return 'A recipe line';
    try { return [ingredientAmount(ingredient, ratio), ingredient.unit, ingredient.name].filter(Boolean).join(' '); } catch { return ingredient.name; }
  };
  const lineName = (index: number) => recipe.ingredients[index]?.name ?? 'this line';

  function toggleExcluded(index: number) {
    setExcluded(previous => { const next = new Set(previous); if (next.has(index)) next.delete(index); else next.add(index); return next; });
  }

  async function check() {
    if (busy || !validServings) return;
    const mine = ++seq.current;
    const asked = signature;
    const who = owner.current;
    setBusy(true); setError(null); setManualCopy(null);
    try {
      const data = await api<AvailabilityResult>('/api/inventory/availability', post({ recipeId: record.id, servings, exclude }));
      if (!alive.current || mine !== seq.current || who !== owner.current) return;
      if (!looksValid(data)) throw new Error('The pantry check came back incomplete. Please try again.');
      focusResult.current = true;
      setDone({ data, signature: asked });
      const verdict = wholeVerdict(data);
      setStatus(verdict === 'sufficient' ? 'Pantry check finished: you have enough.' : verdict === 'insufficient' ? `Pantry check finished: short on ${count(data.items.filter(item => item.verdict === 'insufficient').length, 'item', 'items')}.` : 'Pantry check finished: can’t confirm. See the reasons below.');
    } catch (cause) {
      if (!alive.current || mine !== seq.current || who !== owner.current) return;
      const code = statusOf(cause);
      if (code === 403) { setError('Inventory is turned off, so the pantry check can’t run. Your inventory is kept for when it’s back on.'); void refreshFamily.current().catch(() => undefined); }
      else if (code === 404) setError('This recipe is no longer in your family space, so it can’t be checked.');
      else if (code === 422) setError('This recipe is too large to check. Try fewer servings or skip some lines.');
      else setError(messageOf(cause));
    } finally { if (alive.current && mine === seq.current) setBusy(false); }
  }

  /** Open tasks already on the list, so a second tap on "Add to Tasks" doesn't quietly double them. */
  const openTasks = useMemo(() => new Set(records.flatMap(other => other.kind === 'task' && !other.data.done ? [sameTitle(other.data.title)] : [])), [records]);
  const shortages = done && !stale ? done.data.items.filter(item => item.verdict === 'insufficient' && item.short) : [];
  const toAdd = shortages.filter(item => !added.has(taskTitle(item)));

  async function copyShortages() {
    const text = [`Shortages for ${recipe.title} (${count(servings, 'serving', 'servings')})`, ...shortages.map(item => `- ${item.itemName}: ${buyText(item.short!, item.dim)}`)].join('\n');
    try {
      if (!navigator.clipboard) throw new Error('No clipboard');
      await navigator.clipboard.writeText(text);
      if (alive.current) { setManualCopy(null); setStatus(`Copied ${count(shortages.length, 'shortage', 'shortages')} to your clipboard.`); }
    } catch { if (alive.current) { setManualCopy(text); setStatus('Couldn’t copy automatically. Select the text below to copy it.'); } }
  }

  function changed(message: string) {
    setDialog(null);
    setEpoch(value => value + 1);
    setStatus(message);
    setFocusId(`${uid}-check`);
  }

  const verdict = done ? wholeVerdict(done.data) : null;
  const insufficient = done?.data.items.filter(item => item.verdict === 'insufficient').length ?? 0;
  const unknownItems = done?.data.items.filter(item => item.verdict === 'unknown').length ?? 0;
  const unmappedCount = done?.data.unmapped.length ?? 0;
  const portal = (node: ReactNode) => createPortal(node, document.body);

  return <section className="pantry-check" aria-labelledby={`${uid}-title`}>
    <div className="pantry-head">
      <h2 id={`${uid}-title`}>Pantry check</h2>
      <PackageSearch size={21} aria-hidden="true" />
    </div>
    <p className="pantry-intro">See whether what you have at home covers {count(servings, 'serving', 'servings')}. It runs only when you tap the button, and no AI is involved.</p>
    <details className="pantry-lines">
      <summary>Skip optional lines{excluded.size ? ` · ${excluded.size} skipped` : ''}</summary>
      <p className="pantry-soft">Garnish or “nice to have” lines you don’t need stock for. Skipped lines are left out of the check.</p>
      <ul>{recipe.ingredients.map((_, index) => <li key={index}><span className="pantry-line-text">{lineText(index)}</span><ExcludeToggle uid={`${uid}-d`} index={index} name={lineName(index)} checked={excluded.has(index)} onToggle={toggleExcluded} /></li>)}</ul>
    </details>
    <div className="pantry-actions">
      <Button id={`${uid}-check`} onClick={() => void check()} busy={busy} disabled={!validServings}>
        {done ? <RefreshCw size={16} aria-hidden="true" /> : <PackageSearch size={16} aria-hidden="true" />}{busy ? 'Checking…' : done ? 'Check again' : 'Check pantry'}
      </Button>
      {!validServings && <p className="pantry-soft">Choose a whole number of servings from 1 to 1,000 first.</p>}
    </div>
    <div className="sr-only" aria-live="polite" aria-atomic="true">{status}</div>
    {error && <div className="pantry-error" role="alert"><TriangleAlert size={18} aria-hidden="true" /><span>{error}</span><Button size="sm" variant="secondary" onClick={() => void check()} disabled={busy}>Try again</Button></div>}

    {done && verdict && <div className={`pantry-result ${stale ? 'is-stale' : ''}`}>
      {stale
        ? <div className="pantry-banner stale"><RefreshCw size={22} aria-hidden="true" /><div><h3 ref={heading} tabIndex={-1}>This check is out of date</h3><p>You changed servings, skipped lines or matches since it ran. Choose “Check again” for a current answer.</p></div></div>
        : <div className={`pantry-banner ${verdict}`}><VerdictIcon verdict={verdict} size={24} /><div>
          <h3 ref={heading} tabIndex={-1}>{verdict === 'sufficient' ? 'You have enough' : verdict === 'insufficient' ? 'Not enough yet' : done.data.items.length === 0 ? 'Nothing to compare' : 'Can’t confirm'}</h3>
          <p>{verdict === 'sufficient' ? `Everything checked is covered for ${count(done.data.servings, 'serving', 'servings')}${done.data.excluded.length ? `, with ${count(done.data.excluded.length, 'line', 'lines')} skipped by you` : ''}.`
            : verdict === 'insufficient' ? `Short on ${count(insufficient, 'item', 'items')} for ${count(done.data.servings, 'serving', 'servings')}${unmappedCount + unknownItems ? `. ${[unmappedCount ? `${count(unmappedCount, 'ingredient isn’t', 'ingredients aren’t')} matched` : '', unknownItems ? `${count(unknownItems, 'item', 'items')} can’t be confirmed` : ''].filter(Boolean).join(' and ')}` : ''}.`
              : done.data.items.length === 0 ? 'No ingredient was matched to your inventory, so there is nothing to compare yet.'
                : `This isn’t a yes. ${[unmappedCount ? `${count(unmappedCount, 'ingredient isn’t', 'ingredients aren’t')} matched to your inventory` : '', unknownItems ? `${count(unknownItems, 'item needs', 'items need')} a decision (see the reasons)` : ''].filter(Boolean).join(', and ')}.`}</p>
        </div></div>}

      {!stale && shortages.length > 0 && <div className="pantry-actions">
        <Button variant="secondary" onClick={() => void copyShortages()}><ClipboardCopy size={16} aria-hidden="true" />Copy shortages</Button>
        {tasksOn && (toAdd.length > 0 ? <Button variant="secondary" id={`${uid}-add-tasks`} onClick={() => setDialog({ kind: 'tasks' })}><ListPlus size={16} aria-hidden="true" />Add to Tasks</Button> : <Button variant="secondary" id={`${uid}-add-tasks`} disabled><ListPlus size={16} aria-hidden="true" />Added to Tasks</Button>)}
      </div>}
      {!stale && <div className="pantry-actions">
        <Button id={`${uid}-cook`} variant="secondary" onClick={() => setDialog({ kind: 'cook', servings, exclude })}><ChefHat size={16} aria-hidden="true" />Cook this</Button>
      </div>}
      {manualCopy !== null && <div className="field"><label htmlFor={`${uid}-manual`}>Copy these shortages</label><textarea id={`${uid}-manual`} className="input" readOnly rows={Math.min(8, manualCopy.split('\n').length + 1)} value={manualCopy} onFocus={event => event.currentTarget.select()} /></div>}

      {done.data.items.length > 0 && <>
        <h3 className="pantry-sub" id={`${uid}-items`}>Items checked{stale ? ' (out of date)' : ''}</h3>
        <ul className="pantry-items" aria-labelledby={`${uid}-items`}>
          {done.data.items.map(item => <ItemRow key={item.itemId} item={item} stale={stale} uid={uid} lineText={lineText} lineName={lineName} excluded={excluded} onToggle={toggleExcluded} onConvert={() => setDialog({ kind: 'convert', item: { id: item.itemId, name: item.itemName, dim: item.dim } })} />)}
        </ul>
      </>}

      {done.data.unmapped.length > 0 && <>
        <h3 className="pantry-sub" id={`${uid}-unmapped`}>Not matched to your inventory{stale ? ' (out of date)' : ''}</h3>
        <p className="pantry-soft">These ingredients stop a firm answer until you match them to something you keep, or skip them.</p>
        <ul className="pantry-items" aria-labelledby={`${uid}-unmapped`}>
          {done.data.unmapped.map(line => <li key={line.index} className="pantry-item">
            <div className="pantry-item-head"><strong>{lineText(line.index)}</strong></div>
            <div className="pantry-row-actions">
              <Button size="sm" variant="secondary" onClick={() => setDialog({ kind: 'match', name: line.name })}><Link2 size={15} aria-hidden="true" />Match to inventory item<span className="sr-only"> for {line.name}</span></Button>
              <ExcludeToggle uid={`${uid}-u`} index={line.index} name={line.name} checked={excluded.has(line.index)} onToggle={toggleExcluded} />
            </div>
          </li>)}
        </ul>
      </>}

      {done.data.excluded.length > 0 && <p className="pantry-soft">Skipped by you: {done.data.excluded.map(index => lineName(index)).join(', ')}.</p>}
    </div>}

    {dialog?.kind === 'cook' && portal(<CookDialog recipeId={record.id} servings={dialog.servings} exclude={dialog.exclude} lineText={lineText} lineName={lineName}
      onClose={changed => { setDialog(null); setFocusId(changed ? `${uid}-check` : `${uid}-cook`); }}
      onChanged={kind => { setEpoch(value => value + 1); setStatus(kind === 'cooked' ? `Recorded what you used for ${recipe.title}. Check the pantry again for a current answer.` : `Put back what was used for ${recipe.title}. Check the pantry again for a current answer.`); }} />)}
    {dialog?.kind === 'match' && portal(<MatchDialog name={dialog.name} onClose={() => { setDialog(null); }} onDone={message => changed(message)} />)}
    {dialog?.kind === 'convert' && portal(<ConvertDialog item={dialog.item} onClose={() => setDialog(null)} onDone={message => changed(message)} />)}
    {dialog?.kind === 'tasks' && portal(<TasksDialog titles={toAdd.map(taskTitle)} onList={openTasks} addTask={title => addRecord('task', { title, done: false }).then(() => undefined)} onClose={() => setDialog(null)}
      onFinished={(titles, skipped, all) => {
        setAdded(previous => new Set([...previous, ...titles, ...skipped]));
        if (all) {
          setDialog(null);
          setStatus(`${titles.length ? `Added ${count(titles.length, 'task', 'tasks')} to Tasks.` : 'Nothing new to add.'}${skipped.length ? ` Left out ${skipped.length} that ${skipped.length === 1 ? 'was' : 'were'} already on your list.` : ''}`);
          setFocusId(`${uid}-add-tasks`);
        }
      }} />)}
  </section>;
}

function ExcludeToggle({ uid, index, name, checked, onToggle }: { uid: string; index: number; name: string; checked: boolean; onToggle: (index: number) => void }) {
  return <label className="pantry-toggle" htmlFor={`${uid}-skip-${index}`}>
    <input id={`${uid}-skip-${index}`} type="checkbox" checked={checked} aria-label={`Exclude from check: ${name}`} onChange={() => onToggle(index)} />
    <span>Exclude from check</span>{checked && <Badge tone="neutral">Optional — skipped by you</Badge>}
  </label>;
}

function ItemRow({ item, stale, uid, lineText, lineName, excluded, onToggle, onConvert }: { item: AvailabilityItem; stale: boolean; uid: string; lineText: (index: number) => string; lineName: (index: number) => string; excluded: ReadonlySet<number>; onToggle: (index: number) => void; onConvert: () => void }) {
  const reasons = [...new Set(item.reasons)];
  const blocking = reasons.filter(code => !NOTE_REASONS.has(code));
  const notes = reasons.filter(code => NOTE_REASONS.has(code));
  const showShort = item.verdict === 'insufficient' && item.short;
  return <li className={`pantry-item ${item.verdict}`}>
    <div className="pantry-item-head">
      <strong>{item.itemName}</strong>
      <Badge tone={VERDICT_TONE[item.verdict]}><VerdictIcon verdict={item.verdict} size={14} />{VERDICT_TEXT[item.verdict]}</Badge>
    </div>
    <dl className="pantry-amounts">
      <div><dt>Need</dt><dd>{amountText(item.need, item.dim, item.needComplete)}</dd></div>
      <div><dt>You have</dt><dd>{amountText(item.have, item.dim, item.haveComplete)}</dd></div>
    </dl>
    {showShort && <p className="pantry-short"><TriangleAlert size={15} aria-hidden="true" /><span>{shortText(item.short!, item.dim, !item.needComplete)}{amountText(item.need, item.dim, item.needComplete) === amountText(item.have, item.dim, item.haveComplete) ? ' (too small to show in the amounts above)' : ''}</span></p>}
    {item.lineIndexes.length > 0 && <p className="pantry-soft">From: {item.lineIndexes.map(lineText).join('; ')}</p>}
    {(blocking.length > 0 || notes.length > 0) && <ul className="pantry-reasons" aria-label={`Why, for ${item.itemName}`}>
      {blocking.map(code => <li key={code} data-reason={code}>{reasonCopy(code, item.dim)}</li>)}
      {notes.map(code => <li key={code} data-reason={code} className="note">{reasonCopy(code, item.dim)}</li>)}
    </ul>}
    {!stale && (reasons.includes('DIM_MISMATCH_NO_CONVERSION') || reasons.includes('MEASURE_PROFILE_AMBIGUOUS')) && <div className="pantry-row-actions">
      {reasons.includes('DIM_MISMATCH_NO_CONVERSION') && <Button size="sm" variant="secondary" onClick={onConvert}><Scale size={15} aria-hidden="true" />Add conversion<span className="sr-only"> for {item.itemName}</span></Button>}
      {reasons.includes('MEASURE_PROFILE_AMBIGUOUS') && <a className="button secondary small pantry-link" href="#inventory">Open Inventory<span className="sr-only"> to choose your measuring convention</span></a>}
    </div>}
    {reasons.includes('UNQUANTIFIED') && <div className="pantry-row-actions">{item.lineIndexes.map(index => <ExcludeToggle key={index} uid={`${uid}-i`} index={index} name={lineName(index)} checked={excluded.has(index)} onToggle={onToggle} />)}</div>}
  </li>;
}

/* ------------------------------------------------------------------ dialogs */

function DialogBody({ children }: { children: ReactNode }) { return <div className="family-module inventory-module stack pantry-dialog">{children}</div>; }
const normalise = (state: InventoryState) => ({ ...state, aliases: state.aliases ?? [] as InvAlias[], calibrations: state.calibrations ?? [] as InvCalibration[] });

function MatchDialog({ name, onClose, onDone }: { name: string; onClose: () => void; onDone: (message: string) => void }) {
  const uid = useId();
  const mounted = useRef(true);
  const [inventory, setInventory] = useState<InventoryState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [itemId, setItemId] = useState('');
  const [newName, setNewName] = useState(name.slice(0, 200));
  const [dim, setDim] = useState<StockDimension>('mass');
  const [problem, setProblem] = useState<string | null>(null);
  const created = useRef<{ key: string; id: string } | null>(null);
  const load = useRef<() => Promise<void>>(async () => undefined);
  load.current = async () => {
    try {
      const next = normalise(await api<InventoryState>('/api/inventory'));
      if (!mounted.current) return;
      setInventory(next); setLoadError(null);
      if (next.items.length === 0) setMode('new');
    } catch (cause) { if (mounted.current) setLoadError(statusOf(cause) === 403 ? 'Inventory is turned off right now. Turn it back on in Settings to match ingredients.' : messageOf(cause)); }
  };
  const write = useWrite(() => void load.current());
  useFocusFirst(`${uid}-existing`);
  useEffect(() => { mounted.current = true; void load.current(); return () => { mounted.current = false; }; }, []);
  const items = useMemo(() => [...(inventory?.items ?? [])].sort((a, b) => a.name.localeCompare(b.name)), [inventory]);
  const known = items.some(item => item.id === itemId);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (mode === 'existing' && !known) { setProblem('Choose which item this ingredient is.'); document.getElementById(`${uid}-item`)?.focus(); return; }
    if (mode === 'new' && !newName.trim()) { setProblem('Give the new item a name.'); document.getElementById(`${uid}-newname`)?.focus(); return; }
    setProblem(null);
    let chosenName = items.find(item => item.id === itemId)?.name ?? newName.trim();
    const ok = await write.run(async () => {
      let id = itemId;
      if (mode === 'new') {
        const key = `${newName.trim()}|${dim}`;
        // A retry after the item was created but the match failed reuses that item instead of making a duplicate.
        if (created.current?.key !== key) created.current = { key, id: (await api<{ id: string }>('/api/inventory/items', post({ name: newName.trim(), dim }))).id };
        id = created.current.id;
        chosenName = newName.trim();
      }
      await api<InvAlias>('/api/inventory/aliases', post({ name, itemId: id }));
    });
    if (ok) onDone(`Matched ${name} to ${chosenName}. Check again to include it.`);
  }
  return <Modal open onClose={() => { if (!write.busy) onClose(); }} title="Match to an inventory item" description={`Tell Hearth which item “${name}” means. It remembers this for every recipe.`}>
    <DialogBody>
      <form className="stack" onSubmit={submit} noValidate>
        <FamilyFeedback error={loadError ?? write.error} />
        <fieldset className="family-form-fields stack" disabled={write.busy}>
          <fieldset className="inventory-choice">
            <legend>This ingredient is</legend>
            <label><input id={`${uid}-existing`} type="radio" name={`${uid}-mode`} checked={mode === 'existing'} disabled={inventory !== null && items.length === 0} onChange={() => { setMode('existing'); setProblem(null); }} /><span>An item I already keep</span></label>
            <label><input type="radio" name={`${uid}-mode`} checked={mode === 'new'} onChange={() => { setMode('new'); setProblem(null); }} /><span>Something new to add to Inventory</span></label>
          </fieldset>
          {mode === 'existing'
            ? <Fld id={`${uid}-item`} label="Inventory item" error={problem} hint={!inventory && !loadError ? 'Loading your items…' : items.length === 0 ? 'You haven’t added any items yet.' : undefined}>
              {props => <select {...props} className="input" value={itemId} onChange={event => setItemId(event.target.value)}>
                <option value="">Choose an item…</option>{items.map(item => <option key={item.id} value={item.id}>{item.name} ({dimensionHint(item.dim)})</option>)}
              </select>}
            </Fld>
            : <>
              <Fld id={`${uid}-newname`} label="New item name" error={problem}>{props => <input {...props} className="input" value={newName} maxLength={200} autoComplete="off" required onChange={event => setNewName(event.target.value)} />}</Fld>
              <Fld id={`${uid}-dim`} label="How do you measure it?" hint="This can’t be changed later, so every amount of it stays comparable.">
                {props => <select {...props} className="input" value={dim} onChange={event => setDim(event.target.value as StockDimension)}>{(Object.keys(DIMENSION_LABELS) as StockDimension[]).map(value => <option key={value} value={value}>{DIMENSION_LABELS[value]}</option>)}</select>}
              </Fld>
              <p className="inventory-soft">A new item starts with no stock. Add how much you have from the Inventory page.</p>
            </>}
          <div className="family-form-actions"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" busy={write.busy} disabled={!inventory}>Save match</Button></div>
        </fieldset>
      </form>
    </DialogBody>
  </Modal>;
}

const ALL_MEASURES: readonly (readonly [string, string])[] = [...MASS_UNITS, ...VOLUME_UNITS];

function sideProblem(value: Amount): AmountProblem | null {
  const early = amountHint(value.amount, false);
  if (early) return { field: 'amount', message: early };
  const parsed = parseQuantity(value.amount);
  if (!parsed.ok) return { field: 'amount', message: parsed.reason === 'QUANTITY_LIMIT' ? 'That amount is too large.' : 'Enter one exact amount such as 2, 1/2 or 1.5.' };
  if (compare(parsed.value.lo, parsed.value.hi) !== 0) return { field: 'amount', message: 'Enter one amount, not a range.' };
  if (compare(parsed.value.lo, ZERO) <= 0) return { field: 'amount', message: 'Enter an amount greater than zero.' };
  const unit = resolveUnit(value.unit, value.profile || undefined);
  if (!unit.ok) return unit.reason === 'MEASURE_PROFILE_AMBIGUOUS' ? { field: 'profile', message: 'Cups, spoons and fluid ounces differ by region. Choose a measuring convention first.' } : { field: 'amount', message: 'This unit is not recognised.' };
  return null;
}
const dimensionOf = (value: Amount) => { const unit = resolveUnit(value.unit, value.profile || undefined); return unit.ok ? unit.unit.dimension : null; };

function ConvertDialog({ item, onClose, onDone }: { item: { id: string; name: string; dim: StockDimension }; onClose: () => void; onDone: (message: string) => void }) {
  const uid = useId();
  const write = useWrite(() => undefined);
  const memory = useRef<MeasurementProfile | ''>('');
  const units = useMemo(() => item.dim.startsWith('count:') ? [...ALL_MEASURES, ...unitsFor(item.dim)] : ALL_MEASURES, [item.dim]);
  const countUnit = item.dim.startsWith('count:') ? unitsFor(item.dim)[0][0] : 'g';
  const [from, setFrom] = useState<Amount>({ amount: '', unit: item.dim === 'volume' ? 'g' : 'cup', profile: '' });
  const [to, setTo] = useState<Amount>({ amount: '', unit: item.dim === 'mass' ? 'g' : item.dim === 'volume' ? 'cup' : countUnit, profile: '' });
  const [showErrors, setShowErrors] = useState(false);
  useFocusFirst(`${uid}-from-amount`);
  const fromProblem = sideProblem(from);
  const toProblem = sideProblem(to);
  let pairProblem: string | null = null;
  if (!fromProblem && !toProblem) {
    const a = dimensionOf(from), b = dimensionOf(to);
    if (a === b) pairProblem = 'Pick units that measure different things, such as cups and grams.';
    else if (a !== item.dim && b !== item.dim) pairProblem = `One side must be measured the way you track ${item.name} (${trackedAs(item.dim)}).`;
  }
  const problem = fromProblem ?? toProblem;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setShowErrors(true);
    if (fromProblem) { document.getElementById(`${uid}-from-${fromProblem.field}`)?.focus(); return; }
    if (toProblem) { document.getElementById(`${uid}-to-${toProblem.field}`)?.focus(); return; }
    if (pairProblem) { document.getElementById(`${uid}-to-unit`)?.focus(); return; }
    const body = {
      itemId: item.id,
      fromAmount: from.amount.trim(), fromUnit: from.unit, fromProfile: needsConvention(from.unit) ? from.profile || undefined : undefined,
      toAmount: to.amount.trim(), toUnit: to.unit, toProfile: needsConvention(to.unit) ? to.profile || undefined : undefined,
    };
    const ok = await write.run(async () => { await api<InvCalibration>('/api/inventory/calibrations', post(body)); });
    if (ok) onDone(`Saved the conversion for ${item.name}. Check again to use it.`);
  }
  return <Modal open onClose={() => { if (!write.busy) onClose(); }} title={`Add a conversion: ${item.name}`} description="Tell Hearth how a recipe measure compares with how you track this item. Saving it means you accept it for your whole household, and you can remove it later in Inventory.">
    <DialogBody>
      <form className="stack" onSubmit={submit} noValidate>
        <FamilyFeedback error={write.error} />
        <fieldset className="family-form-fields stack" disabled={write.busy}>
          <p className="inventory-soft">For example, {conversionExample(item.dim)}. Only add one you have measured or trust.</p>
          <AmountInputs uid={`${uid}-from`} dimension={item.dim} units={units} value={from} memory={memory} problem={showErrors ? fromProblem : null} onChange={setFrom} label="Recipe measure" />
          <AmountInputs uid={`${uid}-to`} dimension={item.dim} units={units} value={to} memory={memory} problem={showErrors ? toProblem : null} onChange={setTo} label="Equals" />
          {showErrors && !problem && pairProblem && <p className="field-error" role="alert">{pairProblem}</p>}
          <div className="family-form-actions"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" busy={write.busy}><Plus size={16} aria-hidden="true" />Save conversion</Button></div>
        </fieldset>
      </form>
    </DialogBody>
  </Modal>;
}

function TasksDialog({ titles, onList, addTask, onClose, onFinished }: { titles: string[]; onList: ReadonlySet<string>; addTask: (title: string) => Promise<void>; onClose: () => void; onFinished: (created: string[], skipped: string[], all: boolean) => void }) {
  const uid = useId();
  const mounted = useRef(true);
  const flight = useRef(false);
  // Looked at once when the dialog opens: tasks this dialog creates must not turn into "already on your list" mid-way.
  const [already] = useState<ReadonlySet<string>>(() => new Set(titles.filter(title => onList.has(sameTitle(title)))));
  const [remaining, setRemaining] = useState(titles);
  const [again, setAgain] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useFocusFirst(`${uid}-confirm`);
  const duplicates = remaining.filter(title => already.has(title));
  const todo = again ? remaining : remaining.filter(title => !already.has(title));
  async function confirm() {
    if (flight.current || todo.length === 0) return;
    flight.current = true; setBusy(true); setError(null);
    const created: string[] = [];
    try {
      for (const title of todo) { await addTask(title); created.push(title); }
      onFinished(created, again ? [] : duplicates, true);
    } catch (cause) {
      // Whatever was created stays created; a retry only offers what is left, so nothing is added twice.
      const left = remaining.filter(title => !created.includes(title));
      if (created.length) onFinished(created, [], false);
      // 403 means Tasks was switched off while this dialog was open; say so instead of showing the server's bare text.
      const reason = statusOf(cause) === 403 ? 'Tasks has been switched off, so tasks can’t be added right now. An administrator can turn it back on in Settings.' : messageOf(cause);
      if (mounted.current) { setRemaining(left); setError(`${created.length ? `Added ${count(created.length, 'task', 'tasks')}, but ` : ''}${reason}`); }
    } finally { flight.current = false; if (mounted.current) setBusy(false); }
  }
  return <Modal open onClose={() => { if (!busy) onClose(); }} title="Add shortages to Tasks?" description="Each shortage becomes one ordinary task that your family can see in Tasks. Nothing is added until you confirm.">
    <DialogBody>
      <FamilyFeedback error={error} />
      <p className="inventory-soft" id={`${uid}-list`}>{todo.length === 0 ? 'Nothing new will be created.' : `${count(todo.length, 'task', 'tasks')} will be created:`}</p>
      {todo.length > 0 && <ul className="pantry-task-list" aria-labelledby={`${uid}-list`}>{todo.map(title => <li key={title}>{title}</li>)}</ul>}
      {duplicates.length > 0 && <>
        <p className="inventory-soft" id={`${uid}-dupes`}>Already on your list: {again ? 'these will be added again.' : 'these will be skipped.'}</p>
        <ul className="pantry-task-list" aria-labelledby={`${uid}-dupes`}>{duplicates.map(title => <li key={title}>{title}</li>)}</ul>
        <label className="pantry-toggle" htmlFor={`${uid}-again`}><input id={`${uid}-again`} type="checkbox" checked={again} disabled={busy} onChange={event => setAgain(event.target.checked)} /><span>Add {duplicates.length === 1 ? 'it' : 'them'} again anyway</span></label>
      </>}
      <div className="family-form-actions"><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button id={`${uid}-confirm`} onClick={() => void confirm()} busy={busy} disabled={todo.length === 0}>{todo.length === 0 ? 'Nothing new to add' : `Add ${count(todo.length, 'task', 'tasks')}`}</Button></div>
    </DialogBody>
  </Modal>;
}
const sameTitle = (title: string) => title.trim().replace(/\s+/g, ' ').toLowerCase();

/* ------------------------------------------------------------------ cooking: review, confirm, undo */

type CookState = { included: boolean; edited: boolean; amount: string; unit: string | null; profile: MeasurementProfile | ''; overrides: Readonly<Record<string, string>> };
const freshCook = (): CookState => ({ included: true, edited: false, amount: '', unit: null, profile: '', overrides: {} });
const PAUSED_WRITE = 'Inventory is turned off right now, so nothing was taken out of stock. Your inventory is kept for when it’s back on.';
const CONVENTION_NEEDED = 'Cups, spoons and fluid ounces differ by region. Choose a measuring convention first.';

/** Whole-number counts, 1 kg or 1 L show in the bigger unit; everything else in g or mL, so a prefill reads as a person would write it. */
function defaultUnit(qty: number | null, dim: StockDimension): string {
  if (dim.startsWith('count:')) return unitsFor(dim)[0][0];
  if (qty !== null && qty > 0 && qty % 1e12 === 0 && dim === 'mass') return 'kg';
  if (qty !== null && qty > 0 && qty % 1e9 === 0 && dim === 'volume') return 'l';
  return dim === 'mass' ? 'g' : 'ml';
}
/** Base units in one of `unit`; null while a cup or spoon still has no measuring convention. */
function unitSize(unit: string, profile: MeasurementProfile | '', dim: StockDimension): number | null {
  try {
    const result = stockQuantity({ amount: '1', unit, profile: profile || undefined }, dim);
    return result.ok ? result.qty : null;
  } catch { return null; }
}
function sizeText(qty: number, size: number | null): string {
  if (size === null) return '';
  const value = qty / size;
  const text = value >= 0.0001 ? value.toFixed(4) : value.toFixed(9);
  return text.replace(/\.?0+$/, '') || '0';
}
function parseAmount(text: string, unit: string, profile: MeasurementProfile | '', dim: StockDimension, allowZero: boolean): { ok: true; qty: number } | { ok: false; message: string; field: 'amount' | 'profile' } {
  if (needsConvention(unit) && !profile) return { ok: false, message: CONVENTION_NEEDED, field: 'profile' };
  const early = amountHint(text, false);
  if (early) return { ok: false, message: early, field: 'amount' };
  try {
    const result = stockQuantity({ amount: text, unit, profile: profile || undefined }, dim, { allowZero });
    return result.ok ? { ok: true, qty: result.qty } : { ok: false, message: result.message, field: 'amount' };
  } catch { return { ok: false, message: 'Enter one exact amount such as 2, 1/2 or 1.5.', field: 'amount' }; }
}

type LotPlan = { alloc: ConsumeAllocation; take: number; text: string; problem: string | null };
type CookPlan = {
  unit: string; profile: MeasurementProfile | ''; size: number | null; amountText: string;
  used: number | null; problem: { field: 'amount' | 'profile'; message: string } | null;
  lots: LotPlan[]; available: number; taken: number; shortfall: number; hasOverride: boolean; lotProblem: boolean;
};

/**
 * Turns the reviewed amount into per-lot takes. Lots are filled greedily in the order the server proposed
 * (earliest date first); a lot the cook typed over keeps exactly what they typed.
 */
function planLine(line: ConsumeLine, state: CookState, household: MeasurementProfile | ''): CookPlan {
  const unit = state.unit ?? defaultUnit(line.suggested, line.dim);
  const profile = needsConvention(unit) ? state.profile || household : '';
  const size = unitSize(unit, profile, line.dim);
  const suggestedMode = !state.edited && line.suggested !== null;
  const amountText = suggestedMode ? sizeText(line.suggested!, size) : state.amount;
  let used: number | null = null;
  let problem: CookPlan['problem'] = null;
  if (suggestedMode && size !== null) used = line.suggested;
  else {
    const parsed = parseAmount(amountText, unit, profile, line.dim, false);
    if (parsed.ok) used = parsed.qty; else problem = { field: parsed.field, message: parsed.message };
  }
  const stocked = line.allocations.filter(alloc => alloc.available > 0);
  const typed = stocked.map(alloc => state.overrides[alloc.lotId]);
  const parsedOverrides = stocked.map((alloc, index) => {
    const text = typed[index];
    if (text === undefined) return null;
    const parsed = parseAmount(text, unit, profile, line.dim, true);
    if (!parsed.ok) return { qty: 0, problem: parsed.message };
    if (parsed.qty > alloc.available) return { qty: 0, problem: `That is more than the ${formatStock(alloc.available, line.dim)} in this lot.` };
    return { qty: parsed.qty, problem: null as string | null };
  });
  const fixed = parsedOverrides.reduce((sum, row) => sum + (row?.qty ?? 0), 0);
  let remaining = Math.max(0, (used ?? 0) - fixed);
  const lots: LotPlan[] = stocked.map((alloc, index) => {
    const row = parsedOverrides[index];
    if (row) return { alloc, take: row.qty, text: typed[index]!, problem: row.problem };
    const take = Math.min(remaining, alloc.available);
    remaining -= take;
    return { alloc, take, text: take > 0 ? sizeText(take, size) : '0', problem: null };
  });
  const available = stocked.reduce((sum, alloc) => sum + alloc.available, 0);
  return {
    unit, profile, size, amountText, used, problem, lots, available, taken: lots.reduce((sum, lot) => sum + lot.take, 0),
    shortfall: used === null ? 0 : Math.max(0, used - available), hasOverride: Object.keys(state.overrides).length > 0, lotProblem: lots.some(lot => lot.problem !== null),
  };
}

type CookDone = { txnId: string; summary: string[]; beyond: string[]; lots: number };
type CookFatal = { message: string; retry: boolean };
const lotNoun = (n: number) => count(n, 'lot', 'lots');

function CookDialog({ recipeId, servings, exclude, lineText, lineName, onClose, onChanged }: {
  recipeId: string; servings: number; exclude: number[]; lineText: (index: number) => string; lineName: (index: number) => string;
  onClose: (changed: boolean) => void; onChanged: (kind: 'cooked' | 'undone') => void;
}) {
  const uid = useId();
  const { refresh, timezone } = useFamily();
  const refreshFamily = useRef(refresh);
  refreshFamily.current = refresh;
  // When the server says inventory is off, the family settings are refreshed only once the dialog is dismissed:
  // refreshing sooner switches the whole panel off, and the dialog (with its explanation) would vanish unread.
  const settingsStale = useRef(false);
  const alive = useRef(true);
  const seq = useRef(0);
  const focused = useRef(false);
  const changedAny = useRef(false);
  const finished = useRef(false);
  const memory = useRef<MeasurementProfile | ''>('');
  const previous = useRef<Map<string, number>>(new Map());
  const [preview, setPreview] = useState<ConsumePreview | null>(null);
  const [inventory, setInventory] = useState<InventoryState | null>(null);
  const [fatal, setFatal] = useState<CookFatal | null>(null);
  const [refetchError, setRefetchError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [edits, setEdits] = useState<Readonly<Record<string, CookState>>>({});
  const [updated, setUpdated] = useState<ReadonlySet<string>>(new Set());
  const [showErrors, setShowErrors] = useState(false);
  const [done, setDone] = useState<CookDone | null>(null);
  const [undone, setUndone] = useState(false);
  const [refused, setRefused] = useState(false);
  const [status, setStatus] = useState('');
  const doneHeading = useRef<HTMLHeadingElement>(null);
  const today = todayInTimezone(timezone);

  /** Reads the proposal again. Used on open and after the server says stock moved; late answers lose to newer ones. */
  const load = useRef<(refetch: boolean) => Promise<void>>(async () => undefined);
  load.current = async (refetch: boolean) => {
    const mine = ++seq.current;
    setLoading(true); setRefetchError(null);
    try {
      const [next, state] = await Promise.all([
        api<ConsumePreview>('/api/inventory/consume/preview', post({ recipeId, servings, exclude })),
        api<InventoryState>('/api/inventory').catch(() => null),
      ]);
      if (!alive.current || mine !== seq.current) return;
      if (typeof next !== 'object' || next === null || !Array.isArray(next.lines) || !Array.isArray(next.unmapped) || !Array.isArray(next.excluded)) throw new Error('The ingredient list came back incomplete. Please try again.');
      const seen = previous.current;
      const moved = new Set<string>();
      if (refetch) for (const line of next.lines) for (const alloc of line.allocations) { const before = seen.get(`${alloc.lotId}`); if (before !== undefined && before !== alloc.version) moved.add(alloc.lotId); }
      previous.current = new Map(next.lines.flatMap(line => line.allocations.map(alloc => [alloc.lotId, alloc.version] as const)));
      setUpdated(moved);
      setPreview(next); setFatal(null);
      if (state) { setInventory(state); if (!memory.current && state.settings?.measureProfile) memory.current = state.settings.measureProfile; }
    } catch (cause) {
      if (!alive.current || mine !== seq.current) return;
      const code = statusOf(cause);
      if (code === 403) { setFatal({ message: 'Inventory is turned off right now, so nothing can be taken out of stock. Your inventory is kept for when it’s back on.', retry: false }); settingsStale.current = true; }
      else if (code === 404) setFatal({ message: 'This recipe is no longer in your family space, so there is nothing to cook from.', retry: false });
      else if (code === 422) setFatal({ message: 'This recipe is too large to work out exactly. Go back and skip some lines, then check again.', retry: false });
      else if (refetch) setRefetchError(messageOf(cause));
      else setFatal({ message: messageOf(cause), retry: true });
    } finally { if (alive.current && mine === seq.current) setLoading(false); }
  };
  // Opening the dialog asks once. React's development double-mount keeps refs, so the guard also stops a duplicate request there.
  const requested = useRef(false);
  useEffect(() => {
    alive.current = true;
    if (!requested.current) { requested.current = true; void load.current(false); }
    return () => { alive.current = false; };
  }, []);

  const household: MeasurementProfile | '' = inventory?.settings?.measureProfile ?? '';
  const lines = preview?.lines ?? [];
  // With no recorded stock and no suggested amount there is nothing to take and nothing to note, yet a ticked
  // box would demand an amount and make confirming fail until it was cleared by hand. Start it unticked.
  // A stockless line that has a suggested amount stays ticked: its shortfall is recorded with the cooking.
  const freshFor = (line: ConsumeLine): CookState => ({ ...freshCook(), included: line.suggested !== null || line.allocations.some(alloc => alloc.available > 0) });
  const plans = lines.map(line => planLine(line, edits[line.itemId] ?? freshFor(line), household));
  const stateOf = (line: ConsumeLine) => edits[line.itemId] ?? freshFor(line);
  const patch = (itemId: string, change: (state: CookState) => CookState) => setEdits(previousEdits => {
    const line = lines.find(candidate => candidate.itemId === itemId);
    return { ...previousEdits, [itemId]: change(previousEdits[itemId] ?? (line ? freshFor(line) : freshCook())) };
  });

  const included = lines.map((line, index) => ({ line, plan: plans[index], index })).filter(row => stateOf(row.line).included);
  const blocked = included.some(row => row.plan.problem !== null || row.plan.lotProblem);
  const takes = included.flatMap(row => row.plan.lots.filter(lot => lot.take >= 1).map(lot => ({ lotId: lot.alloc.lotId, version: lot.alloc.version, take: lot.take })));
  const shortfalls = included.filter(row => row.plan.shortfall >= 1).map(row => ({ itemId: row.line.itemId, amount: row.plan.shortfall }));
  const payload = { recipeId, servings, takes, shortfalls };
  const itemCount = included.filter(row => row.plan.lots.some(lot => lot.take >= 1)).length;

  const undoing = useRef(false);
  const write = useWrite(status => {
    if (status === 403) {
      settingsStale.current = true;
      // Before the cooking is recorded the form has nothing left to offer, so the explanation takes its place and stays until dismissed.
      if (!finished.current) setFatal({ message: PAUSED_WRITE, retry: false });
      return;
    }
    if (!finished.current) void load.current(true);
  }, (code, cause) => {
    if (undoing.current && code === 409) return `${sentence(messageOf(cause))} Nothing was changed. If the shelf looks different now, recount the lot in Inventory instead.`;
    if (undoing.current && code === 404) return 'This cooking can’t be undone any more. Nothing was changed.';
    if (code === 409) return `${sentence(messageOf(cause))} We checked your pantry again. Your amounts are still here, so look them over and try again.`;
    if (code === 404) return 'This recipe is no longer in your family space. Nothing was taken out of stock.';
    if (code === 403) return PAUSED_WRITE;
    return undefined;
  });
  /** Every way out of the dialog comes through here, so a pending settings refresh happens after the person has read the message. */
  const dismiss = (changed: boolean) => {
    if (settingsStale.current) { settingsStale.current = false; void refreshFamily.current().catch(() => undefined); }
    onClose(changed);
  };

  useEffect(() => {
    if (focused.current || !preview || lines.length === 0) return;
    focused.current = true;
    const frame = requestAnimationFrame(() => document.getElementById(`${uid}-l0-amount`)?.focus());
    return () => cancelAnimationFrame(frame);
  }, [preview, lines.length, uid]);
  useEffect(() => { if (done || undone) doneHeading.current?.focus(); }, [done, undone]);
  // A button that was just pressed can disappear (the form on a refusal, Undo once it is refused): keep focus inside the dialog.
  useEffect(() => { if (fatal) { const frame = requestAnimationFrame(() => document.getElementById(`${uid}-fatal-close`)?.focus()); return () => cancelAnimationFrame(frame); } }, [fatal, uid]);
  useEffect(() => { if (refused && !undone) { const frame = requestAnimationFrame(() => document.getElementById(`${uid}-done`)?.focus()); return () => cancelAnimationFrame(frame); } }, [refused, undone, uid]);

  async function submit() {
    if (blocked) {
      setShowErrors(true);
      const first = included.find(row => row.plan.problem || row.plan.lotProblem);
      if (first) {
        const lotIndex = first.plan.lots.findIndex(lot => lot.problem);
        requestAnimationFrame(() => document.getElementById(first.plan.problem ? `${uid}-l${first.index}-${first.plan.problem.field}` : `${uid}-l${first.index}-t${lotIndex}`)?.focus());
      }
      return;
    }
    if (takes.length === 0) return;
    const ok = await write.run(async () => {
      const result = await api<ConsumeResult>('/api/inventory/consume', post({ txnId: write.txnFor(JSON.stringify(payload)), ...payload }));
      const summary = included.filter(row => row.plan.lots.some(lot => lot.take >= 1)).map(row => `${row.line.itemName}: ${formatStock(row.plan.lots.reduce((sum, lot) => sum + lot.take, 0), row.line.dim)}`);
      const beyond = included.filter(row => row.plan.shortfall >= 1).map(row => `${row.line.itemName}: ${formatStock(row.plan.shortfall, row.line.dim)}`);
      changedAny.current = true;
      if (alive.current) { setDone({ txnId: result.txnId, summary, beyond, lots: takes.length }); setStatus('Recorded. The ingredients were taken out of stock.'); }
    });
    if (ok) { finished.current = true; onChanged('cooked'); }
  }

  async function undo() {
    if (!done) return;
    const target = done.txnId;
    undoing.current = true;
    const ok = await write.run(async () => {
      await api<ConsumeResult>(`/api/inventory/txns/${target}/undo`, post({ txnId: write.txnFor(`undo:${target}`) }));
    });
    undoing.current = false;
    if (ok) { setUndone(true); setStatus('Undone. Everything was put back exactly.'); onChanged('undone'); }
    else setRefused(true);
  }

  const title = done ? (undone ? 'Put back' : 'Recorded') : 'Cook this';
  const description = done ? undefined : `Review what you actually used${preview ? ` for ${preview.recipeTitle}` : ''}. Nothing leaves your stock until you confirm.`;
  const busyClose = () => { if (!write.busy) dismiss(changedAny.current); };

  let explain = '';
  if (!blocked && takes.length === 0) {
    explain = lines.length === 0 ? 'None of this recipe’s ingredients are matched to your inventory yet, so there is nothing to take out of stock.'
      : included.length === 0 ? 'Tick at least one ingredient to take it out of stock.'
        : 'There is no recorded stock to take from for what is ticked, so nothing can be deducted. Recount in Inventory, then try again. Hearth only records a cooking when at least one lot is reduced.';
  }
  const where = (alloc: ConsumeAllocation) => alloc.locationId === null ? 'No set place' : inventory ? inventory.locations.find(place => place.id === alloc.locationId)?.name ?? 'A place you archived' : null;

  return <Modal open onClose={busyClose} title={title} description={description}>
    <div className="family-module inventory-module stack pantry-dialog cook-dialog">
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{status}</div>
      {fatal && <>
        <FamilyFeedback error={fatal.message} />
        <div className="family-form-actions"><Button id={`${uid}-fatal-close`} variant="secondary" onClick={() => dismiss(changedAny.current)}>Close</Button>{fatal.retry && <Button onClick={() => { setFatal(null); void load.current(false); }}>Try again</Button>}</div>
      </>}
      {!fatal && !preview && loading && <p className="inventory-soft" role="status">Working out what to take…</p>}

      {done && <div className="cook-done">
        <h3 ref={doneHeading} tabIndex={-1}>{undone ? 'Everything is back where it was' : 'Done. Your stock is updated'}</h3>
        {undone
          ? <p className="inventory-soft">The same amounts were put back into the same lots.</p>
          : <>
            <p className="inventory-soft">Taken from {lotNoun(done.lots)}:</p>
            <ul className="cook-summary">{done.summary.map(text => <li key={text}>{text}</li>)}</ul>
            {done.beyond.length > 0 && <p className="inventory-soft">Also used beyond what was recorded (your stock was not changed for this): {done.beyond.join(', ')}.</p>}
          </>}
        <FamilyFeedback error={write.error} />
        {refused && !undone && <p className="inventory-soft">Undo only works while nothing else has changed those lots. You can recount them from Inventory.</p>}
        <div className="family-form-actions">
          {!undone && !refused && <Button variant="secondary" onClick={() => void undo()} busy={write.busy}><Undo2 size={16} aria-hidden="true" />Undo</Button>}
          <Button id={`${uid}-done`} onClick={() => dismiss(true)} disabled={write.busy}>Done</Button>
        </div>
      </div>}

      {!done && preview && !fatal && <>
        {refetchError && <FamilyFeedback error={`We couldn’t check your pantry again. ${refetchError}`} />}
        <FamilyFeedback error={write.error} />
        {lines.length > 0 && <ul className="cook-lines" aria-label="Ingredients to take out of stock">
          {lines.map((line, index) => {
            const st = stateOf(line);
            const plan = plans[index];
            const base = `${uid}-l${index}`;
            const hasStock = plan.lots.length > 0;
            const showProblem = plan.problem && (showErrors || st.edited || plan.problem.field === 'profile') ? plan.problem : null;
            const units = unitsFor(line.dim);
            const value: Amount = { amount: plan.amountText, unit: plan.unit, profile: plan.profile };
            const mismatch = st.included && plan.problem === null && plan.used !== null && !plan.lotProblem && plan.taken !== Math.min(plan.used, plan.available);
            return <li key={line.itemId} className={`cook-line ${st.included ? '' : 'is-off'}`}>
              <div className="cook-line-head">
                <label className="pantry-toggle cook-include" htmlFor={`${base}-on`}>
                  <input id={`${base}-on`} type="checkbox" checked={st.included} onChange={event => patch(line.itemId, state => ({ ...state, included: event.target.checked }))} />
                  <span><strong>{line.itemName}</strong><small>Take out of stock</small></span>
                </label>
                {!st.included && <Badge tone="neutral">Not deducted</Badge>}
              </div>
              <dl className="pantry-amounts">
                <div><dt>Recipe needs</dt><dd>{amountText(line.need, line.dim, line.needComplete)}</dd></div>
                <div><dt>Suggested</dt><dd>{line.suggested === null ? 'You choose' : formatStock(line.suggested, line.dim)}</dd></div>
              </dl>
              {line.suggested === null && st.included && <p className="pantry-soft">The recipe doesn’t give an exact amount here, so enter what you actually used.</p>}
              {line.reasons.includes('RANGE_DEMAND') && line.suggested !== null && <p className="pantry-soft">{reasonCopy('RANGE_DEMAND', line.dim)} The suggestion is the top of the range.</p>}
              {line.reasons.includes('EXPIRED_STOCK_EXCLUDED') && <p className="pantry-soft">{reasonCopy('EXPIRED_STOCK_EXCLUDED', line.dim)}</p>}
              {!st.included
                ? <p className="pantry-soft">Nothing will be taken out of stock for {line.itemName}.</p>
                : <>
                  <AmountInputs uid={base} dimension={line.dim} units={units} value={value} memory={memory} problem={showProblem}
                    label={`Actually used: ${line.itemName}`} unitLabel={`Unit for ${line.itemName}`} hint={line.suggested === null ? undefined : 'Change it if you used more or less.'}
                    onChange={next => patch(line.itemId, state => ({ ...state, unit: next.unit, profile: next.profile, ...(next.amount !== value.amount ? { amount: next.amount, edited: true } : {}) }))} />
                  {line.suggested !== null && st.edited && <div><Button size="sm" variant="ghost" onClick={() => patch(line.itemId, state => ({ ...state, edited: false, amount: '', overrides: {} }))}>Use the suggested amount</Button></div>}
                  {plan.shortfall >= 1 && <p className="cook-note" role="status">Recorded stock only covers {formatStock(plan.available, line.dim)} — the extra {formatStock(plan.shortfall, line.dim)} will be noted as used beyond what was recorded; nothing goes negative.</p>}
                  {hasStock
                    ? <>
                      <h3 className="cook-sub" id={`${base}-lots`}>Taken from these lots, earliest date first</h3>
                      <ol className="cook-lots" aria-labelledby={`${base}-lots`}>
                        {plan.lots.map((lot, lotIndex) => {
                          const alloc = lot.alloc;
                          const place = where(alloc);
                          const past = alloc.date !== null && alloc.date < today;
                          const entered = alloc.enteredText ? prettyEntered(alloc.enteredText) : formatStock(alloc.available, line.dim);
                          const label = `${entered}${place ? `, ${place}` : ''}`;
                          const lotProblem = lot.problem && (st.overrides[alloc.lotId] !== undefined) ? lot.problem : null;
                          return <li key={alloc.lotId} className="cook-lot">
                            <div className="cook-lot-top">
                              <strong>{alloc.precision === 'estimated' ? 'About ' : ''}{entered}</strong>
                              {alloc.precision === 'estimated' && <Badge tone="amber">Estimated</Badge>}
                              {past && <Badge tone="rose">Past date</Badge>}
                              {updated.has(alloc.lotId) && <Badge tone="neutral">Changed just now</Badge>}
                            </div>
                            <p className="pantry-soft cook-lot-meta">
                              {place && <span>{place}</span>}
                              {alloc.date && alloc.dateKind && <span>{alloc.dateKind === 'use_by' ? 'Use by' : 'Best by'} {formatDate(alloc.date)}</span>}
                              <span>{alloc.precision === 'estimated' ? 'About ' : ''}{formatStock(alloc.available, line.dim)} available</span>
                            </p>
                            <Fld id={`${base}-t${lotIndex}`} label={`Take from ${label}`} error={lotProblem}>
                              {props => <div className="cook-take">
                                <input {...props} className="input" inputMode="decimal" autoComplete="off" maxLength={64} value={lot.text}
                                  onChange={event => patch(line.itemId, state => ({ ...state, overrides: { ...state.overrides, [alloc.lotId]: event.target.value } }))} />
                                <span className="cook-unit" aria-hidden="true">{unitLabelOf(plan.unit, line.dim)}</span>
                              </div>}
                            </Fld>
                          </li>;
                        })}
                      </ol>
                      {plan.hasOverride && <div><Button size="sm" variant="ghost" onClick={() => patch(line.itemId, state => ({ ...state, overrides: {} }))}>Go back to the suggested split</Button></div>}
                      {mismatch && <p className="pantry-soft" role="status">You are taking {formatStock(plan.taken, line.dim)} from these lots{plan.used !== null ? `, while you said you used ${formatStock(plan.used, line.dim)}` : ''}. Only what is in the boxes above leaves stock.</p>}
                    </>
                    : <p className="pantry-soft">There is no recorded stock of {line.itemName} to take from.</p>}
                </>}
            </li>;
          })}
        </ul>}

        {(preview.unmapped.length > 0 || preview.excluded.length > 0) && <div className="cook-not">
          <h3 className="pantry-sub" id={`${uid}-not`}>Not deducted</h3>
          <ul className="cook-not-list" aria-labelledby={`${uid}-not`}>
            {preview.unmapped.map(line => <li key={`u${line.index}`}><span>{lineText(line.index)}</span><Badge tone="neutral">Not matched to your inventory</Badge></li>)}
            {preview.excluded.map(index => <li key={`e${index}`}><span>{lineName(index)}</span><Badge tone="neutral">Skipped by you</Badge></li>)}
          </ul>
        </div>}

        <div className="cook-summary-box">
          {takes.length > 0
            ? <p className="cook-summary-text"><strong>This will take stock from {lotNoun(takes.length)} across {count(itemCount, 'item', 'items')}.</strong>{shortfalls.length > 0 ? ` ${count(shortfalls.length, 'item has', 'items have')} amounts noted as used beyond what was recorded.` : ''} You can undo it right after.</p>
            : explain && <p className="cook-summary-text" id={`${uid}-explain`}>{explain}</p>}
        </div>
        <div className="family-form-actions">
          <Button variant="secondary" onClick={busyClose} disabled={write.busy}>Cancel</Button>
          <Button onClick={() => void submit()} busy={write.busy} disabled={loading || (!blocked && takes.length === 0)} aria-describedby={explain ? `${uid}-explain` : undefined}><ChefHat size={16} aria-hidden="true" />Use these ingredients</Button>
        </div>
      </>}
    </div>
  </Modal>;
}
const unitLabelOf = (unit: string, dim: StockDimension) => [...unitsFor(dim), ...ALL_MEASURES].find(([value]) => value === unit)?.[1] ?? unit;
