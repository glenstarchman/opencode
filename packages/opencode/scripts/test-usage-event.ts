#!/usr/bin/env bun
/**
 * Tests that usage errors are streamed to SSE clients.
 *
 * Usage: bun run scripts/test-usage-event.ts
 */
import { Instance } from "../src/project/instance"
import { Server } from "../src/server/server"
import { Session } from "../src/session"
import { SessionID } from "../src/session/schema"
import { Bus } from "../src/bus"
import { Log } from "../src/util/log"
import { tmpdir } from "../test/fixture/fixture"
import { MessageID } from "../src/session/schema"
import { MessageV2 } from "../src/session/message-v2"
import { SessionPrompt } from "../src/session/prompt"
import { ProviderID, ModelID } from "../src/provider/schema"

Log.init({ print: false })

function assistantError(sessionID: SessionID, error: MessageV2.Assistant["error"]): MessageV2.WithParts {
  return {
    info: {
      id: MessageID.ascending(),
      sessionID,
      role: "assistant",
      parentID: MessageID.ascending(),
      time: { created: Date.now() },
      providerID: ProviderID.make("test"),
      modelID: ModelID.make("test"),
      mode: "build",
      agent: "build",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      error,
    },
    parts: [],
  }
}

async function main() {
  await using tmp = await tmpdir({ git: true })

  let passed = 0
  let failed = 0

  function ok(msg: string) {
    console.log(`  ✓ ${msg}`)
    passed++
  }

  function fail(msg: string) {
    console.log(`  ✗ ${msg}`)
    failed++
  }

  await Instance.provide({
    directory: tmp.path,
    async fn() {
      const session = await Session.create({})
      const app = Server.Default().app
      console.log("Session:", session.id)

      // Subscribe via SSE stream
      const eventRes = await app.request("/event")
      const reader = eventRes.body!.getReader()
      const decoder = new TextDecoder()
      const sseErrors: any[] = []

      const readPromise = (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            for (const line of decoder.decode(value, { stream: true }).split("\n")) {
              const m = line.match(/^data: (.+)$/)
              if (!m) continue
              const evt = JSON.parse(m[1])
              if (evt.type === "session.error") sseErrors.push(evt)
            }
          }
        } catch {}
      })()

      // Subscribe directly via Bus for comparison
      const directErrors: any[] = []
      const directUnsub = Bus.subscribeAll((event) => {
        if (event.type === "session.error") directErrors.push(event)
      })

      await new Promise((r) => setTimeout(r, 300))

      // ── Test 1: Invalid agent via HTTP ──
      console.log("\n1. prompt_async with invalid agent")
      await app.request(`/session/${session.id}/prompt_async`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parts: [{ type: "text", text: "hi" }], agent: "does-not-exist" }),
      })
      await new Promise((r) => setTimeout(r, 500))

      if (sseErrors.find((e) => e.properties.error?.name === "UnknownError")) {
        ok("SSE stream received error from invalid agent")
      } else {
        fail("SSE stream did NOT receive error from invalid agent")
      }
      if (directErrors.find((e) => e.properties.error?.name === "UnknownError")) {
        ok("Direct Bus subscription received error from invalid agent")
      } else {
        fail("Direct Bus subscription did NOT receive error from invalid agent")
      }

      // ── Test 2: Static Bus.publish with FreeUsageLimitError ──
      console.log("\n2. Static Bus.publish (FreeUsageLimitError)")
      const sess2 = await Session.create({})
      const err2 = new MessageV2.APIError({
        message: "Free usage exceeded, subscribe to Go https://opencode.ai/go",
        statusCode: 429,
        isRetryable: true,
        responseBody: JSON.stringify({ type: "error", error: { type: "FreeUsageLimitError" } }),
      }).toObject()
      await Bus.publish(Session.Event.Error, { sessionID: sess2.id, error: err2 })
      await new Promise((r) => setTimeout(r, 500))

      if (sseErrors.find((e) => e.properties.sessionID === sess2.id)) {
        ok("SSE stream received FreeUsageLimitError from static Bus.publish")
      } else {
        fail("SSE stream did NOT receive FreeUsageLimitError from static Bus.publish")
      }
      if (directErrors.find((e) => e.properties.sessionID === sess2.id)) {
        ok("Direct Bus subscription received FreeUsageLimitError from static Bus.publish")
      } else {
        fail("Direct Bus subscription did NOT receive FreeUsageLimitError from static Bus.publish")
      }

      // ── Test 3: Mocked FreeUsageLimitError via HTTP ──
      console.log("\n3. prompt_async with mocked FreeUsageLimitError")
      const sess3 = await Session.create({})
      const original = SessionPrompt.prompt
      SessionPrompt.prompt = async () =>
        assistantError(
          sess3.id,
          new MessageV2.APIError({
            message: "Free usage exceeded, subscribe to Go https://opencode.ai/go",
            statusCode: 429,
            isRetryable: true,
            responseBody: JSON.stringify({ type: "error", error: { type: "FreeUsageLimitError" } }),
          }).toObject(),
        ) as any

      await app.request(`/session/${sess3.id}/prompt_async`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parts: [{ type: "text", text: "hi" }] }),
      })
      await new Promise((r) => setTimeout(r, 500))
      SessionPrompt.prompt = original

      const hit = (xs: any[]) => xs.find(
        (e) => e.properties.sessionID === sess3.id && e.properties.error?.data?.responseBody?.includes("FreeUsageLimitError"),
      )
      if (hit(sseErrors)) {
        ok("SSE stream received FreeUsageLimitError from mocked prompt_async")
      } else {
        fail("SSE stream did NOT receive FreeUsageLimitError from mocked prompt_async")
      }
      if (hit(directErrors)) {
        ok("Direct Bus subscription received FreeUsageLimitError from mocked prompt_async")
      } else {
        fail("Direct Bus subscription did NOT receive FreeUsageLimitError from mocked prompt_async")
      }

      // Cleanup
      directUnsub()
      reader.cancel()
      await readPromise.catch(() => {})
      await Session.remove(session.id)
      await Session.remove(sess2.id)
      await Session.remove(sess3.id)
    },
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(console.error)
