import type { Answer, Bootstrap, FamilyRecord, RecordDataMap, RecordKind, User } from '../shared/types';
import { kindModule, moduleIds } from '../shared/types';
import { canViewAnswer, sameQuestionPair } from '../shared/question-pairing';
import { isValidDate, todayInTimezone } from '../shared/calendar';
import { questionForDate } from '../shared/questions';
import { familyCapacity } from '../shared/capacity';

export const demoMembers: User[] = [
  { id: 'alex', name: 'Alex', role: 'admin', color: '#557461' },
  { id: 'sam', name: 'Sam', role: 'member', color: '#b56d51' },
];
const dayOffset = (amount: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + amount); return d.toISOString().slice(0,10); };
export function createDemo(): Bootstrap {
  const records: FamilyRecord[] = [];
  function add<K extends RecordKind>(id: string, kind: K, data: RecordDataMap[K], ownerId = 'alex') {
    records.push({ id, kind, data, ownerId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), version: 1 } as FamilyRecord);
  }
  add('recipe-lemon', 'recipe', { title: 'Sunday lemon & herb chicken', description: 'A little sunshine on the dinner table. Our favorite one-pan Sunday supper.', servings: 4, prepMinutes: 15, cookMinutes: 45, ingredients: [{name:'chicken thighs',quantity:8,unit:''},{name:'baby potatoes',quantity:600,unit:'g'},{name:'olive oil',quantity:3,unit:'tbsp'},{name:'lemons',quantity:2,unit:''},{name:'garlic cloves',quantity:4,unit:''},{name:'rosemary sprigs',quantity:3,unit:''},{name:'salt and pepper',quantity:null,unit:'',note:'to taste'}], steps:['Heat the oven to 200°C / 400°F. Pat the chicken dry.','Halve the potatoes and toss in a roasting dish with the olive oil, crushed garlic, rosemary, salt and pepper.','Nestle the chicken among the potatoes, skin side up. Squeeze over one lemon and add slices of the other.','Roast for 40–45 minutes, until the chicken reaches 74°C / 165°F in the thickest part. Rest for 5 minutes and serve.'],tags:['Dinner','Family favorite'],favorite:true });
  add('recipe-pancakes', 'recipe', { title: 'Slow morning pancakes', description: 'Fluffy, golden, and best eaten in pajamas.', servings:2,prepMinutes:10,cookMinutes:15,ingredients:[{name:'plain flour',quantity:150,unit:'g'},{name:'milk',quantity:180,unit:'ml'},{name:'egg',quantity:1,unit:''},{name:'baking powder',quantity:1.5,unit:'tsp'},{name:'butter, melted',quantity:1,unit:'tbsp'}],steps:['Whisk the flour and baking powder together.','In another bowl, whisk the milk, egg and melted butter. Gently combine with the dry ingredients.','Cook small ladlefuls in a lightly buttered pan over medium heat. Flip when bubbles appear and cook until golden.'],tags:['Breakfast','Weekend'],favorite:false },'sam');
  add('task-1','task',{title:'Pick up fresh flowers for the table',done:false,assigneeId:'alex',dueDate:dayOffset(0)});
  add('task-2','task',{title:'Choose a film for Friday night',done:false,assigneeId:'sam',dueDate:dayOffset(2)},'sam');
  add('task-3','task',{title:'Water our little balcony garden',done:true,assigneeId:'alex'});
  add('note-today','note',{text:'Here’s to the little things: coffee together, a good laugh, and coming home to you. ♡',date:dayOffset(0)},'sam');
  add('event-weekend','event',{title:'Our weekend away',date:dayOffset(12),emoji:'🌿',description:'A cabin, long walks, and absolutely no alarm clocks.'});
  add('event-dinner','event',{title:'Family dinner',date:dayOffset(4),emoji:'🍋',description:'Bring something delicious and a story to share.'},'sam');
  add('habit-walk','habit',{title:'A little fresh air',userId:'alex',color:'#557461'});
  for(let i=1;i<=7;i++) add(`walk-${i}`,'habitLog',{habitId:'habit-walk',date:dayOffset(-i)});
  add('mood-alex','mood',{date:dayOffset(0),score:4,note:'Feeling grateful for a quiet morning.',shared:true});
  add('mood-sam','mood',{date:dayOffset(-1),score:3,note:'A full day. A walk helped.',shared:false},'sam');
  add('profile-alex','profile',{bio:'Collector of recipes, little adventures, and good memories.',loves:['Slow Sunday mornings','Anything with lemon','A walk without a destination'],suggestions:['Let’s try a new recipe together','A handwritten note always makes my day']});
  add('profile-sam','profile',{bio:'Happiest outside, in a bookshop, or in the kitchen together.',loves:['Fresh flowers','Old movies','The first cup of coffee'],suggestions:['Plan a small surprise adventure','Save me the last pancake']},'sam');
  add('goal-trip','goal',{title:'Make time for a little adventure',description:'Plan a week somewhere we have never been. More memories, less rushing.',targetDate:dayOffset(120),completed:false,milestones:[{id:'g1',title:'Make our destination shortlist',done:true},{id:'g2',title:'Set a budget together',done:false},{id:'g3',title:'Book our time away',done:false}]});
  return {user:demoMembers[0],members:demoMembers,modules:moduleIds.map(id=>({id,enabled:true})),records,timezone:'UTC',questionPair:['alex','sam'],demo:true};
}

export function visibleDemo(source: Bootstrap): Bootstrap {
  const enabled = new Set(source.modules.filter(m=>m.enabled).map(m=>m.id));
  const encoder = new TextEncoder();
  const dataBytes = source.records.reduce((total, record) => total + encoder.encode(JSON.stringify(record.data)).byteLength, 0);
  return {...source, capacity: familyCapacity(dataBytes, source.records.length), records:source.records.filter(r=>{
    if(!enabled.has(kindModule[r.kind])) return false;
    if(r.kind==='mood') return r.ownerId===source.user.id || r.data.shared;
    if(r.kind==='answer') return canViewAnswer(r,source.records,source.user.id,source.questionPair,source.members);
    return true;
  })};
}

/** Mirror the API's audience and identity rules in the disposable local demo. */
export function prepareDemoAnswer(source: Bootstrap, data: Answer, original?: FamilyRecord<'answer'>): Answer {
  if (!isValidDate(data.date) || data.date < '1900-01-01' || data.date > todayInTimezone(source.timezone)) throw new Error('Choose today or a past date in your family timezone.');
  const question = questionForDate(data.date);
  if (question.id !== data.questionId || !Number.isInteger(data.choice) || data.choice < 0 || data.choice >= question.choices.length) throw new Error('Choose a valid answer for this date.');
  if (original) {
    if (data.date !== original.data.date || data.questionId !== original.data.questionId || data.participantIds?.[0] !== original.data.participantIds?.[0] || data.participantIds?.[1] !== original.data.participantIds?.[1]) throw new Error('An answer’s date, question, and original pair cannot be changed.');
    if (data.shareToProfile && !original.data.shareToProfile && !sameQuestionPair(data.participantIds, source.questionPair)) throw new Error('This answer is private because its original pair is no longer active.');
    return { ...data, ...(original.data.participantIds ? { participantIds: [...original.data.participantIds] } : {}) };
  }
  const pair = source.questionPair;
  if (!pair || !pair.includes(source.user.id)) throw new Error('Daily questions are available to the configured couple.');
  if (!sameQuestionPair(data.participantIds, pair)) throw new Error('Your question pairing changed. Refresh before answering.');
  if (source.records.some(record => record.kind === 'answer' && record.data.date === data.date && pair.includes(record.ownerId) && !sameQuestionPair(record.data.participantIds, pair))) throw new Error('Your pairing changed for this day. Start a new question tomorrow.');
  if (source.records.some(record => record.kind === 'answer' && record.ownerId === source.user.id && record.data.date === data.date)) throw new Error('An answer already exists for this day. Refresh before trying again.');
  return { ...data, participantIds: [...pair] };
}
