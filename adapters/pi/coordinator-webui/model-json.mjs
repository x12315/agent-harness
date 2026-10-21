/** Parse one model JSON object, tolerating a single Markdown fence but never executing content. */
export function modelObject(text) {
 let value = String(text ?? "").trim();
 const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(value);
 if (fenced) value = fenced[1].trim();
 const parsed = JSON.parse(value);
 if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError("Expected a JSON object");
 return parsed;
}

/** Keep routing context within the native plugin LLM's 8000-character contract. Full raw text remains authoritative. */
export function routingPrompt(input, snapshot) {
 const clip = (text, limit) => text.length <= limit ? text : `${text.slice(0, Math.floor(limit * .7))}\n[中段省略，仅供判断意图；完整原话会传给执行者]\n${text.slice(-Math.floor(limit * .3))}`;
 const tasks = snapshot.tasks.slice(-12).map(({id,objective,status,revision,gap,progress})=>({id,objective:clip(objective,160),status,revision,gap:gap?.slice(0,120),progress:progress?.summary?.slice(0,180)}));
 const recentInputs = snapshot.inputs.slice(-3).map(({text,status,answer})=>({text:clip(text,200),status,answer:answer?.slice(0,250)}));
 let userMessage=clip(input.text,3200);
 let prompt=JSON.stringify({userMessage,recentInputs,tasks});
 while(prompt.length>7900 && tasks.length>1){tasks.shift();prompt=JSON.stringify({userMessage,recentInputs,tasks});}
 while(prompt.length>7900 && recentInputs.length){recentInputs.shift();prompt=JSON.stringify({userMessage,recentInputs,tasks});}
 if(prompt.length>7900){userMessage=clip(input.text,1600);prompt=JSON.stringify({userMessage,recentInputs,tasks});}
 if (prompt.length>8000) throw Error("Routing context exceeds native model boundary");
 return prompt;
}
