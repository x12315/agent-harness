const MAX_PROMPT_CHARS = 8000;
const PROMPT_HEADROOM = 7900;

/** Parse one model JSON object, tolerating a single Markdown fence but never executing content. */
export function modelObject(text) {
 const value = String(text ?? "").trim();
 const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(value);
 const parsed = JSON.parse(fenced ? fenced[1].trim() : value);
 if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError("Expected a JSON object");
 return parsed;
}

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" ? value : "";
const clip = (value, limit) => {
 const source = text(value);
 if (source.length <= limit) return source;
 const head = Math.floor(limit * .7), tail = Math.max(0, limit - head);
 return `${source.slice(0, head)}\n[中段省略，仅供判断意图；完整原话仍由协调器保存]\n${source.slice(-tail)}`;
};

// Routing context may contain user-provided text. Keep task handles and common
// secret assignments out of the model context while retaining the task scope.
export const redactTaskText = (value) => text(value)
 .replace(/(bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
 .replace(/((?:api[_-]?key|access[_-]?token|auth(?:orization)?|password|passwd|secret|credential)["']?\s*[:=]\s*["']?)[^\s,;"']+/gi, "$1[REDACTED]")
 .replace(/((?:密码|口令|密钥)\s*(?:[:：=]|是|为)\s*)[^\s,，;；]+/g, "$1[REDACTED]")
 .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]");
const redact = redactTaskText;
const safeClip = (value, limit) => clip(redact(value), limit);

const cjkBigrams = (value) => {
 const found = [];
 for (const run of String(value ?? "").match(/[\u3400-\u9fff]+/g) || []) {
  for (let index = 0; index < run.length - 1; index++) found.push(run.slice(index, index + 2));
 }
 return found;
};
const queryTerms = (value) => {
 const source = String(value ?? "").toLowerCase();
 const words = source.match(/[\p{L}\p{N}_-]{2,}/gu) || [];
 return new Set([...words, ...cjkBigrams(source)]);
};
const taskText = (task) => [task.objective, task.sourceText, task.sourceInputText, ...(task.amendments || []).map((item) => item?.text), ...(task.constraints || []), ...(task.acceptance || [])].filter(Boolean).join("\n");
const explicitTaskIds = (value) => new Set(String(value ?? "").match(/\btask-[A-Za-z0-9_-]+\b/g) || []);

const focusFor = (snapshot, conversationId) => {
 const sources = [snapshot.focuses, snapshot.focusByConversation, snapshot.conversationFocus, snapshot.focus];
 for (const source of sources) {
  if (!source) continue;
  if (Array.isArray(source)) {
   const matches = source.filter((item) => item?.conversationId === conversationId);
   if (matches.length) return new Set(matches.flatMap((item) => [item.taskId, item.focusTaskId, ...(item.taskIds || [])].filter(Boolean)));
  } else if (record(source)) {
   const value = source[conversationId];
   if (typeof value === "string") return new Set([value]);
   if (Array.isArray(value)) return new Set(value.flatMap((item) => typeof item === "string" ? [item] : [item?.taskId, ...(item?.taskIds || [])]).filter(Boolean));
   if (record(value)) return new Set([value.taskId, ...(value.taskIds || [])].filter(Boolean));
  }
 }
 return new Set();
};

const safeRelation = (value, fields) => {
 if (!record(value)) return null;
 const result = {};
 for (const field of fields) {
  if (field === "revision" && Number.isSafeInteger(value[field])) result[field] = value[field];
  else if (field === "taskId" && typeof value[field] === "string") result[field] = value[field];
  else if (["objective", "condition", "summary", "artifact", "path"].includes(field) && typeof value[field] === "string") result[field] = safeClip(value[field], 500);
 }
 return Object.keys(result).length ? result : null;
};
const relation = (task) => ({
 ...(safeRelation(task.derivedFrom, ["taskId", "revision", "objective", "evidence", "summary", "artifact", "path"]) ? { derivedFrom: safeRelation(task.derivedFrom, ["taskId", "revision", "objective", "summary", "artifact", "path"]) } : {}),
 ...(safeRelation(task.partOf, ["taskId", "revision", "objective"]) ? { partOf: safeRelation(task.partOf, ["taskId", "revision", "objective"]) } : {}),
 ...(Array.isArray(task.dependencies) ? { dependencies: task.dependencies.map((item) => safeRelation(item, ["taskId", "revision", "condition"])).filter(Boolean) } : {}),
 ...(Array.isArray(task.children) ? { children: task.children.filter((item) => typeof item === "string").slice(0, 24) } : {}),
});
const matchingOriginalContext = (task, terms, detailed) => {
 const sorted=[...terms].sort((a,b)=>b.length-a.length).slice(0,24);
 for(const [field,limit] of [['sourceText',detailed?1200:650],['sourceInputText',detailed?900:500]]) {
  const original=redact(task[field]);if(original.length<=limit)continue;
  const lower=original.toLowerCase(),head=Math.floor(limit*.7),tail=original.length-(limit-head);
  for(const term of sorted){const index=lower.indexOf(term);if(index<head||index>=tail)continue;const offset=Math.max(0,index-100);return {field,offset,text:original.slice(offset,index+term.length+400),fullLength:original.length,partial:true};}
 }
 return null;
};
const candidate = (task, detailed = true, terms = new Set()) => ({
 matchedOriginalContext: matchingOriginalContext(task,terms,detailed) || undefined,
 id: task.id,
 objective: safeClip(task.objective, detailed ? 900 : 500),
 ...(task.sourceText ? { sourceText: safeClip(task.sourceText, detailed ? 1200 : 650) } : {}),
 ...(task.sourceInputText ? { sourceInputText: safeClip(task.sourceInputText, detailed ? 900 : 500) } : {}),
 status: task.status,
 revision: task.revision,
 ...(Array.isArray(task.amendments) && task.amendments.length ? { amendments: task.amendments.slice(-6).map((item) => ({ revision: item?.revision, text: safeClip(item?.text, detailed ? 550 : 260), source: safeClip(item?.source, 80) })) } : {}),
 ...(Array.isArray(task.constraints) && task.constraints.length ? { constraints: task.constraints.slice(0, 8).map((item) => safeClip(item, detailed ? 300 : 140)) } : {}),
 ...(Array.isArray(task.acceptance) && task.acceptance.length ? { acceptance: task.acceptance.slice(0, 8).map((item) => safeClip(item, detailed ? 300 : 140)) } : {}),
 ...relation(task),
 ...(task.mergeInto ? { mergeInto: task.mergeInto } : {}),
 ...(task.coordinationMessages?.length ? { messages: task.coordinationMessages.slice(-3).map(({id,text,fromTaskIds,origin})=>({id,text:safeClip(text,350),fromTaskIds,origin})) } : {}),
 ...(task.nativeCompletion?.nativeEvidence ? { lastNativeResult: { revision: task.nativeCompletion.revision, matchesCurrentRevision: task.nativeCompletion.revision === task.revision, summary: safeClip(task.nativeCompletion.nativeEvidence.executorReport || task.nativeCompletion.nativeEvidence.feedback || "", detailed ? 600 : 260) } } : {}),
 ...(task.gap ? { gap: safeClip(task.gap, 220) } : {}),
 ...(task.progress?.summary ? { progress: safeClip(task.progress.summary, 260) } : {}),
});

/**
 * Build bounded routing context. Ranking examines every task first; only the
 * highest-value candidates are serialized when the native prompt is full.
 */
export function routingPrompt(input = {}, snapshot = {}) {
 const tasks = Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
 const conversationId = typeof input.conversationId === "string" ? input.conversationId : "default";
 const query = `${input.text || ""}\n${(input.lookupTerms || []).join(" ")}\n${input.replyToInputId || ""}`;
 const terms = queryTerms(query);
 const expandedTerms = new Set((input.lookupTerms || []).flatMap((value) => [...queryTerms(value)]));
 const explicitIds = explicitTaskIds(query);
 const focus = focusFor(snapshot, conversationId);
 const ranked = tasks.map((task, index) => {
  const taskTerms = queryTerms(taskText(task));
  let overlap = 0;
  for (const term of terms) if (taskTerms.has(term)) overlap++;
  const explicitName = [...terms].some((term) => term.length > 1 && taskText(task).toLowerCase().includes(term));
  const expandedOverlap = [...expandedTerms].filter((term) => taskTerms.has(term)).length;
  const score = (explicitIds.has(task.id) ? 10000 : 0) + expandedOverlap * 600 + (explicitName ? 800 : 0) + overlap * 12 + (focus.has(task.id) ? 20 : 0);
  return { task, score, index };
 }).sort((left, right) => right.score - left.score || right.index - left.index);
 if (input.lookupTerms?.length) {
  const base = JSON.parse(routingPrompt({...input,lookupTerms:undefined,lookupCursor:undefined},snapshot));
  const sorted=[...tasks].sort((a,b)=>Number(a.id.slice(5))-Number(b.id.slice(5)));
  const cursor=Math.min(sorted.length,input.lookupCursor||0);
  const body={currentInput:base.currentInput,persistedFocus:base.persistedFocus,pendingClarifications:base.pendingClarifications.slice(-1),pendingProposals:base.pendingProposals.slice(-2).map(({id,revision,text})=>({id,revision,text:safeClip(text,120)})),taskCandidates:ranked.slice(0,4).map(({task})=>({id:task.id,revision:task.revision,status:task.status,objective:safeClip(task.objective,150),...(task.mergeInto?{mergeInto:task.mergeInto}:{})})),lookupQueries:input.lookupTerms,taskIndex:[],taskIndexPage:{cursor,total:sorted.length,nextCursor:null}};
  for(const task of sorted.slice(cursor,cursor+100)) {
   body.taskIndex.push([task.id,task.revision,task.status,safeClip(task.objective,120)]);
   body.taskIndexPage.nextCursor=cursor+body.taskIndex.length<sorted.length?cursor+body.taskIndex.length:null;
   if(JSON.stringify(body).length>PROMPT_HEADROOM){body.taskIndex.pop();body.taskIndexPage.nextCursor=cursor+body.taskIndex.length;break;}
  }
  if(!body.taskIndex.length&&cursor<sorted.length)throw Error('Historical title index exceeds routing capacity');
  return JSON.stringify(body);
 }
 const recent = (Array.isArray(snapshot.inputs) ? snapshot.inputs : [])
  .filter((item) => (item.conversationId ?? "default") === conversationId)
  .sort((left, right) => (left.acceptedAt || 0) - (right.acceptedAt || 0))
  .slice(-6)
  .map((item) => ({ id: item.id, status: item.status, text: safeClip(item.text, 480), ...(item.answer ? { answer: safeClip(item.answer, 420) } : {}), ...(item.status === "clarify" ? { pendingClarification: true } : {}) }));
 const candidates=new Map();
 const contextualCandidate=(task,detailed)=>{const key=`${task.id}:${detailed}`;if(!candidates.has(key))candidates.set(key,candidate(task,detailed,terms));return candidates.get(key);};
 const makePrompt = (userLimit, detailed, selected, recentInputs) => JSON.stringify({
  currentInput: { text: safeClip(input.text, userLimit), truncated: redact(input.text).length > userLimit, ...(conversationId ? { conversationId } : {}), ...(input.replyToInputId ? { replyToInputId: input.replyToInputId } : {}) },
  sameConversationRecentInputs: recentInputs,
  persistedFocus: [...focus],
  pendingClarifications: (snapshot.inputs || []).filter(item => item.status === 'clarify' && (item.conversationId || 'default') === conversationId).slice(-3).map(({id,text,answer})=>({id,text:safeClip(text,450),question:safeClip(answer,250)})),
  pendingProposals: (snapshot.proposals || []).filter(item => item.status === 'pending').slice(-4).map(({id,revision,text})=>({id,revision,text:safeClip(text,400)})),
  coordinationNotices: (snapshot.negotiations || []).filter(item => item.status === 'open').slice(-3).map(({id,taskIds,text})=>({id,taskIds,text:safeClip(text,250)})),
  taskCandidates: selected.map(({ task }) => contextualCandidate(task, detailed)),
  omittedTaskCandidates: Math.max(0, tasks.length - selected.length),
 });
 let selected = ranked;
 let detailed = true;
 let recentInputs = recent;
 let prompt = makePrompt(3000, detailed, selected, recentInputs);
 while (prompt.length > PROMPT_HEADROOM && selected.length > 1) { selected = selected.slice(0, -1); prompt = makePrompt(3000, detailed, selected, recentInputs); }
 while (prompt.length > PROMPT_HEADROOM && recentInputs.length > 1) { recentInputs = recentInputs.slice(1); prompt = makePrompt(3000, detailed, selected, recentInputs); }
 if (prompt.length > PROMPT_HEADROOM) { detailed = false; prompt = makePrompt(2200, detailed, selected, recentInputs); }
 while (prompt.length > PROMPT_HEADROOM && recentInputs.length) { recentInputs = recentInputs.slice(1); prompt = makePrompt(2200, detailed, selected, recentInputs); }
 if (prompt.length > PROMPT_HEADROOM) prompt = makePrompt(1200, false, selected, recentInputs);
 while (prompt.length > PROMPT_HEADROOM && selected.length > 1) { selected = selected.slice(0, -1); prompt = makePrompt(1200, false, selected, recentInputs); }
 if (prompt.length > MAX_PROMPT_CHARS) throw Error("Routing context exceeds native model boundary");
 return prompt;
}
