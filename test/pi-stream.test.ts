// Offline integration, NOT paid/live-provider validation: the server scripts Codex SSE bytes.
// Pi's loader imports the installed CLIProxyAPI adapter unchanged; Pi executes the tool loop.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { zstdDecompressSync } from "node:zlib";
import { Type, type AssistantMessage, type AssistantMessageEvent, type AssistantMessageEventStream, type Context } from "@earendil-works/pi-ai";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { isolateProvider } from "./helpers/offline-provider.ts";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MODEL_ID = "fake-model";
const API = "cliproxyapi-codex-responses";
const CATALOG_PATH = "/proxy/v1/models?client_version=pi";
const INFERENCE_PATH = "/proxy/backend-api/codex/responses";
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

type WireBody = {
  model: string; instructions: string; stream: boolean; store: boolean;
  tools: { type: string; name: string; parameters: unknown }[];
  input: Record<string, unknown>[];
  [key: string]: unknown;
};
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

async function sendSSE(response: ServerResponse, frames: Frame[], end = true): Promise<void> {
  response.writeHead(200, { "content-type": "text/event-stream", "x-offline-fixture": "sse" });
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
  if (end && !response.destroyed) response.end("data: [DONE]\n\n");
}

function unavailable(_request: WireRequest, response: ServerResponse): void {
  response.writeHead(503, { "content-type": "application/json", "retry-after-ms": "0" });
  response.end(JSON.stringify({ error: { message: "offline service unavailable", type: "server_error" } }));
}

async function start(t: TestContext, reply: Reply, agentRetries = 0) {
  const root = mkdtempSync(join(tmpdir(), "pi cliproxyapi stream "));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  const requests: WireRequest[] = [];
  const catalogRequests: { method: string | undefined; url: string | undefined; auth: string | undefined }[] = [];
  const failures: unknown[] = [];
  let session: AgentSession | undefined;
  let restore = () => {};
  const server = createServer((request, response) => {
    void (async () => {
      if (request.url === CATALOG_PATH) {
        catalogRequests.push({ method: request.method, url: request.url, auth: request.headers.authorization });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ models: [{ slug: MODEL_ID, display_name: "Offline fixture", context_window: 100_000, input_modalities: ["text"] }] }));
        return;
      }
      assert.equal(request.url, INFERENCE_PATH, "provider must use the configured inference endpoint");
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
  restore = isolateProvider(t, agentDir, `${origin}/proxy/v1/`);
  const settingsManager = SettingsManager.inMemory({
    defaultProvider: "cliproxyapi", defaultModel: MODEL_ID, defaultThinkingLevel: "off",
    compaction: { enabled: false }, cacheWarming: "off", enableInstallTelemetry: false,
    transport: "sse",
    retry: { enabled: agentRetries > 0, maxRetries: agentRetries, baseDelayMs: 1, maxAgentDelayMs: 1, provider: { maxRetries: 0 } },
  });
  const hookOrder: string[] = [];
  const rawFrames: Frame[] = [];
  const payloads: unknown[] = [];
  const responseStatuses: number[] = [];
  const loader = new DefaultResourceLoader({
    cwd: root, agentDir, settingsManager, additionalExtensionPaths: [packageDir],
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPromptOverride: () => INSTRUCTIONS,
    extensionFactories: [pi => {
      pi.on("before_provider_headers", event => { event.headers["x-offline-boundary"] = "sdk"; });
      pi.on("before_provider_request", event => {
        hookOrder.push("payload");
        const payload = { ...(event.payload as WireBody), metadata: { fixture: "loopback-only" } };
        payloads.push(structuredClone(payload));
        return payload;
      });
      pi.on("after_provider_response", event => {
        hookOrder.push("response");
        responseStatuses.push(event.status);
        if (event.status === 200) assert.equal(event.headers["x-offline-fixture"], "sse");
      });
      pi.on("provider_stream_event", event => {
        assert.equal(event.provider, "cliproxyapi");
        assert.equal(event.api, API);
        assert.equal(event.model, MODEL_ID);
        const frame = structuredClone(event.data) as Frame;
        hookOrder.push(frame.type);
        rawFrames.push(frame);
      });
    }],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const executions: unknown[] = [];
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models-cache.json"),
    allowModelNetwork: false, refreshOnCreate: false,
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
  const model = session.modelRuntime.getModel("cliproxyapi", MODEL_ID);
  assert.ok(model, "the actual installed provider registered its model");
  assert.equal(model.api, API);
  assert.equal(model.baseUrl, `${origin}/proxy/backend-api/`);
  await session.setModel(model);
  assert.deepEqual(session.getActiveToolNames(), ["echo"]);
  const events: AgentSessionEvent[] = [];
  session.subscribe(event => { events.push(structuredClone(event)); });
  return { session, model, requests, catalogRequests, executions, events, hookOrder, rawFrames, payloads, responseStatuses };
}

type Harness = Awaited<ReturnType<typeof start>>;

function assertBoundary(h: Harness, attempts: number): void {
  assert.deepEqual(h.catalogRequests, [{ method: "GET", url: CATALOG_PATH, auth: "Bearer dummy-test-key" }]);
  assert.equal(h.requests.length, attempts);
  for (const request of h.requests) {
    assert.equal(request.method, "POST");
    assert.equal(request.url, INFERENCE_PATH);
    assert.equal(request.headers.authorization, "Bearer dummy-test-key");
    assert.equal(request.headers["chatgpt-account-id"], undefined, "plain proxy keys must not need a ChatGPT account");
    assert.equal(request.headers["content-type"], "application/json");
    assert.equal(request.headers.accept, "text/event-stream");
    assert.equal(request.headers["openai-beta"], "responses=experimental");
    assert.equal(request.body.model, MODEL_ID);
    assert.equal(request.body.stream, true);
    assert.equal(request.body.store, false);
    assert.match(request.body.instructions, /Offline CLIProxyAPI compatibility fixture/);
    assert.deepEqual(request.body.tools.map(tool => ({ type: tool.type, name: tool.name, parameters: tool.parameters })), [
      { type: "function", name: "echo", parameters: JSON.parse(JSON.stringify(TOOL_PARAMETERS)) },
    ]);
    assert.equal(request.body.input[0]?.role, "user");
    assert.equal(request.body.service_tier, undefined, "ambient Fast mode is disabled in the fixture");
  }
}

function assistantEnds(h: Harness): AssistantMessage[] {
  return h.events.flatMap(event => event.type === "message_end" && event.message.role === "assistant" ? [event.message] : []);
}

function assertSettled(h: Harness, aborted = false): void {
  assert.deepEqual(h.events.filter(event => event.type === "agent_settled"), [{ type: "agent_settled", aborted }]);
  assert.equal(h.session.isIdle, true);
  assert.equal(h.session.isStreaming, false);
  assert.equal(h.session.isRetrying, false);
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
  assert.deepEqual(terminals[0]?.type === "error" ? terminals[0].error : terminals[0]?.message, result);
  return { events, result };
}

test("Pi 1.3 + installed CLIProxyAPI: fragmented arguments execute once and the result round-trips", { timeout: 30_000 }, async t => {
  for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "@router-for-me/pi-cliproxyapi-provider"]) {
    const manifest = JSON.parse(readFileSync(join(packageDir, "node_modules", name, "package.json"), "utf8"));
    t.diagnostic(`${name}@${manifest.version}`);
  }
  const fragments = ['{"te', 'xt":"line\\', 'n\\"quoted\\" 한', '글 😀","meta":{"count":', '2,"active":tr', 'ue}}'];
  const args = { text: 'line\n"quoted" 한글 😀', meta: { count: 2, active: true } };
  const first = toolFrames(fragments);
  const second = textFrames();
  const h = await start(t, async (_request, response, attempt) => {
    assert.ok(attempt <= 2, "only tool call and result continuation");
    await sendSSE(response, attempt === 1 ? first : second);
  });
  await h.session.prompt("Echo the supplied test data.");
  assertBoundary(h, 2);
  assert.deepEqual(h.executions, [args]);
  const ends = assistantEnds(h);
  assert.deepEqual(ends.map(message => message.stopReason), ["toolUse", "stop"]);
  assert.equal(ends[0]?.api, API);
  assert.deepEqual(ends[0]?.content, [{ type: "toolCall", id: TOOL_ID, name: "echo", arguments: args }]);
  assert.equal(ends[0]?.usage.input, 9);
  assert.equal(ends[0]?.usage.cacheRead, 3);
  assert.equal(ends[0]?.usage.output, 5);
  assert.equal(ends[0]?.usage.totalTokens, 17);
  assert.ok(Math.abs(ends[0]!.usage.cost.total - 0.000041) < 1e-12, "synthetic pricing cache is used");
  const updates = h.events.flatMap(event => event.type === "message_update" ? [event.assistantMessageEvent] : []);
  assert.equal(updates.filter(event => event.type === "toolcall_start").length, 1);
  assert.equal(updates.filter(event => event.type === "toolcall_end").length, 1);
  assert.deepEqual(updates.filter(event => event.type === "toolcall_delta").map(event => event.delta), fragments);
  assert.equal(updates.filter(event => event.type === "text_start").length, 1);
  assert.equal(updates.filter(event => event.type === "text_end").length, 1);
  const result = h.session.messages.find(message => message.role === "toolResult");
  assert.ok(result && result.role === "toolResult");
  assert.equal(result.isError, false);
  assert.equal(result.toolCallId, TOOL_ID);
  const replay = h.requests[1]!.body.input;
  assert.deepEqual(replay.find(item => item.type === "function_call"), {
    type: "function_call", id: "fc_echo_1", call_id: "call_echo_1", name: "echo", arguments: JSON.stringify(args),
  });
  assert.deepEqual(replay.find(item => item.type === "function_call_output"), {
    type: "function_call_output", call_id: "call_echo_1", output: JSON.stringify(args),
  });
  assert.equal(h.session.getLastAssistantText(), "Tool result accepted.");
  assert.deepEqual(h.payloads, h.requests.map(request => request.body), "onPayload replacement reaches HTTP unchanged");
  assert.ok(h.requests.every(request => request.headers["x-offline-boundary"] === "sdk"));
  assert.deepEqual(h.responseStatuses, [200, 200]);
  assert.deepEqual(h.rawFrames, [...first, ...second], "raw provider events arrive once, before normalization");
  assert.deepEqual(h.hookOrder, ["payload", "response", ...first.map(frame => frame.type), "payload", "response", ...second.map(frame => frame.type)]);
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
    assertBoundary(h, 2);
    assert.deepEqual(h.executions, []);
    const call = assistantEnds(h)[0]?.content.find(block => block.type === "toolCall");
    assert.ok(call && call.type === "toolCall");
    assert.deepEqual(call.arguments, {});
    assert.ok(call.argumentsError?.includes(malformed), "malformed input is not repaired to an executable prefix");
    const results = h.session.messages.filter(message => message.role === "toolResult");
    assert.equal(results.length, 1);
    assert.equal(results[0]?.isError, true);
    const replay = h.requests[1]!.body.input.find(item => item.type === "function_call_output");
    assert.equal(replay?.call_id, "call_echo_1");
    assert.ok(JSON.stringify(replay?.output).includes("Received arguments"));
    assert.deepEqual(assistantEnds(h).map(message => message.stopReason), ["toolUse", "stop"]);
    assertSettled(h);
  });
}

test("malformed SSE JSON produces one failed assistant outcome and zero tool executions", { timeout: 30_000 }, async t => {
  const h = await start(t, async (_request, response) => {
    await sendSSE(response, toolFrames(['{"text":"partial"'], false), false);
    response.end('data: {"type": not-json}\n\n');
  });
  await h.session.prompt("Read a broken SSE event.");
  assertBoundary(h, 1);
  assert.deepEqual(h.executions, []);
  assert.equal(assistantEnds(h).length, 1);
  assert.equal(assistantEnds(h)[0]?.stopReason, "error");
  assert.match(assistantEnds(h)[0]?.errorMessage ?? "", /Invalid Codex SSE JSON/);
  assert.equal(h.session.messages.some(message => message.role === "toolResult"), false);
  assertSettled(h);
});

test("AbortSignal cancels a pending SSE read with exactly one terminal error and closes the connection", { timeout: 30_000 }, async t => {
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
  assertBoundary(h, 1);
  assert.equal(events.filter(event => event.type === "start").length, 1);
  assert.equal(events.some(event => event.type === "toolcall_end" || event.type === "done"), false);
  assert.equal(result.stopReason, "aborted");
  assert.match(result.errorMessage ?? "", /abort/i);
});

test("SDK abort settles once, never executes the partial tool and does not retry", { timeout: 30_000 }, async t => {
  let onPartial!: () => void;
  const partial = new Promise<void>(resolve => { onPartial = resolve; });
  const h = await start(t, (_request, response) => sendSSE(response, toolFrames(['{"text":"partial"'], false), false), 2);
  h.session.subscribe(event => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "toolcall_delta") onPartial();
  });
  const prompt = h.session.prompt("Wait for cancellation.");
  await partial;
  await h.session.abort();
  await prompt;
  assertBoundary(h, 1);
  assert.deepEqual(h.executions, []);
  assert.deepEqual(assistantEnds(h).map(message => message.stopReason), ["aborted"]);
  assert.equal(h.events.some(event => event.type === "auto_retry_start"), false);
  assertSettled(h, true);
});

test("provider retry exhaustion makes exactly three HTTP attempts and one terminal stream error", { timeout: 30_000 }, async t => {
  const h = await start(t, unavailable);
  const statuses: number[] = [];
  const stream = h.session.modelRuntime.streamSimple(h.model, DIRECT_CONTEXT, {
    transport: "sse", maxRetries: 2, signal: t.signal,
    onResponse: response => { statuses.push(response.status); },
  });
  const { events, result } = await collect(stream);
  assertBoundary(h, 3);
  assert.deepEqual(statuses, [503, 503, 503]);
  assert.deepEqual(events.map(event => event.type), ["error"], "setup failures emit no start or done");
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage ?? "", /offline service unavailable/);
  assert.deepEqual(h.requests.map(request => request.body), Array(3).fill(h.requests[0]!.body));
});

test("SDK retry exhaustion has intermediate runs but exactly one final failure and settlement", { timeout: 30_000 }, async t => {
  const h = await start(t, unavailable, 2);
  await h.session.prompt("Exhaust two retries.");
  assertBoundary(h, 3);
  assert.deepEqual(h.executions, []);
  assert.deepEqual(assistantEnds(h).map(message => message.stopReason), ["error", "error", "error"]);
  assert.deepEqual(h.events.filter(event => event.type === "auto_retry_start").map(event => event.attempt), [1, 2]);
  const endings = h.events.filter(event => event.type === "auto_retry_end");
  assert.equal(endings.length, 1);
  assert.equal(endings[0]?.success, false);
  assert.equal(endings[0]?.attempt, 2);
  assert.match(endings[0]?.finalError ?? "", /offline service unavailable/);
  assert.deepEqual(h.events.filter(event => event.type === "agent_end").map(event => event.willRetry), [true, true, false]);
  assertSettled(h);
});
