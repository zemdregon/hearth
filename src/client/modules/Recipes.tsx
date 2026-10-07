import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, BookOpen, Camera, Check, Clock3, ExternalLink, FileText, Heart, Leaf, Link2, Minus, Plus, Printer, Search, Trash2, Users, X } from 'lucide-react';
import { useFamily, useRecords } from '../store';
import { Badge, Button, EmptyState, Field, Modal, SectionHeader } from '../components/ui';
import type { FamilyRecord, Ingredient, Recipe, RecipeImportRequest, RecipeImportResponse } from '../../shared/types';
import { durationLabel, ingredientAmount, parseQuantity } from '../../shared/recipes';
import { prepareRecipePhoto, recipePhotoBase64 } from '../recipe-image';
import type { PreparedRecipePhoto } from '../recipe-image';
import './recipes.css';

const blankRecipe = (): Recipe => ({ title: '', description: '', servings: 4, prepMinutes: 0, cookMinutes: 0, ingredients: [{ name: '', quantity: null, unit: '' }], steps: [''], tags: [], favorite: false });
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Please try again.';

function recipeVisual(recipe: Recipe): { icon: string; color: string } {
  const words = `${recipe.title} ${recipe.tags.join(' ')}`.toLowerCase();
  if (/pasta|noodle|spaghetti|linguine/.test(words)) return { icon: '🍝', color: 'peach' };
  if (/salad|greens|bowl|vegetable/.test(words)) return { icon: '🥗', color: 'sage' };
  if (/breakfast|pancake/.test(words)) return { icon: '🥞', color: 'cream' };
  if (/cake|bake|cookie|dessert|bread/.test(words)) return { icon: '🥐', color: 'cream' };
  if (/soup|stew|curry|chili/.test(words)) return { icon: '🍲', color: 'clay' };
  if (/chicken|roast|poultry/.test(words)) return { icon: '🍗', color: 'peach' };
  return { icon: '🍽️', color: 'sage' };
}

export function Recipes() {
  const recipes = useRecords('recipe');
  const { addRecord, updateRecord, deleteRecord, demo } = useFamily();
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState('');
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ recipe: Recipe; record?: FamilyRecord<'recipe'>; warnings?: string[] } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const selected = recipes.find(record => record.id === selectedId);
  const tags = [...new Set(recipes.flatMap(record => record.data.tags))].sort((a, b) => a.localeCompare(b));
  const term = query.toLocaleLowerCase().trim();
  const filtered = recipes.filter(({ data }) => (!favoritesOnly || data.favorite) && (!tag || data.tags.includes(tag)) && (!term || [data.title, data.description, ...data.tags, ...data.ingredients.map(item => item.name)].some(value => value.toLocaleLowerCase().includes(term))));

  async function toggleFavorite(record: FamilyRecord<'recipe'>) {
    if (busy) return;
    setBusy(true);
    setError('');
    try { await updateRecord(record, { ...record.data, favorite: !record.data.favorite }); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }

  async function saveRecipe(recipe: Recipe) {
    if (saving) return;
    setSaving(true);
    try {
      if (editor?.record) await updateRecord(editor.record, recipe);
      else await addRecord('recipe', recipe);
      setNotice(editor?.record ? 'Recipe updated.' : 'Recipe added to your family collection.');
      setEditor(null);
    } finally { setSaving(false); }
  }

  async function removeRecipe() {
    if (!selected || busy) return;
    setBusy(true);
    setError('');
    try {
      await deleteRecord(selected);
      setSelectedId(null);
      setDeleteOpen(false);
      setNotice('Recipe deleted.');
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }

  return <div className="recipes-module stack">
    {error && <p role="alert" className="recipe-alert">{error}</p>}
    {notice && <div className="recipe-notice" role="status"><Check size={16} /><span>{notice}</span><button type="button" className="recipe-icon-button" aria-label="Dismiss notification" onClick={() => setNotice('')}><X size={16} /></button></div>}
    {selected ? <RecipeDetail record={selected} busy={busy} onBack={() => setSelectedId(null)} onFavorite={() => void toggleFavorite(selected)} onEdit={() => setEditor({ record: selected, recipe: selected.data })} onDelete={() => setDeleteOpen(true)} /> : <>
      <SectionHeader eyebrow="THE FAMILY COOKBOOK" title="A little taste of home." description="Weeknight favorites, happy experiments, and recipes worth keeping." action={<div className="recipe-header-actions"><Button variant="secondary" onClick={() => setImportOpen(true)}><Link2 size={16} />Import recipe</Button><Button onClick={() => setEditor({ recipe: blankRecipe() })}><Plus size={17} />Add recipe</Button></div>} />
      <div className="recipe-intro">
        <div><span className="eyebrow">MADE TO BE SHARED</span><h2>Good food.<br />Even better company.</h2><p>A place for everything you love to cook, together.</p></div>
        <div className="recipe-intro-illustration" aria-hidden="true"><div className="recipe-plate"><span>🌿</span><span>🍋</span><span>🍅</span></div><Leaf className="recipe-floating-leaf" size={40} strokeWidth={1.25} /></div>
        <span className="recipe-intro-caption">your own little recipe box</span>
      </div>
      <div className="recipe-library-toolbar">
        <label className="recipe-search"><Search size={19} aria-hidden="true" /><span className="sr-only">Search recipes or ingredients</span><input className="input" type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Find a recipe or ingredient…" /></label>
        <button type="button" className={`recipe-filter-button ${favoritesOnly ? 'active' : ''}`} aria-pressed={favoritesOnly} onClick={() => setFavoritesOnly(value => !value)}><Heart size={17} fill={favoritesOnly ? 'currentColor' : 'none'} />Favorites</button>
      </div>
      <div className="recipe-collection-line"><div className="recipe-tag-filters" aria-label="Recipe tags"><button type="button" className={`recipe-tag ${!tag ? 'active' : ''}`} aria-pressed={!tag} onClick={() => setTag('')}>All recipes</button>{tags.map(item => <button type="button" key={item} className={`recipe-tag ${tag === item ? 'active' : ''}`} aria-pressed={tag === item} onClick={() => setTag(tag === item ? '' : item)}>{item}</button>)}</div><span className="muted recipe-count">{filtered.length} {filtered.length === 1 ? 'recipe' : 'recipes'}</span></div>
      {filtered.length ? <div className="recipe-grid">{filtered.map(record => {
        const recipe = record.data;
        const visual = recipeVisual(recipe);
        return <article key={record.id} className="recipe-card">
          <button type="button" className="recipe-card-open" onClick={() => { setSelectedId(record.id); setNotice(''); }} aria-label={`View ${recipe.title}`}>
            <div className={`recipe-art ${visual.color}`}><div className="recipe-art-lines" /><span className="recipe-art-dish" aria-hidden="true">{visual.icon}</span><span className="recipe-art-label">FROM OUR KITCHEN</span></div>
            <div className="recipe-card-copy"><span className="recipe-card-category">{recipe.tags[0] || 'FAMILY RECIPE'}</span><h3>{recipe.title}</h3><p>{recipe.description || 'A little something from your family kitchen.'}</p><div className="recipe-card-meta"><span><Clock3 size={14} />{durationLabel(recipe.prepMinutes + recipe.cookMinutes)}</span><span><Users size={14} />Serves {recipe.servings}</span></div></div>
          </button>
          <button type="button" className={`recipe-favorite ${recipe.favorite ? 'is-favorite' : ''}`} disabled={busy} aria-label={`${recipe.favorite ? 'Unfavorite' : 'Favorite'} ${recipe.title}`} aria-pressed={recipe.favorite} onClick={() => void toggleFavorite(record)}><Heart size={18} fill={recipe.favorite ? 'currentColor' : 'none'} /></button>
        </article>;
      })}</div> : <EmptyState icon={<BookOpen size={32} />} title={recipes.length ? 'Nothing in the recipe box matches.' : 'Your family cookbook starts here.'} description={recipes.length ? 'Try another ingredient, tag, or favorite filter.' : 'Add your go-to dinner, save a recipe link, or bring a handwritten favorite along.'} action={recipes.length ? <Button variant="secondary" onClick={() => { setQuery(''); setTag(''); setFavoritesOnly(false); }}>Clear filters</Button> : <Button onClick={() => setEditor({ recipe: blankRecipe() })}><Plus size={16} />Add your first recipe</Button>} />}
    </>}
    <Modal open={editor !== null} title={editor?.record ? 'Edit your recipe' : editor?.warnings ? 'Review your imported recipe' : 'Something good to keep'} description="Make it your own. You can always come back and edit." onClose={() => { if (!saving) setEditor(null); }}>
      {editor && <RecipeEditor key={editor.record?.id || 'new'} initial={editor.recipe} warnings={editor.warnings} saving={saving} onSave={saveRecipe} onCancel={() => { if (!saving) setEditor(null); }} />}
    </Modal>
    <Modal open={importOpen} title="Bring a recipe home" description="A favorite link, a little text, or a photo from your recipe box." onClose={() => setImportOpen(false)}>
      {importOpen && <RecipeImporter demo={Boolean(demo)} onImported={result => { setImportOpen(false); setEditor({ recipe: result.recipe, warnings: result.warnings }); }} />}
    </Modal>
    <Modal open={deleteOpen} title="Delete this recipe?" description={`“${selected?.data.title || 'This recipe'}” will be removed from your family cookbook. This cannot be undone.`} onClose={() => { if (!busy) setDeleteOpen(false); }}>
      <div className="recipe-form-actions"><Button variant="secondary" disabled={busy} onClick={() => setDeleteOpen(false)}>Keep recipe</Button><Button variant="danger" busy={busy} onClick={() => void removeRecipe()}>Delete recipe</Button></div>
    </Modal>
  </div>;
}

function RecipeDetail({ record, busy, onBack, onFavorite, onEdit, onDelete }: { record: FamilyRecord<'recipe'>; busy: boolean; onBack: () => void; onFavorite: () => void; onEdit: () => void; onDelete: () => void }) {
  const recipe = record.data;
  const [portions, setPortions] = useState(String(recipe.servings));
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [printError, setPrintError] = useState('');
  useEffect(() => { setPortions(String(recipe.servings)); setChecked(new Set()); }, [record.id, recipe.servings]);
  const parsed = Number(portions);
  const validPortions = Number.isInteger(parsed) && parsed >= 1 && parsed <= 1000;
  const servings = validPortions ? parsed : recipe.servings;
  const ratio = servings / recipe.servings;
  const source = (() => { try { const url = new URL(recipe.sourceUrl || ''); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined; } catch { return undefined; } })();
  function printRecipe() {
    setPrintError('');
    try { window.print(); }
    catch { setPrintError('Printing is unavailable here. Try your browser’s Print command.'); }
  }
  return <div className="recipe-detail stack">
    <RecipePrintSheet recipe={recipe} servings={servings} source={source} />
    <div className="recipe-detail-toolbar"><Button variant="ghost" onClick={onBack}><ArrowLeft size={17} />All recipes</Button><div><Button variant="secondary" onClick={printRecipe} disabled={!validPortions}><Printer size={17} />Print recipe</Button><Button variant="secondary" onClick={onFavorite} disabled={busy} aria-pressed={recipe.favorite}><Heart size={17} fill={recipe.favorite ? 'currentColor' : 'none'} />{recipe.favorite ? 'Saved favorite' : 'Favorite'}</Button><Button onClick={onEdit}>Edit recipe</Button></div></div>
    {printError && <p className="recipe-alert" role="alert">{printError}</p>}
    <div className="recipe-detail-heading"><div className="recipe-detail-tags">{recipe.tags.map(item => <Badge key={item}>{item}</Badge>)}</div><h1>{recipe.title}</h1>{recipe.description && <p>{recipe.description}</p>}<div className="recipe-detail-meta"><span><Clock3 size={16} />Prep {recipe.prepMinutes ? durationLabel(recipe.prepMinutes) : 'not set'}</span><span><Clock3 size={16} />Cook {recipe.cookMinutes ? durationLabel(recipe.cookMinutes) : 'not set'}</span><span><Users size={16} />Originally serves {recipe.servings}</span></div></div>
    <div className="recipe-detail-columns">
      <section className="recipe-ingredients card"><div className="recipe-section-heading"><h2>Ingredients</h2><Leaf size={21} aria-hidden="true" /></div><div className="recipe-servings"><label htmlFor="recipe-portions">Servings</label><div><button type="button" className="recipe-icon-button" disabled={servings <= 1} onClick={() => setPortions(String(Math.max(1, servings - 1)))} aria-label="Decrease servings"><Minus size={16} /></button><input id="recipe-portions" type="number" min="1" max="1000" step="1" value={portions} aria-invalid={!validPortions} aria-describedby={`recipe-scaling-note${!validPortions ? ' recipe-portions-error' : ''}`} onChange={event => setPortions(event.target.value)} /><button type="button" className="recipe-icon-button" disabled={servings >= 1000} onClick={() => setPortions(String(Math.min(1000, servings + 1)))} aria-label="Increase servings"><Plus size={16} /></button></div></div>
        {(servings !== recipe.servings || !validPortions) && <button type="button" className="recipe-reset-servings" onClick={() => setPortions(String(recipe.servings))}>Reset to {recipe.servings} servings</button>}
        {!validPortions && <p id="recipe-portions-error" role="alert" className="recipe-error">Choose a whole number from 1 to 1,000. Original amounts shown.</p>}
        <p id="recipe-scaling-note" className="recipe-scaling-note">Only ingredient amounts adjust. Unmeasured ingredients, quantities in the method, cooking times, and temperatures stay as written.</p>
        <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{validPortions ? `Ingredient amounts shown for ${servings} ${servings === 1 ? 'serving' : 'servings'}.` : ''}</p>
        <ul className="recipe-ingredient-list">{recipe.ingredients.map((ingredient, index) => <li key={index}><label className={checked.has(index) ? 'checked' : ''}><input type="checkbox" checked={checked.has(index)} onChange={() => setChecked(previous => { const next = new Set(previous); if (next.has(index)) next.delete(index); else next.add(index); return next; })} /><span><strong>{[ingredientAmount(ingredient, ratio), ingredient.unit].filter(Boolean).join(' ')}</strong>{ingredient.quantity !== null || ingredient.unit ? ' ' : ''}{ingredient.name}{ingredient.note && <small>{ingredient.note}</small>}</span></label></li>)}</ul>
      </section>
      <section className="recipe-method"><h2>Let’s make it</h2><ol className="recipe-step-list">{recipe.steps.map((step, index) => <li key={index}><span className="recipe-step-number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span><p>{step}</p></li>)}</ol>{source && <a className="recipe-source" href={source} target="_blank" rel="noopener noreferrer">Visit the original recipe<ExternalLink size={14} /></a>}<p className="recipe-cook-note">Make it yours. Taste as you go, and check ingredient labels for your family’s dietary needs.</p></section>
    </div><div className="recipe-delete-row"><Button variant="ghost" onClick={onDelete}><Trash2 size={15} />Delete recipe</Button></div>
  </div>;
}

function RecipePrintSheet({ recipe, servings, source }: { recipe: Recipe; servings: number; source?: string }) {
  const ratio = servings / recipe.servings;
  return createPortal(<article className="recipe-print-sheet" aria-label="Recipe print sheet">
    <header><p className="recipe-print-brand">Hearth · saved recipe</p><h1>{recipe.title}</h1>{recipe.description && <p>{recipe.description}</p>}<p className="recipe-print-meta"><strong>Serves {servings}</strong>{recipe.prepMinutes > 0 && <> · Prep {durationLabel(recipe.prepMinutes)}</>}{recipe.cookMinutes > 0 && <> · Cook {durationLabel(recipe.cookMinutes)}</>}</p><p className="recipe-print-scaling">{servings !== recipe.servings ? `Ingredient amounts scaled from ${recipe.servings} to ${servings} servings.` : `Original recipe for ${recipe.servings} ${recipe.servings === 1 ? 'serving' : 'servings'}.`} Unmeasured ingredients, quantities in the method, cooking times, and temperatures stay as written.</p></header>
    <section><h2>Ingredients</h2><ul>{recipe.ingredients.map((ingredient, index) => <li key={index}><span>{[ingredientAmount(ingredient, ratio), ingredient.unit, ingredient.name].filter(Boolean).join(' ')}</span>{ingredient.note && <span className="recipe-print-ingredient-note"> — {ingredient.note}</span>}</li>)}</ul></section>
    <section><h2>Method</h2><ol>{recipe.steps.map((step, index) => <li key={index}><p>{step}</p></li>)}</ol></section>
    {source && <footer><strong>Original recipe:</strong> <span>{source}</span></footer>}
  </article>, document.body);
}

type IngredientDraft = { id: string; name: string; amount: string; unit: string; note: string };
function draftIngredient(ingredient?: Ingredient): IngredientDraft {
  const number = (value: number) => new Intl.NumberFormat('en', { maximumSignificantDigits: 21, useGrouping: false }).format(value);
  const amount = ingredient?.quantity != null ? `${number(ingredient.quantity)}${ingredient.quantityMax !== undefined && ingredient.quantityMax > ingredient.quantity ? `–${number(ingredient.quantityMax)}` : ''}` : '';
  return { id: crypto.randomUUID(), name: ingredient?.name || '', amount, unit: ingredient?.unit || '', note: ingredient?.note || '' };
}

function RecipeEditor({ initial, warnings, saving, onSave, onCancel }: { initial: Recipe; warnings?: string[]; saving: boolean; onSave: (recipe: Recipe) => Promise<void>; onCancel: () => void }) {
  const [title, setTitle] = useState(initial.title);
  const [description, setDescription] = useState(initial.description);
  const [servings, setServings] = useState(String(initial.servings));
  const [prep, setPrep] = useState(String(initial.prepMinutes));
  const [cook, setCook] = useState(String(initial.cookMinutes));
  const [tags, setTags] = useState(initial.tags.join(', '));
  const [sourceUrl, setSourceUrl] = useState(initial.sourceUrl || '');
  const [ingredients, setIngredients] = useState<IngredientDraft[]>(initial.ingredients.map(draftIngredient));
  const [steps, setSteps] = useState(initial.steps.map(text => ({ id: crypto.randomUUID(), text })));
  const [error, setError] = useState('');
  function changeIngredient(id: string, key: Exclude<keyof IngredientDraft, 'id'>, value: string) {
    setIngredients(previous => previous.map(item => item.id === id ? { ...item, [key]: value } : item));
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    setError('');
    const recipeTags = [...new Set(tags.split(',').map(value => value.trim()).filter(Boolean))];
    if (!title.trim()) return setError('Give your recipe a title.');
    if (!ingredients.length || ingredients.some(item => !item.name.trim())) return setError('Add a name for every ingredient.');
    if (!steps.length || steps.some(item => !item.text.trim())) return setError('Add instructions for every step.');
    const invalidAmount = ingredients.find(item => item.amount.trim() && parseQuantity(item.amount).quantity === null);
    if (invalidAmount) return setError(`Check the amount for ${invalidAmount.name}. Use a number, fraction, or range such as 1–2; leave it blank for “to taste”.`);
    if (recipeTags.length > 12 || recipeTags.some(value => value.length > 40)) return setError('Use up to 12 tags, with 40 characters or fewer each.');
    if (sourceUrl.trim()) {
      try { const url = new URL(sourceUrl); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(); }
      catch { return setError('The source link must be a valid HTTP or HTTPS URL without a username or password.'); }
    }
    const recipe: Recipe = { title: title.trim(), description: description.trim(), servings: Number(servings), prepMinutes: Number(prep), cookMinutes: Number(cook), ingredients: ingredients.map(item => ({ name: item.name.trim(), unit: item.unit.trim(), ...parseQuantity(item.amount), ...(item.note.trim() ? { note: item.note.trim() } : {}) })), steps: steps.map(item => item.text.trim()), tags: recipeTags, favorite: initial.favorite, ...(sourceUrl.trim() ? { sourceUrl: sourceUrl.trim() } : {}) };
    if (new TextEncoder().encode(JSON.stringify(recipe)).byteLength > 32_768) return setError('This recipe is too long to save. Shorten the notes or instructions, then try again.');
    try { await onSave(recipe); }
    catch (cause) { setError(errorMessage(cause)); }
  }
  return <form className="recipe-form" onSubmit={event => void submit(event)}><fieldset className="recipe-editor-controls stack" disabled={saving}>
    {warnings && <div className="recipe-import-review"><strong>One last look before it goes in the cookbook.</strong><p>Check ingredient amounts, servings, and instructions against the original. Extraction can miss details.</p>{warnings.length > 0 && <ul>{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}</div>}
    {error && <p role="alert" className="recipe-alert">{error}</p>}
    <Field label="Recipe name"><input className="input" value={title} maxLength={160} required onChange={event => setTitle(event.target.value)} placeholder="Sunday’s lemon pasta" /></Field>
    <Field label="A little about it"><textarea className="input" value={description} maxLength={2000} rows={2} onChange={event => setDescription(event.target.value)} placeholder="The one everyone asks for seconds of." /></Field>
    <div className="recipe-time-fields"><Field label="Servings"><input className="input" type="number" min={1} max={1000} step={1} value={servings} required onChange={event => setServings(event.target.value)} /></Field><Field label="Prep (minutes)"><input className="input" type="number" min={0} max={10080} step={1} value={prep} required onChange={event => setPrep(event.target.value)} /></Field><Field label="Cook (minutes)"><input className="input" type="number" min={0} max={10080} step={1} value={cook} required onChange={event => setCook(event.target.value)} /></Field></div>
    <fieldset className="recipe-form-section"><legend>Ingredients</legend><p className="muted recipe-field-hint">Fractions and ranges work: ½, 1 1/2, or 1–2. Leave the amount empty for “to taste”.</p><div className="stack recipe-editor-ingredients">{ingredients.map((item, index) => <div className="recipe-ingredient-editor" key={item.id}><span className="recipe-row-index">{index + 1}</span><div className="recipe-ingredient-fields"><div className="recipe-ingredient-main"><input className="input" value={item.amount} maxLength={32} onChange={event => changeIngredient(item.id, 'amount', event.target.value)} placeholder="½" aria-label={`Ingredient ${index + 1} amount`} /><input className="input" value={item.unit} maxLength={40} onChange={event => changeIngredient(item.id, 'unit', event.target.value)} placeholder="cup" aria-label={`Ingredient ${index + 1} unit`} /><input className="input" value={item.name} maxLength={200} required onChange={event => changeIngredient(item.id, 'name', event.target.value)} placeholder="Ingredient" aria-label={`Ingredient ${index + 1} name`} /></div><input className="input recipe-ingredient-note" value={item.note} maxLength={500} onChange={event => changeIngredient(item.id, 'note', event.target.value)} placeholder="A note, if needed (finely chopped, to taste…)" aria-label={`Ingredient ${index + 1} note`} /></div><button type="button" className="recipe-icon-button" disabled={ingredients.length === 1} onClick={() => setIngredients(previous => previous.filter(value => value.id !== item.id))} aria-label={`Remove ingredient ${index + 1}`}><X size={17} /></button></div>)}</div><Button type="button" variant="secondary" size="sm" disabled={ingredients.length >= 100} onClick={() => setIngredients(previous => [...previous, draftIngredient()])}><Plus size={15} />Add ingredient</Button></fieldset>
    <fieldset className="recipe-form-section"><legend>Method</legend><div className="stack">{steps.map((step, index) => <div className="recipe-step-editor" key={step.id}><span className="recipe-row-index">{index + 1}</span><textarea className="input" value={step.text} rows={2} maxLength={2000} required onChange={event => setSteps(previous => previous.map(item => item.id === step.id ? { ...item, text: event.target.value } : item))} placeholder="What comes next?" aria-label={`Step ${index + 1}`} /><button type="button" className="recipe-icon-button" disabled={steps.length === 1} onClick={() => setSteps(previous => previous.filter(item => item.id !== step.id))} aria-label={`Remove step ${index + 1}`}><X size={17} /></button></div>)}</div><Button type="button" variant="secondary" size="sm" disabled={steps.length >= 100} onClick={() => setSteps(previous => [...previous, { id: crypto.randomUUID(), text: '' }])}><Plus size={15} />Add step</Button></fieldset>
    <Field label="Tags" hint="Separate with commas. Think quick dinners, baking, or family favorites."><input className="input" value={tags} maxLength={500} onChange={event => setTags(event.target.value)} placeholder="Weeknight, Vegetarian" /></Field>
    <Field label="Original recipe link (optional)"><input className="input" type="url" value={sourceUrl} maxLength={2000} onChange={event => setSourceUrl(event.target.value)} placeholder="https://…" /></Field>
    <div className="recipe-form-actions"><Button type="button" variant="secondary" disabled={saving} onClick={onCancel}>Cancel</Button><Button type="submit" busy={saving}><Check size={16} />Save recipe</Button></div>
  </fieldset></form>;
}

function RecipeImporter({ demo, onImported }: { demo: boolean; onImported: (result: RecipeImportResponse) => void }) {
  const [mode, setMode] = useState<RecipeImportRequest['mode']>('url');
  const [value, setValue] = useState('');
  const [photo, setPhoto] = useState<(PreparedRecipePhoto & { previewUrl: string }) | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const preparation = useRef<AbortController | null>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  useEffect(() => () => { controller.current?.abort(); preparation.current?.abort(); }, []);
  useEffect(() => () => { if (photo) URL.revokeObjectURL(photo.previewUrl); }, [photo]);
  async function choosePhoto(input: HTMLInputElement) {
    preparation.current?.abort();
    const selected = input.files?.[0];
    const abort = new AbortController();
    preparation.current = abort;
    setError('');
    setPhoto(null);
    setPreparing(Boolean(selected));
    if (!selected) return;
    try {
      const prepared = await prepareRecipePhoto(selected, abort.signal);
      if (!abort.signal.aborted) setPhoto({ ...prepared, previewUrl: URL.createObjectURL(prepared.blob) });
    } catch (cause) {
      if (!abort.signal.aborted) { setError(errorMessage(cause)); input.value = ''; }
    } finally { if (!abort.signal.aborted) setPreparing(false); }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || preparing) return;
    setError('');
    if (demo) return setError('Recipe extraction needs a connected Hearth account with Workers AI. You can add and edit recipes manually in this demo.');
    if (mode === 'image' && !photo) return setError('Choose a photo of a recipe first.');
    if (mode !== 'image' && !value.trim()) return setError(mode === 'url' ? 'Paste a recipe link first.' : 'Paste the recipe text first.');
    setBusy(true);
    const abort = new AbortController();
    controller.current = abort;
    const timeout = window.setTimeout(() => abort.abort(), 75_000);
    try {
      const input: RecipeImportRequest = { mode, value: mode === 'image' && photo ? await recipePhotoBase64(photo.blob) : value.trim(), ...(mode === 'image' && photo ? { mimeType: photo.blob.type } : {}) };
      const response = await fetch('/api/recipes/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(input), signal: abort.signal });
      if (response.redirected || !(response.headers.get('content-type') || '').includes('application/json')) throw new Error('Your session needs a fresh sign-in. Sign in again, then retry the import.');
      const result = await response.json() as RecipeImportResponse & { error?: string };
      if (!response.ok) throw new Error(result.error || 'This recipe could not be imported. Try pasting its text instead.');
      if (!result.recipe || !Array.isArray(result.warnings)) throw new Error('The recipe response was incomplete. Please try again.');
      if (abort.signal.aborted) return;
      onImported(result);
    } catch (cause) { if (!abort.signal.aborted) setError(errorMessage(cause)); else setError('Recipe extraction timed out. Try a smaller photo or paste the recipe text.'); }
    finally { window.clearTimeout(timeout); setBusy(false); }
  }
  return <form className="recipe-import-form stack" onSubmit={event => void submit(event)}>
    <div className="recipe-import-tabs" aria-label="Import method">{([{ id: 'url', text: 'From a link', icon: <Link2 size={18} /> }, { id: 'text', text: 'Paste text', icon: <FileText size={18} /> }, { id: 'image', text: 'Scan a photo', icon: <Camera size={18} /> }] as const).map(option => <button type="button" key={option.id} className={mode === option.id ? 'active' : ''} disabled={busy || preparing} aria-pressed={mode === option.id} onClick={() => { setMode(option.id); setValue(''); setError(''); }}>{option.icon}<span>{option.text}</span></button>)}</div>
    {mode === 'url' && <Field label="Recipe link" hint="Use a public HTTPS link. If a site blocks imports, paste the recipe text."><input className="input" type="url" placeholder="https://your-favorite-recipe…" value={value} maxLength={2000} required disabled={busy} onChange={event => setValue(event.target.value)} /></Field>}
    {mode === 'text' && <Field label="Recipe text" id="recipe-import-text" hint="Include the title, servings, ingredients, and method when you have them."><textarea id="recipe-import-text" className="input" value={value} rows={10} maxLength={24000} required disabled={busy} placeholder="Paste your recipe here…" onChange={event => setValue(event.target.value)} /><span className="recipe-text-count muted">{value.length.toLocaleString()} / 24,000 characters</span></Field>}
    {mode === 'image' && <div className="recipe-photo-upload"><Camera size={35} strokeWidth={1.4} /><h3>Handwritten, dog-eared, well-loved.</h3><p>Take a clear photo of a recipe or choose one from your library. Large photos are resized on this device.</p><label className="field"><span>Recipe photo</span><input ref={photoInput} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" disabled={busy || preparing} onChange={event => void choosePhoto(event.currentTarget)} /></label><small>JPG, PNG, or WebP · originals up to 25 MB</small>{preparing && <p className="recipe-photo-status" role="status">Preparing your photo on this device…</p>}{photo && <div className="recipe-photo-preview"><img src={photo.previewUrl} alt="Selected recipe photo preview" /><p className="recipe-file-chosen"><Check size={15} />{photo.name}</p><p className="recipe-photo-status" role="status">Photo ready · {photo.width.toLocaleString()} × {photo.height.toLocaleString()} · {(photo.blob.size / (1024 * 1024)).toFixed(1)} MB</p><small>Check that the text is readable. The photo stays on this device until you create a draft.</small><Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => { setPhoto(null); if (photoInput.current) photoInput.current.value = ''; }}>Remove photo</Button></div>}</div>}
    <p className="recipe-privacy-note"><Leaf size={17} />Only the link, text, or photo you choose is sent for extraction. You’ll review the draft before anything is saved.</p>
    {demo && <p className="recipe-import-review">You’re exploring the demo. Recipe extraction is available with a connected account; manual recipes work here.</p>}
    {error && <p role="alert" className="recipe-alert">{error}</p>}
    <div className="recipe-form-actions"><Button type="submit" busy={busy || preparing} disabled={mode === 'image' && !photo}>{preparing ? 'Preparing photo…' : busy ? 'Reading your recipe…' : 'Create a recipe draft'}</Button></div>
  </form>;
}
