// Offline integration, NOT paid/live-provider validation: a loopback server stands in for CLIProxyAPI, lists models and
// scripts the SSE bytes. Pi's loader imports the installed pi-cliproxyapi-provider unchanged through this bundle; it
// registers the models (Codex GPT -> openai-responses, Claude -> anthropic-messages) and Pi's own API drivers stream them.
// Pi executes the tool loop.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { zstdDecompressSync } from "node:zlib";
import type { AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream, Context } from "@earendil-works/pi-ai";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isolateProvider } from "./helpers/offline-provider.ts";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROVIDER = "cpa";
const GPT = "gpt-6-astra";
const CLAUDE = "claude-opus-4-6";
const CATALOG = { object: "list", data: [{ id: GPT, object: "model", owned_by: "openai" }, { id: CLAUDE, object: "model", owned_by: "anthropic" }] };
const RESPONSES_PATH = "/v1/responses";
const MESSAGES_PATH = "/v1/messages";
const INSTRUCTIONS = "Offline CLIProxyAPI compatibility fixture. Use only the echo tool.";
const TOOL_ID = "call_echo_1|fc_echo_1";
const TOOL_PARAMETERS = Type.Object({
  // Optional on purpose: even {} passes the schema, so malformed JSON must be rejected as JSON,
  // not accidentally blocked only because a required property happens to be missing.
  text: Type.Optional(Type.String()),
  meta: Type.Optional(Type.Object({ count: Type.Integer(), active: Type.Boolean() })),
});
const DIRECT_CONTEXT: Context = {
  systemPrompt: INSTRUCTIONS,
  messages: [{ role: "user", content: "Exercise the offline fixture.", timestamp: 1 }],
  tools: [{ name: "echo", description: "Echo test data", parameters: TOOL_PARAMETERS }],
};
const USAGE = { input_tokens: 12, input_tokens_details: { cached_tokens: 3 }, output_tokens: 5, total_tokens: 17 };

type WireBody = { model: string; stream: boolean; tools?: Record<string, unknown>[]; input?: Record<string, unknown>[]; [key: string]: unknown };
type WireRequest = { method: string | undefined; url: string | undefined; headers: IncomingHttpHeaders; body: WireBody };
type Frame = { type: string; [key: string]: unknown };
type Reply = (request: WireRequest, response: ServerResponse, attempt: number) => Promise<void> | void;

function toolFrames(fragments: string[], complete = true): Frame[] {
  const item = { type: "function_call", id: "fc_echo_1", call_id: "call_echo_1", name: "echo", arguments: "", status: "in_progress" };
  const args = fragments.join("");
  const frames: Frame[] = [
    { type: "response.created", response: { id: "resp_tool", status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item },
    ...fragments.map(delta => ({ type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta })),
  ];
  if (complete) frames.push(
    { type: "response.function_call_arguments.done", output_index: 0, item_id: item.id, arguments: args },
    { type: "response.output_item.done", output_index: 0, item: { ...item, arguments: args, status: "completed" } },
    { type: "response.completed", response: { id: "resp_tool", status: "completed", usage: USAGE } },
  );
  return frames;
}

function textFrames(): Frame[] {
  const item = { type: "message", id: "msg_final", role: "assistant", content: [], status: "in_progress" };
  return [
    { type: "response.created", response: { id: "resp_final", status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_text.delta", output_index: 0, item_id: item.id, delta: "Tool result " },
    { type: "response.output_text.delta", output_index: 0, item_id: item.id, delta: "accepted." },
    { type: "response.output_item.done", output_index: 0, item: { ...item, status: "completed", content: [{ type: "output_text", text: "Tool result accepted." }] } },
    { type: "response.completed", response: { id: "resp_final", status: "completed", usage: USAGE } },
  ];
}

function anthropicFrames(): Frame[] {
  return [
    { type: "message_start", message: { id: "msg_claude", type: "message", role: "assistant", model: CLAUDE, content: [], stop_reason: null, usage: { input_tokens: 7, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Claude via " } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Messages." } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } },
    { type: "message_stop" },
  ];
}

async function sendSSE(response: ServerResponse, frames: Frame[], end = true): Promise<void> {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.flushHeaders();
  for (const frame of frames) {
    const bytes = Buffer.from(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
    // Split both framing and UTF-8 bytes, in addition to the separate argument delta events.
    const korean = bytes.indexOf(Buffer.from("한"));
    const cuts = [...new Set([0, 3, Math.floor(bytes.length / 2), ...(korean >= 0 ? [korean + 1, korean + 2] : []), bytes.length - 1, bytes.length])].sort((a, b) => a - b);
    for (let i = 1; i < cuts.length; i++) {
      if (response.destroyed) return;
      response.write(bytes.subarray(cuts[i - 1], cuts[i]));
      await setImmediate();
    }
  }
  if (end && !response.destroyed) response.end();
}

async function start(t: TestContext, reply: Reply, modelId = GPT) {
  const root = mkdtempSync(join(tmpdir(), "pi cliproxyapi stream "));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  const requests: WireRequest[] = [];
  const catalogRequests: { method: string | undefined; auth: string | undefined }[] = [];
  const failures: unknown[] = [];
  let session: AgentSession | undefined;
  let restore = () => {};
  const server = createServer((request, response) => {
    void (async () => {
      if (request.url === "/v1/models") {
        catalogRequests.push({ method: request.method, auth: request.headers.authorization });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(CATALOG));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const encoded = Buffer.concat(chunks);
      const encoding = request.headers["content-encoding"];
      assert.ok(encoding === undefined || encoding === "zstd", "only Pi's optional zstd request compression");
      const body = JSON.parse((encoding === "zstd" ? zstdDecompressSync(encoded) : encoded).toString("utf8")) as WireBody;
      const wire = { method: request.method, url: request.url, headers: request.headers, body };
      requests.push(wire);
      await reply(wire, response, requests.length);
    })().catch(error => {
      failures.push(error);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  server.on("upgrade", (_request, socket) => {
    failures.push(new Error("SSE tests must not attempt WebSocket upgrades"));
    socket.destroy();
  });
  // Install cleanup before async setup: failed loader/bind assertions must not leak sockets or env.
  t.after(async () => {
    try {
      await session?.abort();
      await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    } finally {
      session?.dispose();
      server.closeAllConnections();
      await new Promise<void>(done => server.close(() => done()));
      rmSync(root, { recursive: true, force: true });
      restore();
    }
    assert.deepEqual(failures, [], "no server or extension failures");
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  restore = isolateProvider(t, root, agentDir, `${origin}/v1`);
  const settingsManager = SettingsManager.inMemory({
    defaultThinkingLevel: "off", compaction: { enabled: false }, cacheWarming: "off", enableInstallTelemetry: false,
    transport: "sse", retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
  });
  const payloads: unknown[] = [];
  const loader = new DefaultResourceLoader({
    cwd: root, agentDir, settingsManager, additionalExtensionPaths: [packageDir],
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPromptOverride: () => INSTRUCTIONS,
    // Registered after the bundle, so it sees the payload after the provider's own before_provider_request adapter.
    extensionFactories: [pi => { pi.on("before_provider_request", event => { payloads.push(structuredClone(event.payload)); }); }],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const executions: unknown[] = [];
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models-cache.json"), refreshOnCreate: false,
  });
  ({ session } = await createAgentSession({
    cwd: root, agentDir, resourceLoader: loader, settingsManager, modelRuntime,
    sessionManager: SessionManager.inMemory(root), noTools: "builtin",
    customTools: [{
      name: "echo", label: "Echo", description: "Echo test data", parameters: TOOL_PARAMETERS,
      execute: async (_id, args) => {
        executions.push(structuredClone(args));
        return { content: [{ type: "text", text: JSON.stringify(args) }], details: undefined };
      },
    }],
  }));
  await session.bindExtensions({ onError: error => failures.push(error) });
  const refreshed = await modelRuntime.refresh({ providers: [PROVIDER], allowNetwork: true, force: true });
  assert.equal(refreshed.errors.size, 0);
  const model = session.modelRuntime.getModel(PROVIDER, modelId);
  assert.ok(model, "the actual installed provider registered its model");
  await session.setModel(model);
  assert.deepEqual(session.getActiveToolNames(), ["echo"]);
  const events: AgentSessionEvent[] = [];
  session.subscribe(event => { events.push(structuredClone(event)); });
  return { session, model, origin, requests, catalogRequests, executions, events, payloads };
}

type Harness = Awaited<ReturnType<typeof start>>;

/**
 * Endpoint, authentication and the provider's Codex-compatible tool wire contract on every attempt: `strict: null` comes
 * from its `before_provider_request` adapter, so it applies to agent-session turns, not to direct `streamSimple` calls.
 */
function assertResponsesBoundary(h: Harness, attempts: number, direct = false): void {
  const strict = direct ? undefined : null;
  assert.deepEqual(h.catalogRequests, [{ method: "GET", auth: "Bearer dummy-test-key" }]);
  assert.equal(h.requests.length, attempts);
  for (const request of h.requests) {
    assert.equal(request.method, "POST");
    assert.equal(request.url, RESPONSES_PATH);
    assert.equal(request.headers.authorization, "Bearer dummy-test-key");
    assert.equal(request.headers["chatgpt-account-id"], undefined, "plain proxy keys need no ChatGPT account");
    assert.equal(request.body.model, GPT);
    assert.equal(request.body.stream, true);
    assert.deepEqual(request.body.tools?.map(tool => ({ type: tool.type, name: tool.name, strict: tool.strict, parameters: tool.parameters })), [
      { type: "function", name: "echo", strict, parameters: JSON.parse(JSON.stringify(TOOL_PARAMETERS)) },
    ]);
  }
}

function assistantEnds(h: Harness): AssistantMessage[] {
  return h.events.flatMap(event => event.type === "message_end" && event.message.role === "assistant" ? [event.message] : []);
}

function assertSettled(h: Harness, aborted = false): void {
  assert.deepEqual(h.events.filter(event => event.type === "agent_settled"), [{ type: "agent_settled", aborted }]);
  assert.equal(h.session.isIdle, true);
  assert.equal(h.session.isStreaming, false);
}

async function collect(stream: AssistantMessageEventStream, onEvent?: (event: AssistantMessageEvent) => void) {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) {
    events.push(structuredClone(event));
    onEvent?.(event);
  }
  const result = await stream.result();
  const terminals = events.filter(event => event.type === "done" || event.type === "error");
  assert.equal(terminals.length, 1, "exactly one terminal stream event");
  assert.deepEqual(events.at(-1), terminals[0], "no events after the terminal outcome");
  return { events, result };
}

test("Codex GPT over Responses: fragmented arguments execute once and the result round-trips", { timeout: 30_000 }, async t => {
  for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "pi-cliproxyapi-provider"]) {
    const manifest = JSON.parse(readFileSync(join(packageDir, "node_modules", name, "package.json"), "utf8"));
    t.diagnostic(`${name}@${manifest.version}`);
  }
  const fragments = ['{"te', 'xt":"line\\', 'n\\"quoted\\" 한', '글 😀","meta":{"count":', '2,"active":tr', 'ue}}'];
  const args = { text: 'line\n"quoted" 한글 😀', meta: { count: 2, active: true } };
  const h = await start(t, async (_request, response, attempt) => {
    assert.ok(attempt <= 2, "only tool call and result continuation");
    await sendSSE(response, attempt === 1 ? toolFrames(fragments) : textFrames());
  });
  assert.equal(h.model.api, "openai-responses");
  assert.equal(h.model.baseUrl, `${h.origin}/v1`);
  await h.session.prompt("Echo the supplied test data.");
  assertResponsesBoundary(h, 2);
  assert.deepEqual(h.executions, [args]);
  const ends = assistantEnds(h);
  assert.deepEqual(ends.map(message => message.stopReason), ["toolUse", "stop"]);
  assert.equal(ends[0]?.provider, PROVIDER);
  assert.deepEqual(ends[0]?.content, [{ type: "toolCall", id: TOOL_ID, name: "echo", arguments: args }]);
  assert.equal(ends[0]?.usage.input, 9);
  assert.equal(ends[0]?.usage.cacheRead, 3);
  assert.equal(ends[0]?.usage.output, 5);
  const updates = h.events.flatMap(event => event.type === "message_update" ? [event.assistantMessageEvent] : []);
  assert.equal(updates.filter(event => event.type === "toolcall_start").length, 1);
  assert.equal(updates.filter(event => event.type === "toolcall_end").length, 1);
  const result = h.session.messages.find(message => message.role === "toolResult");
  assert.ok(result && result.role === "toolResult");
  assert.equal(result.isError, false);
  assert.equal(result.toolCallId, TOOL_ID);
  const replay = h.requests[1]!.body.input ?? [];
  const call = replay.find(item => item.type === "function_call");
  assert.deepEqual({ id: call?.id, call_id: call?.call_id, name: call?.name, arguments: call?.arguments },
    { id: "fc_echo_1", call_id: "call_echo_1", name: "echo", arguments: JSON.stringify(args) });
  const output = replay.find(item => item.type === "function_call_output");
  assert.equal(output?.call_id, "call_echo_1");
  assert.equal(output?.output, JSON.stringify(args));
  assert.equal(h.session.getLastAssistantText(), "Tool result accepted.");
  assert.deepEqual(JSON.parse(JSON.stringify(h.payloads)), h.requests.map(request => request.body), "the adapted payload reaches HTTP unchanged");
  assertSettled(h);
});

for (const [label, malformed] of [
  ["truncated object", '{"text":"must not execute"'],
  ["trailing garbage", '{"text":"must not execute"} trailing'],
]) {
  test(`malformed tool JSON (${label}) is reported back without executing even a permissive tool`, { timeout: 30_000 }, async t => {
    const h = await start(t, async (_request, response, attempt) => {
      assert.ok(attempt <= 2);
      await sendSSE(response, attempt === 1 ? toolFrames([malformed]) : textFrames());
    });
    await h.session.prompt("Try the malformed tool call.");
    assertResponsesBoundary(h, 2);
    assert.deepEqual(h.executions, []);
    const results = h.session.messages.filter(message => message.role === "toolResult");
    assert.equal(results.length, 1);
    assert.equal(results[0]?.isError, true);
    const replay = h.requests[1]!.body.input?.find(item => item.type === "function_call_output");
    assert.equal(replay?.call_id, "call_echo_1");
    assert.deepEqual(assistantEnds(h).map(message => message.stopReason), ["toolUse", "stop"]);
    assertSettled(h);
  });
}

test("AbortSignal cancels a pending SSE read with exactly one terminal outcome and closes the connection", { timeout: 30_000 }, async t => {
  let onClose!: () => void;
  const closed = new Promise<void>(resolve => { onClose = resolve; });
  const h = await start(t, async (_request, response) => {
    response.once("close", onClose);
    await sendSSE(response, toolFrames(['{"text":"partial"'], false), false);
  });
  const controller = new AbortController();
  const stream = h.session.modelRuntime.streamSimple(h.model, DIRECT_CONTEXT, {
    signal: AbortSignal.any([controller.signal, t.signal]), transport: "sse", maxRetries: 0,
  });
  const { events, result } = await collect(stream, event => {
    if (event.type === "toolcall_delta") controller.abort();
  });
  await closed;
  assertResponsesBoundary(h, 1, true);
  assert.equal(events.some(event => event.type === "toolcall_end" || event.type === "done"), false);
  assert.equal(result.stopReason, "aborted");
});

test("SDK abort settles once and never executes the partial tool", { timeout: 30_000 }, async t => {
  let onPartial!: () => void;
  const partial = new Promise<void>(resolve => { onPartial = resolve; });
  const h = await start(t, (_request, response) => sendSSE(response, toolFrames(['{"text":"partial"'], false), false));
  h.session.subscribe(event => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "toolcall_delta") onPartial();
  });
  const prompt = h.session.prompt("Wait for cancellation.");
  await partial;
  await h.session.abort();
  await prompt;
  assertResponsesBoundary(h, 1);
  assert.deepEqual(h.executions, []);
  assert.deepEqual(assistantEnds(h).map(message => message.stopReason), ["aborted"]);
  assertSettled(h, true);
});

test("a failed CLIProxyAPI response is one error outcome with no tool execution", { timeout: 30_000 }, async t => {
  const h = await start(t, (_request, response) => {
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "offline service unavailable", type: "server_error" } }));
  });
  await h.session.prompt("Fail once.");
  assertResponsesBoundary(h, 1);
  assert.deepEqual(h.executions, []);
  assert.deepEqual(assistantEnds(h).map(message => message.stopReason), ["error"]);
  assert.match(assistantEnds(h)[0]?.errorMessage ?? "", /503|offline service unavailable/);
  assertSettled(h);
});

test("Claude over Anthropic Messages: /v1/messages on the proxy origin, Bearer key, streamed text", { timeout: 30_000 }, async t => {
  const h = await start(t, async (_request, response) => { await sendSSE(response, anthropicFrames()); }, CLAUDE);
  assert.equal(h.model.api, "anthropic-messages");
  assert.equal(h.model.baseUrl, h.origin);
  await h.session.prompt("Say hello.");
  assert.equal(h.requests.length, 1);
  const [request] = h.requests;
  assert.equal(request!.method, "POST");
  assert.equal(request!.url?.split("?")[0], MESSAGES_PATH);
  assert.equal(request!.headers.authorization, "Bearer dummy-test-key");
  assert.equal(request!.body.model, CLAUDE);
  assert.equal(request!.body.stream, true);
  assert.deepEqual(request!.body.tools?.map(tool => tool.name), ["echo"]);
  assert.equal(h.session.getLastAssistantText(), "Claude via Messages.");
  assert.deepEqual(assistantEnds(h).map(message => message.stopReason), ["stop"]);
  assertSettled(h);
});
