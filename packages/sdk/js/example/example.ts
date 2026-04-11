import { createOpencodeClient } from "@opencode-ai/sdk"
//import { pathToFileURL } from "bun"

//const server = await createOpencodeServer()
const client = createOpencodeClient({ baseUrl: "http://localhost:8888" })

const input = ["example.ts"]

console.log("Processing files:", input)
await Promise.all(
  input.map(async (file) => {
    console.log("here")
    const session = await client.session.create()
    console.log("processing", file)
    await client.session.prompt({
      path: { id: session.data?.id || "" },
      body: {
        parts: [
          {
            type: "text",
            text: `Write tests for every public function in this file.`,
          },
        ],
      },
    })
    console.log("done", file)
  }),
)
