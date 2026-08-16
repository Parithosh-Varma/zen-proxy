#!/usr/bin/env node
const http = require("http");

const PORT = Number(process.env.PORT || 8083);
const ZEN_URL = process.env.ZEN_URL || "https://opencode.ai/zen/v1";
const ZEN_KEY = process.env.ZEN_KEY || "public";
const MODEL = process.env.MODEL || "deepseek-v4-flash-free";

function estimateTokens(text) {
  return Math.ceil((text || "").length / 4);
}

function contentToString(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
  }
  return "";
}

function countRequestTokens(body) {
  let total = 0;
  total += estimateTokens(body.system ? contentToString(body.system) : "");
  for (const m of body.messages || []) {
    total += estimateTokens(contentToString(m.content));
  }
  for (const t of body.tools || []) {
    total += estimateTokens(JSON.stringify(t));
  }
  return total;
}

function anthropicToOpenAI(body) {
  const messages = [];
  const system = body.system ? contentToString(body.system) : "";
  if (system) messages.push({ role: "system", content: system });

  for (const m of body.messages || []) {
    if (m.role === "user") {
      if (Array.isArray(m.content)) {
        const parts = m.content.filter((b) => b.type === "text").map((b) => b.text);
        const toolResults = m.content.filter((b) => b.type === "tool_result");
        for (const tr of toolResults) {
          messages.push({
            role: "tool",
            tool_call_id: tr.tool_use_id,
            content: contentToString(tr.content),
          });
        }
        if (parts.length) {
          messages.push({ role: "user", content: parts.join("\n") });
        }
      } else {
        messages.push({ role: "user", content: m.content || "" });
      }
    } else if (m.role === "assistant") {
      const msg = { role: "assistant", content: "" };
      const toolCalls = [];
      let idx = 0;
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b.type === "text") msg.content += b.text || "";
        if (b.type === "tool_use") {
          toolCalls.push({
            id: b.id,
            type: "function",
            function: {
              name: b.name,
              arguments: typeof b.input === "string" ? b.input : JSON.stringify(b.input || {}),
            },
          });
          idx++;
        }
      }
      if (toolCalls.length) msg.tool_calls = toolCalls;
      messages.push(msg);
    }
  }

  const tools = (body.tools || []).map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || "",
      parameters: t.input_schema || { type: "object", properties: {} },
    },
  }));

  const payload = {
    model: MODEL,
    messages,
    stream: !!body.stream,
    max_tokens: body.max_tokens || 4096,
    temperature: body.temperature,
  };
  if (tools.length) payload.tools = tools;
  if (body.tool_choice && body.tool_choice.type === "tool") {
    payload.tool_choice = { type: "function", function: { name: body.tool_choice.name } };
  } else if (body.tool_choice && body.tool_choice.type === "any") {
    payload.tool_choice = "required";
  } else if (body.tool_choice && body.tool_choice.type === "auto") {
    payload.tool_choice = "auto";
  }
  if (body.stop_sequences && body.stop_sequences.length) payload.stop = body.stop_sequences;
  return payload;
}

function sse(res, event) {
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

function messageStart(id, model, inputTokens) {
  return {
    type: "message_start",
    message: {
      id: `msg_${id}`,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
  };
}

function openAIFinishToAnthropic(finish) {
  if (finish === "tool_calls" || finish === "function_call") return "tool_use";
  if (finish === "length") return "max_tokens";
  return "end_turn";
}

async function streamTranslate(upstream, res, id, model, inputTokens) {
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let started = false;
  let textStarted = false;
  let thinkingStarted = false;
  let toolStarted = new Map();
  let toolState = new Map();
  let stopReason = null;
  let outputTokens = 0;
  let firstChunk = true;

  sse(res, messageStart(id, model, inputTokens));

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let chunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      const choice = chunk.choices && chunk.choices[0];
      if (!choice) {
        if (chunk.usage) {
          outputTokens = chunk.usage.completion_tokens || chunk.usage.total_tokens || outputTokens;
        }
        continue;
      }
      const delta = choice.delta || {};
      if (chunk.usage) {
        outputTokens = chunk.usage.completion_tokens || chunk.usage.total_tokens || outputTokens;
      }

      if (delta.reasoning_content) {
        if (!thinkingStarted) {
          sse(res, {
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking", thinking: "", signature: "" },
          });
          thinkingStarted = true;
        }
        sse(res, {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: delta.reasoning_content },
        });
      }

      if (delta.content) {
        if (!textStarted) {
          const ti = thinkingStarted ? 1 : 0;
          sse(res, {
            type: "content_block_start",
            index: ti,
            content_block: { type: "text", text: "" },
          });
          textStarted = true;
        }
        const ti = thinkingStarted ? 1 : 0;
        sse(res, { type: "content_block_delta", index: ti, delta: { type: "text_delta", text: delta.content } });
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          if (!toolStarted.has(idx)) {
            const name = tc.function && tc.function.name ? tc.function.name : "unknown";
            const tcid = tc.id || `toolu_${id}_${idx}`;
            toolState.set(idx, { id: tcid, name });
            toolStarted.set(idx, true);
            const bi = idx + (thinkingStarted ? 1 : 0) + (textStarted ? 1 : 0);
            sse(res, {
              type: "content_block_start",
              index: bi,
              content_block: { type: "tool_use", id: tcid, name, input: {} },
            });
          }
          const args = tc.function && tc.function.arguments ? tc.function.arguments : "";
          if (args) {
            const bi = idx + (thinkingStarted ? 1 : 0) + (textStarted ? 1 : 0);
            sse(res, {
              type: "content_block_delta",
              index: bi,
              delta: { type: "input_json_delta", partial_json: args },
            });
          }
        }
      }

      if (choice.finish_reason) {
        stopReason = openAIFinishToAnthropic(choice.finish_reason);
      }
    }
  }

  if (thinkingStarted) {
    sse(res, { type: "content_block_stop", index: 0 });
  }
  if (textStarted) {
    sse(res, { type: "content_block_stop", index: thinkingStarted ? 1 : 0 });
  }
  for (const idx of toolStarted.keys()) {
    const bi = idx + (thinkingStarted ? 1 : 0) + (textStarted ? 1 : 0);
    sse(res, { type: "content_block_stop", index: bi });
  }
  sse(res, {
    type: "message_delta",
    delta: { stop_reason: stopReason || "end_turn", stop_sequence: null },
    usage: { output_tokens: outputTokens },
  });
  sse(res, { type: "message_stop" });
}

async function nonStreamTranslate(upstream, res, id, model, inputTokens) {
  const data = await upstream.json();
  if (data.error) {
    res.writeHead(upstream.status || 500, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        type: "error",
        error: { type: "api_error", message: data.error.message || "Upstream error" },
      })
    );
    return;
  }
  const choice = data.choices && data.choices[0];
  const msg = choice ? choice.message : { content: "" };
  const blocks = [];
  if (msg.reasoning_content) {
    blocks.push({ type: "thinking", thinking: msg.reasoning_content, signature: "" });
  }
  if (msg.content) blocks.push({ type: "text", text: msg.content });
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      let input;
      try {
        input = JSON.parse(tc.function.arguments || "{}");
      } catch {
        input = {};
      }
      blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
    }
  }
  const usage = data.usage || {};
  const payload = {
    id: `msg_${id}`,
    type: "message",
    role: "assistant",
    model,
    content: blocks,
    stop_reason: choice && choice.finish_reason ? openAIFinishToAnthropic(choice.finish_reason) : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens || inputTokens,
      output_tokens: usage.completion_tokens || 0,
    },
  };
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "GET" && url.pathname === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: MODEL, object: "model", owned_by: "zen" }] }));
    return;
  }
  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "method not allowed" }));
    return;
  }

  let raw = "";
  for await (const chunk of req) raw += chunk;
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "invalid json" }));
    return;
  }

  if (url.pathname === "/v1/messages/count_tokens") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ input_tokens: countRequestTokens(body) }));
    return;
  }

  if (url.pathname !== "/v1/messages") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }

  const payload = anthropicToOpenAI(body);
  const id = Math.random().toString(36).slice(2, 12);
  const inputTokens = countRequestTokens(body);

  let upstream;
  try {
    upstream = await fetch(`${ZEN_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ZEN_KEY}`,
        "x-opencode-session": `zen-proxy-${process.pid}-${Date.now()}`,
        "x-opencode-request": "zen-proxy",
        "x-opencode-client": "zen-proxy",
        "user-agent": "opencode/1.18.18",
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: `upstream unreachable: ${e.message}` } }));
    return;
  }

  if (!upstream.ok) {
    let errMsg = `upstream error ${upstream.status}`;
    try {
      const e = await upstream.json();
      errMsg = (e.error && e.error.message) || errMsg;
    } catch {}
    res.writeHead(upstream.status, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: errMsg } }));
    return;
  }

  if (body.stream) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    try {
      await streamTranslate(upstream, res, id, MODEL, inputTokens);
    } catch (e) {
      sse(res, { type: "error", error: { type: "api_error", message: e.message } });
    }
    res.end();
  } else {
    await nonStreamTranslate(upstream, res, id, MODEL, inputTokens);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`zen proxy listening on http://127.0.0.1:${PORT} (model: ${MODEL})`);
});