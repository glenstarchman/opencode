import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRunState } from "../../src/session/run-state"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

afterEach(async () => {
  mock.restore()
  await Instance.disposeAll()
})

async function user(sessionID: SessionID, text: string) {
  const msg = await Session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
    time: { created: Date.now() },
  })
  await Session.updatePart({
    id: PartID.ascending(),
    sessionID,
    messageID: msg.id,
    type: "text",
    text,
  })
  return msg
}

function promptBody() {
  return {
    parts: [{ type: "text", text: "hello" }],
  }
}

function assistantErrorMessage(sessionID: SessionID, error: NonNullable<MessageV2.Assistant["error"]>) {
  return {
    info: {
      id: MessageID.ascending(),
      sessionID,
      role: "assistant" as const,
      parentID: MessageID.ascending(),
      time: { created: Date.now() },
      providerID: ProviderID.make("test"),
      modelID: ModelID.make("test"),
      mode: "build",
      agent: "build",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      error,
    },
    parts: [],
  } satisfies MessageV2.WithParts
}

describe("session action routes", () => {
  test("abort route calls SessionPrompt.cancel", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const cancel = spyOn(SessionPrompt, "cancel").mockResolvedValue()
        const app = Server.Default().app

        const res = await app.request(`/session/${session.id}/abort`, {
          method: "POST",
        })

        expect(res.status).toBe(200)
        expect(await res.json()).toBe(true)
        expect(cancel).toHaveBeenCalledWith(session.id)

        await Session.remove(session.id)
      },
    })
  })

  test("delete message route returns 400 when session is busy", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const msg = await user(session.id, "hello")
        const busy = spyOn(SessionRunState, "assertNotBusy").mockRejectedValue(new Session.BusyError(session.id))
        const remove = spyOn(Session, "removeMessage").mockResolvedValue(msg.id)
        const app = Server.Default().app

        const res = await app.request(`/session/${session.id}/message/${msg.id}`, {
          method: "DELETE",
        })

        expect(res.status).toBe(400)
        expect(busy).toHaveBeenCalledWith(session.id)
        expect(remove).not.toHaveBeenCalled()

        await Session.remove(session.id)
      },
    })
  })

  test("prompt route returns provider error status and body when assistant message has error", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const prompt = spyOn(SessionPrompt, "prompt").mockResolvedValue(
          assistantErrorMessage(
            session.id,
            new MessageV2.APIError({
              message: "Rate limit exceeded. Please try again later.",
              statusCode: 429,
              isRetryable: true,
              responseBody:
                '{"type":"error","error":{"type":"FreeUsageLimitError","message":"Rate limit exceeded. Please try again later."}}',
            }).toObject(),
          ),
        )
        const app = Server.Default().app

        const res = await app.request(`/session/${session.id}/message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(promptBody()),
        })

        expect(res.status).toBe(429)
        expect(prompt).toHaveBeenCalledTimes(1)
        expect(await res.json()).toEqual(
          expect.objectContaining({
            name: "APIError",
            data: expect.objectContaining({
              message: "Rate limit exceeded. Please try again later.",
              statusCode: 429,
              isRetryable: true,
            }),
          }),
        )

        await Session.remove(session.id)
      },
    })
  })

  test("prompt_async route executes detached prompt once", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const prompt = spyOn(SessionPrompt, "prompt").mockResolvedValue(
          assistantErrorMessage(
            session.id,
            new MessageV2.APIError({
              message: "Rate limit exceeded. Please try again later.",
              statusCode: 429,
              isRetryable: true,
            }).toObject(),
          ),
        )
        const app = Server.Default().app

        const res = await app.request(`/session/${session.id}/prompt_async`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(promptBody()),
        })

        expect(res.status).toBe(204)
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(prompt).toHaveBeenCalledTimes(1)

        await Session.remove(session.id)
      },
    })
  })
})
