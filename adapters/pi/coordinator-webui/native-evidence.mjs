/** Extract bounded, attributable native review evidence rather than only the last verdict message. */
export function nativeEvidence(messages, goal) {
 const text = (message) => typeof message.content === "string" ? message.content : (message.content || []).filter((part)=>typeof part.text === "string").map((part)=>part.text).join("\n");
 const review = [...messages].reverse().find((message)=>message.role === "user" && /Executor.s summary|执行者本轮自述/.test(text(message)));
 const prompt = review ? text(review) : "";
 const reportMarker = /(?:# Executor's summary this round|【执行者本轮自述】)\s*/.exec(prompt);
 const toolsMarker = /(?:# Executor's recent tool[^\n]*|【执行者最近的工具与命令证据[^\n]*)\s*/.exec(prompt);
 const report = reportMarker ? prompt.slice(reportMarker.index+reportMarker[0].length,toolsMarker?.index ?? undefined).split(/\n(?:You may verify|你可以用|Judging rules|判定口径)/)[0].trim() : "";
 let tools = toolsMarker ? prompt.slice(toolsMarker.index+toolsMarker[0].length) : "";
 tools = tools.split(/\n(?:You may verify|你可以用|Judging rules|判断规则)/)[0].trim();
 const clip = (value,limit) => value.length<=limit ? value : `${value.slice(0,Math.floor(limit*.55))}\n[中段省略]\n${value.slice(-Math.floor(limit*.45))}`;
 const calls = new Map();
 const inspections = [];
 for(const message of messages) {
  for(const part of Array.isArray(message.content)?message.content:[]) if(part.type==="toolCall") calls.set(part.id,{name:part.name,arguments:part.arguments});
  if(message.role==="toolResult") inspections.push({tool:message.toolName,call:calls.get(message.toolCallId),isError:message.isError===true,output:clip(text(message),1800)});
 }
 return {feedback:String(goal.feedback||"").slice(0,2000),round:goal.round,executorReport:clip(report,4000),toolEvidence:clip(tools,10000),inspections:inspections.slice(-5),messages:messages.slice(-10).map((message)=>({role:message.role,text:clip(text(message),6000)}))};
}
