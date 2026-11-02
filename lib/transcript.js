// Read only a path resolved by the session inventory; never accept a query path.
import fs from "node:fs";
import readline from "node:readline";

function text(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter(c => typeof c?.text === "string").map(c => c.text).join("\n");
  return content == null ? "" : JSON.stringify(content);
}

export async function readTranscript(file, vendor, limit = 200) {
  const items = [];
  const stream = fs.createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  function add(time, kind, value, tool) {
    let body = text(value);
    if (body.length > 2000) body = body.slice(0, 2000) + " [+" + (body.length - 2000) + " chars]";
    items.push({ time: time ?? null, kind, text: body, ...(tool ? { tool } : {}) });
    if (items.length > limit) items.shift();
  }
  try {
    for await (const line of lines) {
      let v;
      try { v = JSON.parse(line); } catch { continue; }
      if (!v || typeof v !== "object") continue;
      const time = v.timestamp;
      if (vendor === "codex") {
        if (v.type !== "response_item" || !v.payload) continue;
        const p = v.payload;
        if (p.type === "message" && ["user", "assistant"].includes(p.role)) add(time, p.role, p.content);
        else if (["function_call", "custom_tool_call"].includes(p.type)) add(time, "tool_call", p.arguments ?? p.input, p.name);
        else if (["function_call_output", "custom_tool_call_output"].includes(p.type)) add(time, "tool_output", p.output);
        else if (p.type === "reasoning") add(time, "note", "[reasoning hidden]");
      } else if (["user", "assistant"].includes(v.type)) {
        const content = v.message?.content;
        if (typeof content === "string") add(time, v.type, content);
        else if (Array.isArray(content)) for (const c of content) {
          if (c?.type === "text") add(time, v.type, c.text);
          else if (c?.type === "tool_use") add(time, "tool_call", JSON.stringify(c.input ?? {}).replace(/[\r\n]+/g, " "), c.name);
          else if (c?.type === "tool_result") add(time, "tool_output", c.content);
        }
      }
    }
    return items;
  } finally {
    lines.close();
    stream.destroy();
  }
}
